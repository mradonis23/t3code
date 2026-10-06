import { AntigravitySettings, ProviderDriverKind, ProviderSetupError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { AcpError } from "effect-acp/errors";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  isAntigravityTextGenerationAvailable,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";
import { makeAntigravityAuth, type AntigravityAuth } from "../AntigravityAuth.ts";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";
import {
  antigravityAuthConfigIssue,
  antigravityAuthLabel,
  antigravityAuthUsesBrowser,
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  isOwnedWindowsAntigravityScratchDirectory,
  prepareAntigravityProfile,
  resolveAntigravityProfileDirectory,
  resolveWindowsAntigravityScratchDirectory,
  type AntigravityAuthConfig,
} from "../antigravityAuthSupport.ts";
import {
  antigravityScratchBlockReason,
  inspectWindowsAntigravityScratchPressure,
} from "../antigravityScratchGuard.ts";
import {
  makeAntigravityAcpRuntime,
  type AntigravityAcpRuntimeInput,
} from "../acp/AntigravityAcpSupport.ts";
import type { AcpSessionRuntime, AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { removeAntigravitySessionFiles } from "../acp/AntigravitySessionFiles.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeAntigravityAdapter } from "../Layers/AntigravityAdapter.ts";
import { makeAntigravityProvider } from "../Layers/AntigravityProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { discoverAntigravitySkills, resolveAntigravityUserHome } from "./AntigravitySkills.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);
const ANTIGRAVITY_PROCESS_KILL_FORCE_AFTER = "10 seconds";
const ANTIGRAVITY_SCRATCH_CLEANUP_RETRY_DELAYS = ["250 millis", "1 second", "3 seconds"] as const;

export type AntigravityDriverEnv =
  | AntigravityInstallation
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/** Each instance owns its Google profile. Executable releases are shared by the environment. */
export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const installation = yield* AntigravityInstallation;
      const loggers = yield* ProviderEventLoggers;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const settings = { ...config, enabled } satisfies AntigravitySettings;
      const auth: AntigravityAuthConfig = {
        authMethod: settings.authMethod,
        apiKey: settings.apiKey,
        gcpProject: settings.gcpProject,
        gcpLocation: settings.gcpLocation,
      };
      const authConfigIssue = antigravityAuthConfigIssue(auth);
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const hostPlatform = yield* HostProcessPlatform;
      const userHome = resolveAntigravityUserHome(hostPlatform, processEnvironment);
      const profileDirectory = resolveAntigravityProfileDirectory(
        serverConfig.stateDir,
        instanceId,
      );
      const cleanupLaunchScratch = Effect.fn("AntigravityDriver.cleanupLaunchScratch")(function* (
        scratchDirectory: string,
      ) {
        if (!isOwnedWindowsAntigravityScratchDirectory(scratchDirectory)) {
          yield* Effect.logWarning("Antigravity refused to clean an unowned scratch directory.", {
            scratchDirectory,
          });
          return;
        }
        const exists = () =>
          fileSystem.exists(scratchDirectory).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Antigravity could not inspect launch scratch during cleanup.", {
                scratchDirectory,
                cause,
              }).pipe(Effect.as(true)),
            ),
          );
        for (
          let attempt = 0;
          attempt <= ANTIGRAVITY_SCRATCH_CLEANUP_RETRY_DELAYS.length;
          attempt++
        ) {
          if (!(yield* exists())) return;
          yield* fileSystem.remove(scratchDirectory, { recursive: true, force: true }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Antigravity launch scratch cleanup attempt failed.", {
                scratchDirectory,
                attempt,
                cause,
              }),
            ),
          );
          if (!(yield* exists())) return;
          const delay = ANTIGRAVITY_SCRATCH_CLEANUP_RETRY_DELAYS[attempt];
          if (delay !== undefined) yield* Effect.sleep(delay);
        }
        yield* Effect.logWarning("Antigravity launch scratch remained after bounded cleanup.", {
          scratchDirectory,
        });
      });
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      // Google returns every model the account can use, including older
      // Gemini generations. The manifest names the current ones so the picker
      // folds the rest under its legacy section, as it does for Codex.
      const classifyModels = (draft: ServerProviderDraft) =>
        modelManifest.current.pipe(
          Effect.map((manifest) =>
            stampIdentity(ModelManifest.applyModelManifest(draft, manifest, DRIVER)),
          ),
        );

      const makeRuntime = Effect.fn("AntigravityDriver.makeRuntime")(function* (
        input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
      ): Effect.fn.Return<
        AcpSessionRuntime["Service"],
        AcpError | ProviderSetupError,
        Scope.Scope
      > {
        if (authConfigIssue !== null) {
          return yield* new ProviderSetupError({
            instanceId,
            operation: "configure",
            detail: authConfigIssue,
          });
        }
        const executable = yield* installation
          .acquire(settings.binaryPath, processEnvironment)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSetupError({
                  instanceId,
                  operation: "resolve",
                  detail: cause.detail,
                }),
            ),
          );
        const profile = yield* prepareAntigravityProfile({
          profileDirectory,
          baseEnv: processEnvironment,
          auth,
          userHome,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        if (hostPlatform === "win32") {
          const pressure = yield* Effect.tryPromise(() =>
            inspectWindowsAntigravityScratchPressure(),
          ).pipe(
            Effect.timeout("3 seconds"),
            Effect.mapError(
              (cause) =>
                new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail:
                    "Could not verify Antigravity runtime-scratch capacity. T3 blocked the launch to protect disk space.",
                  cause,
                }),
            ),
          );
          const blockReason = antigravityScratchBlockReason(pressure);
          if (blockReason !== null) {
            return yield* new ProviderSetupError({
              instanceId,
              operation: "start",
              detail: `Antigravity launch blocked to protect disk space: ${blockReason}. Open Settings > Diagnostics before retrying.`,
            });
          }
        }
        const scratchDirectory =
          hostPlatform === "win32"
            ? resolveWindowsAntigravityScratchDirectory(
                yield* crypto.randomUUIDv4.pipe(
                  Effect.mapError(
                    () =>
                      new ProviderSetupError({
                        instanceId,
                        operation: "start",
                        detail: "Could not allocate an Antigravity launch scratch identifier.",
                      }),
                  ),
                ),
              )
            : undefined;
        if (scratchDirectory !== undefined) {
          yield* Effect.addFinalizer(() => cleanupLaunchScratch(scratchDirectory));
          yield* fileSystem.makeDirectory(scratchDirectory, { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail: "Could not create the Antigravity launch scratch directory.",
                }),
            ),
          );
        }
        const runtime = yield* makeAntigravityAcpRuntime({
          ...input,
          processKillForceAfter: ANTIGRAVITY_PROCESS_KILL_FORCE_AFTER,
          authMethod: auth.authMethod,
          childProcessSpawner: spawner,
          spawn: buildAntigravityAcpSpawnInput({
            installation: executable,
            profile,
            cwd: input.cwd,
            baseEnv: processEnvironment,
            auth,
            ...(scratchDirectory === undefined ? {} : { scratchDirectory }),
          }),
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));
        return {
          ...runtime,
          start: () =>
            runtime
              .start()
              .pipe(
                Effect.tapError((cause): Effect.Effect<void> =>
                  input.onAuthorizationUrl === undefined && isAntigravitySignInRequiredError(cause)
                    ? provider.onAuthRequired
                    : Effect.void,
                ),
              ),
        };
      });

      const makeDisposableRuntime = Effect.fn("AntigravityDriver.makeDisposableRuntime")(function* (
        input: Pick<AntigravityAcpRuntimeInput, "onAuthorizationUrl">,
      ) {
        const cwd = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3-antigravity-setup-" })
          .pipe(
            Effect.mapError(
              () =>
                new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail: "Could not create an Antigravity setup workspace.",
                }),
            ),
          );
        let sessionId: string | undefined;
        yield* Effect.addFinalizer(() =>
          removeAntigravitySessionFiles({
            profileDirectory,
            sessionId,
            cwd,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        );
        const runtime = yield* makeRuntime({
          cwd,
          clientInfo: { name: "t3-code-provider-setup", version: "0.0.0" },
          mcpServers: [],
          ...(input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {}),
        });
        return {
          ...runtime,
          start: () =>
            runtime.start().pipe(
              Effect.tap((started) =>
                Effect.sync(() => {
                  sessionId = started.sessionId;
                }),
              ),
            ),
        };
      });

      const publishCatalog = (
        started: AcpSessionRuntimeStartResult,
        runtime: Pick<AcpSessionRuntime["Service"], "getEvents" | "drainEvents">,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* provider.onSessionStarted(started);
          yield* Stream.runForEach(runtime.getEvents(), (event) => {
            if (event._tag === "EventStreamBarrier") {
              return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
            }
            if (event._tag === "ConfigOptionsUpdated") {
              return provider.onConfigOptionsUpdated(event.configOptions);
            }
            return event._tag === "AvailableCommandsUpdated"
              ? provider.onAvailableCommands(event.availableCommands)
              : Effect.void;
          }).pipe(Effect.forkScoped);
          yield* runtime.drainEvents;
        }).pipe(Effect.scoped);

      const authFlow: AntigravityAuth = yield* makeAntigravityAuth({
        instanceId,
        makeRuntime: makeDisposableRuntime,
        onAuthenticated: publishCatalog,
        onSignedOut: Effect.suspend(() => provider.onSignedOut),
        usesBrowser: antigravityAuthUsesBrowser(auth.authMethod),
      });

      // Kick the TTL-gated manifest refresh alongside the health check, as
      // Codex and Claude do. Without it an environment that only runs
      // Antigravity would keep classifying against a stale disk cache.
      const probe = Effect.gen(function* () {
        yield* modelManifest.refreshInBackground;
        const processScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
        return yield* authFlow
          .withProcess(
            Scope.close(processScope, Exit.void),
            Effect.gen(function* () {
              const runtime = yield* makeRuntime({
                cwd: serverConfig.stateDir,
                clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
                mcpServers: [],
              });
              return yield* runtime.initialize();
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, processScope));
      }).pipe(Effect.scoped);

      const provider = yield* makeAntigravityProvider(settings, {
        stampIdentity: classifyModels,
        probe,
        auth: { type: auth.authMethod, label: antigravityAuthLabel(auth.authMethod) },
        supportsTextGeneration: isAntigravityTextGenerationAvailable(profileDirectory).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.orElseSucceed(() => false),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Could not prepare the Antigravity provider status.",
              cause,
            }),
        ),
      );
      const defaultModel = modelManifest.current.pipe(
        Effect.map((manifest) => ModelManifest.manifestDefaultModel(manifest, DRIVER)),
      );
      const adapter = yield* makeAntigravityAdapter(settings, {
        instanceId,
        makeRuntime,
        withProcess: authFlow.withProcess,
        defaultModel,
        onSessionStarted: provider.onSessionStarted,
        onConfigOptionsUpdated: provider.onConfigOptionsUpdated,
        onAvailableCommands: provider.onAvailableCommands,
        onAuthRequired: provider.onAuthRequired,
        ...(loggers.native ? { nativeEventLogger: loggers.native } : {}),
      });
      const textGeneration = yield* makeAntigravityTextGeneration({
        profileDirectory,
        defaultModel,
        withProcess: authFlow.withProcess,
        makeRuntime: (cwd) =>
          makeRuntime({
            cwd,
            clientInfo: { name: "t3-code-text", version: "0.0.0" },
            mcpServers: [],
          }),
      });

      const refreshModels = Effect.fn("AntigravityDriver.refreshModels")(
        function* () {
          const processScope = yield* Scope.make();
          yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
          yield* authFlow
            .withProcess(
              Scope.close(processScope, Exit.void),
              Effect.gen(function* () {
                const runtime = yield* makeDisposableRuntime({});
                const started = yield* runtime.start();
                yield* publishCatalog(started, runtime);
              }),
            )
            .pipe(Effect.provideService(Scope.Scope, processScope));
        },
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: "90 seconds",
          orElse: () =>
            Effect.fail(
              new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: "Antigravity model refresh timed out. Try again or check Google sign-in.",
              }),
            ),
        }),
        Effect.tapError((cause) =>
          isAntigravitySignInRequiredError(cause) ? provider.onAuthRequired : Effect.void,
        ),
        Effect.mapError((cause) =>
          cause._tag === "ProviderDriverError"
            ? cause
            : new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: isAntigravitySignInRequiredError(cause)
                  ? "Sign in to Antigravity in provider settings before refreshing models."
                  : cause._tag === "ProviderSetupError" && cause.operation === "configure"
                    ? cause.detail
                    : "Could not refresh Antigravity models. The previous model list is unchanged.",
                cause,
              }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: provider.snapshot,
        snapshotForCwd: (cwd) =>
          !enabled
            ? provider.snapshot.getSnapshot
            : discoverAntigravitySkills({ cwd, userHome }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.flatMap((skills) => provider.snapshotForCwd(cwd, skills)),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER,
                      instanceId,
                      detail: "Could not read Antigravity workspace skills.",
                      cause,
                    }),
                ),
              ),
        adapter,
        textGeneration,
        auth: authFlow.controller,
        refreshModels,
      } satisfies ProviderInstance;
    }),
};
