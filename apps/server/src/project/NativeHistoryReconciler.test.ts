import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { AgentSessionScanner, type AgentSessionRecentThread } from "./AgentSessionScanner.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { makeReconcile, layer as workerLayer } from "./NativeHistoryReconciler.ts";

const NOW = "2026-10-06T10:00:00.000Z";
const PROJECT = ProjectId.make("project");
const INSTANCE = ProviderInstanceId.make("codex_mom");
const THREAD = ThreadId.make("import:codex_mom:native-uuid");
const SOURCE = {
  provider: "codex" as const,
  providerInstanceId: INSTANCE,
  providerSessionId: "native-uuid",
  filePath: "/recorded/native.jsonl",
  size: 100,
  mtimeMs: 1,
  device: 0,
  inode: 0,
  birthtimeMs: 0,
};

function harness(status: ProviderRuntimeBindingWithMetadata["status"] = "stopped") {
  let binding: ProviderRuntimeBindingWithMetadata = {
    threadId: THREAD,
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: INSTANCE,
    status,
    resumeCursor: { threadId: "native-uuid" },
    lastSeenAt: NOW,
  };
  let thread: OrchestrationThread = {
    id: THREAD,
    projectId: PROJECT,
    title: "Native Mom conversation",
    modelSelection: { instanceId: INSTANCE, model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    settledOverride: "settled",
    settledAt: NOW,
    messages: [
      {
        id: MessageId.make(`${THREAD}:000000`),
        role: "user",
        text: "Original",
        turnId: TurnId.make("turn-a"),
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    activities: [],
    checkpoints: [],
    proposedPlans: [],
    session: null,
  };
  const outcome: AgentSessionRecentThread = {
    _tag: "Importable",
    source: SOURCE,
    thread: {
      source: "codex",
      providerInstanceId: INSTANCE,
      providerSessionId: "native-uuid",
      title: "Native",
      model: null,
      createdAt: NOW,
      updatedAt: NOW,
      messages: [
        { role: "user", text: "Original", providerTurnId: "turn-a", createdAt: NOW },
        { role: "assistant", text: "Native tail", providerTurnId: "turn-a", createdAt: NOW },
      ],
    },
  };
  const scan = vi.fn(() => Stream.succeed(outcome));
  const append = vi.fn();
  const project = {
    id: PROJECT,
    title: "Project",
    workspaceRoot: "/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const asShell = (): OrchestrationThreadShell => ({
    ...thread,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });
  const layer = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.succeed({
          projects: [project],
          threads: [asShell(), asShell()],
          snapshotSequence: 0,
          updatedAt: NOW,
        }),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
      getImportedAgentSessionSources: () => Effect.succeed([{ threadId: THREAD, source: SOURCE }]),
      getThreadDetailById: () => Effect.succeed(Option.some(thread)),
    }),
    Layer.mock(ProviderSessionDirectory)({
      listBindings: () => Effect.succeed([binding, binding]),
      getBinding: () => Effect.succeed(Option.some(binding)),
      upsert: () => Effect.die("must never replace native binding"),
      recordImportedTranscript: () => Effect.void,
    }),
    Layer.mock(AgentSessionScanner)({ recentThreads: scan }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type !== "thread.history.append")
            throw new Error("Reconciliation must only append");
          append(command);
          thread = {
            ...thread,
            messages: [
              ...thread.messages,
              ...command.messages.map((message) => ({
                id: message.messageId,
                role: message.role,
                text: message.text,
                turnId: message.turnId,
                streaming: false,
                createdAt: message.createdAt,
                updatedAt: message.createdAt,
              })),
            ],
          };
          return { sequence: 1 };
        }),
    }),
  );
  return {
    layer,
    scan,
    append,
    binding: () => binding,
    thread: () => thread,
    replaceBinding: () => {
      binding = { ...binding, resumeCursor: { threadId: "different-native-uuid" } };
    },
    activateDuringScan: () => {
      scan.mockImplementationOnce(() => {
        binding = { ...binding, status: "starting" };
        return Stream.succeed(outcome);
      });
    },
  };
}

it.layer(NodeServices.layer)("NativeHistoryReconciler", (it) => {
  it.effect(
    "appends a stopped bound tail once, deduplicating threads and preserving account/UUID",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const reconcile = yield* makeReconcile();
        yield* reconcile;
        yield* reconcile;
        expect(h.append).toHaveBeenCalledTimes(1);
        expect(h.thread().messages.map((message) => message.text)).toEqual([
          "Original",
          "Native tail",
        ]);
        expect(h.binding()).toMatchObject({
          providerInstanceId: INSTANCE,
          resumeCursor: { threadId: "native-uuid" },
          status: "stopped",
        });
        expect(h.scan).toHaveBeenCalledWith("/project", [SOURCE], true);
      }).pipe(Effect.provide(h.layer));
    },
  );
  for (const status of ["running", "starting", "error"] as const) {
    it.effect(`never reads or appends a ${status} native session`, () => {
      const h = harness(status);
      return Effect.gen(function* () {
        const reconcile = yield* makeReconcile();
        yield* reconcile;
        expect(h.scan).not.toHaveBeenCalled();
        expect(h.append).not.toHaveBeenCalled();
      }).pipe(Effect.provide(h.layer));
    });
  }
  it.effect("does not follow a replacement native UUID", () => {
    const h = harness();
    h.replaceBinding();
    return Effect.gen(function* () {
      const reconcile = yield* makeReconcile();
      yield* reconcile;
      expect(h.scan).not.toHaveBeenCalled();
      expect(h.append).not.toHaveBeenCalled();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("rechecks a binding that starts while its transcript is being read", () => {
    const h = harness();
    h.activateDuringScan();
    return Effect.gen(function* () {
      const reconcile = yield* makeReconcile();
      yield* reconcile;
      expect(h.scan).toHaveBeenCalledTimes(1);
      expect(h.append).not.toHaveBeenCalled();
      expect(h.thread().messages).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "parks without blocking startup, waits a minute after readiness, and stops with its scope",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(workerLayer);
            yield* TestClock.adjust("120 seconds");
            expect(h.scan).not.toHaveBeenCalled();
            yield* Deferred.succeed(ready, undefined);
            yield* TestClock.adjust("59 seconds");
            expect(h.scan).not.toHaveBeenCalled();
            yield* TestClock.adjust("1 second");
            expect(h.append).toHaveBeenCalledTimes(1);
          }).pipe(
            Effect.provide(
              Layer.mock(ServerRuntimeStartup)({ awaitCommandReady: Deferred.await(ready) }),
            ),
          ),
        );
        yield* TestClock.adjust("120 seconds");
        expect(h.scan).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(h.layer));
    },
  );
});
