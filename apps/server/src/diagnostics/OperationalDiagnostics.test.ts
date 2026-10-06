import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  ServerOperationalDiagnosticsResult,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { SessionStore, ActiveSessionsListError } from "../auth/SessionStore.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryPersistenceError } from "../provider/Errors.ts";
import {
  lastNativeSynchronizationFromPayload,
  make,
  nativeSessionIdFromCursor,
} from "./OperationalDiagnostics.ts";

const encodeReport = Schema.encodeEffect(Schema.fromJsonString(ServerOperationalDiagnosticsResult));

it.layer(NodeServices.layer)("OperationalDiagnostics", (it) => {
  it.effect(
    "samples isolated storage, known clients and bindings without exposing runtime secrets",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const scratch = path.join(config.baseDir, "runtime-scratch");
        yield* fs.makeDirectory(path.join(scratch, "_MEI-test"), { recursive: true });
        yield* fs.writeFileString(path.join(scratch, "_MEI-test", "sample.bin"), "sample");
        yield* fs.writeFileString(config.dbPath, "database metadata fixture");
        const backups = path.join(config.baseDir, "backups");
        yield* fs.makeDirectory(backups);
        yield* fs.writeFileString(path.join(backups, "backup.sqlite"), "backup");
        yield* fs.writeFileString(path.join(backups, "unrelated.txt"), "not a backup");
        const now = yield* DateTime.now;
        const synchronizedAtMs = 1_790_000_000_000;
        const diagnostics = yield* make().pipe(
          Effect.provideService(HostProcessEnvironment, { T3CODE_RUNTIME_SCRATCH_DIR: scratch }),
          Effect.provide([
            Layer.mock(SessionStore)({
              cookieName: "test",
              legacyCookieName: undefined,
              listActive: () =>
                Effect.succeed([
                  {
                    sessionId: AuthSessionId.make("client"),
                    subject: "owner",
                    scopes: [],
                    method: "bearer-access-token",
                    client: { label: "Fold", deviceType: "mobile" },
                    issuedAt: now,
                    expiresAt: now,
                    lastConnectedAt: now,
                    connected: true,
                    current: false,
                  },
                ]),
            }),
            Layer.mock(ProviderSessionDirectory)({
              listBindings: () =>
                Effect.succeed([
                  {
                    threadId: ThreadId.make("thread"),
                    provider: ProviderDriverKind.make("claudeAgent"),
                    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                    status: "stopped",
                    resumeCursor: {
                      threadId: "t3-id",
                      resume: "native-uuid",
                      secret: "never-export-this",
                    },
                    runtimePayload: {
                      token: "never-export-this",
                      importedTranscripts: [
                        { providerSessionId: "native-uuid", mtimeMs: synchronizedAtMs },
                        {
                          providerSessionId: "another-native-session",
                          mtimeMs: synchronizedAtMs + 1_000,
                        },
                      ],
                    },
                    lastSeenAt: DateTime.formatIso(now),
                  },
                ]),
            }),
          ]),
        );
        const result = yield* diagnostics.read;
        expect(result.database.queryStatus).toBe("ok");
        expect(result.disk.freeBytes).toBeGreaterThan(0);
        expect(result.runtimeScratch).toMatchObject({
          status: "ok",
          meiDirectoryCount: 1,
          sampledBytes: 6,
          scanTruncated: false,
        });
        expect(result.backup.latestPath).toBe(path.join(backups, "backup.sqlite"));
        expect(result.clients).toMatchObject([
          { deviceType: "mobile", connected: true, surface: null },
        ]);
        expect(result.nativeSessions).toMatchObject([
          {
            nativeSessionId: "native-uuid",
            resumable: true,
            lastSynchronizedAt: DateTime.formatIso(DateTime.makeUnsafe(synchronizedAtMs)),
          },
        ]);
        const encoded = yield* encodeReport(result);
        expect(encoded).not.toContain("never-export-this");
      }).pipe(
        Effect.provide([
          SqlitePersistenceMemory,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-operational-test-" }),
        ]),
      ),
  );

  it.effect("reports absent scratch and failed state reads as unavailable", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const diagnostics = yield* make().pipe(
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_RUNTIME_SCRATCH_DIR: `${config.baseDir}/missing`,
        }),
        Effect.provide([
          Layer.mock(SessionStore)({
            cookieName: "test",
            legacyCookieName: undefined,
            listActive: () => Effect.fail(new ActiveSessionsListError({ cause: "unavailable" })),
          }),
          Layer.mock(ProviderSessionDirectory)({
            listBindings: () =>
              Effect.fail(
                new ProviderSessionDirectoryPersistenceError({
                  operation: "list",
                  detail: "Unavailable",
                }),
              ),
          }),
        ]),
      );
      const result = yield* diagnostics.read;
      expect(result.runtimeScratch.status).toBe("unavailable");
      expect(result.database.status).toBe("unavailable");
      expect(result.clients).toBeNull();
      expect(result.nativeSessionsAvailable).toBe(false);
      expect(result.backup).toEqual({
        directory: null,
        latestPath: null,
        latestModifiedAt: null,
        scanTruncated: false,
      });
    }).pipe(
      Effect.provide([
        SqlitePersistenceMemory,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-operational-unavailable-" }),
      ]),
    ),
  );
});

it("does not confuse T3's Claude thread id or unknown provider cursors with native ids", () => {
  expect(nativeSessionIdFromCursor("claudeAgent", { threadId: "t3-thread" })).toBeNull();
  expect(
    nativeSessionIdFromCursor("custom-provider", { threadId: "t3-thread", token: "secret" }),
  ).toBeNull();
  expect(nativeSessionIdFromCursor("codex", { threadId: "native-uuid" })).toBe("native-uuid");
});

it("derives native synchronization time only from the bound native session", () => {
  expect(
    lastNativeSynchronizationFromPayload(
      {
        importedTranscripts: [
          { providerSessionId: "native-uuid", mtimeMs: 1_790_000_000_000 },
          { providerSessionId: "native-uuid", mtimeMs: 1_790_000_010_000 },
          { providerSessionId: "another-native-session", mtimeMs: 1_800_000_000_000 },
          { providerSessionId: "native-uuid", mtimeMs: null },
        ],
      },
      "native-uuid",
    ),
  ).toBe(DateTime.formatIso(DateTime.makeUnsafe(1_790_000_010_000)));
  expect(
    lastNativeSynchronizationFromPayload({ importedTranscripts: [] }, "native-uuid"),
  ).toBeNull();
  expect(lastNativeSynchronizationFromPayload({ importedTranscripts: [] }, null)).toBeNull();
});
