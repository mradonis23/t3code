import { describe, expect, it } from "vite-plus/test";
import {
  CheckpointRef,
  MessageId,
  TurnId,
  type OrchestrationThread,
  type VcsStatusResult,
} from "@t3tools/contracts";

import {
  buildCheckpointContinuation,
  resolveCheckpointContinuationActionState,
  resolveCheckpointContinuationDeliveryMode,
} from "./checkpointContinuation.logic";

const now = "2026-09-09T12:00:00.000Z";

function thread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Ship mobile recovery",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/mobile",
    worktreePath: "/repo/worktree",
    latestTurn: {
      turnId: "turn-2",
      state: "error",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      {
        id: "user-2",
        role: "user",
        text: "Finish the Android production validation without rebuilding completed work.",
        turnId: "turn-2",
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: "thread-1",
      status: "error",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Tool process exited unexpectedly",
      updatedAt: now,
    },
    ...overrides,
  } as OrchestrationThread;
}

function gitStatus(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/mobile",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "apps/mobile/src/recovery.ts", insertions: 10, deletions: 1 }],
      insertions: 10,
      deletions: 1,
    },
    hasUpstream: true,
    aheadCount: 1,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function commandActivity(input: {
  id: string;
  command: string;
  kind?: "tool.started" | "tool.updated" | "tool.completed";
  status?: string | null;
  output?: string;
  tone?: "tool" | "error";
  turnId?: string;
}) {
  return {
    id: input.id,
    tone: input.tone ?? "tool",
    kind: input.kind ?? "tool.completed",
    summary: input.kind === "tool.started" ? "Command started" : "Ran command",
    payload: {
      itemType: "command_execution",
      ...(input.status !== null ? { status: input.status ?? "completed" } : {}),
      toolCallId: input.id,
      data: {
        command: input.command,
        ...(input.output ? { rawOutput: { content: input.output } } : {}),
      },
    },
    turnId: input.turnId ?? "turn-2",
    createdAt: now,
  } as OrchestrationThread["activities"][number];
}

describe("buildCheckpointContinuation", () => {
  it("uses the usage-limit reason without inventing completion or retrying", () => {
    const result = buildCheckpointContinuation({
      thread: thread({
        session: {
          ...thread().session!,
          lastError: "Usage limit reached. Try again after 4:00 PM.",
        },
      }),
      connectionState: "connected",
      gitStatus: null,
    });

    expect(result?.kind).toBe("usage-limit");
    expect(result?.prompt).toContain("Usage limit reached. Try again after 4:00 PM.");
    expect(result?.prompt).toContain("No ready Git checkpoint is recorded; do not infer one.");
    expect(result?.prompt).not.toContain("worktree clean");
    expect(
      resolveCheckpointContinuationActionState({
        continuationKind: result!.kind,
        connectionState: "connected",
        sessionStatus: "error",
        latestTurnState: "error",
      }),
    ).toMatchObject({ canContinueNow: false, primaryAction: "queue" });
  });

  it("retains confirmed checkpoint work, files, successful checks, Git evidence, and partial progress", () => {
    const result = buildCheckpointContinuation({
      thread: thread({
        messages: [
          ...thread().messages,
          {
            id: MessageId.make("assistant-1"),
            role: "assistant",
            text: "Implemented the recovery evidence reducer and its focused fixtures.",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: MessageId.make("assistant-2"),
            role: "assistant",
            text: "The release build is running; signer verification remains.",
            turnId: TurnId.make("turn-2"),
            streaming: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-1/turn/1"),
            status: "ready",
            files: [
              {
                path: "apps/mobile/src/recovery.ts",
                kind: "modified",
                additions: 10,
                deletions: 1,
              },
            ],
            assistantMessageId: MessageId.make("assistant-1"),
            completedAt: now,
          },
        ],
        activities: [
          commandActivity({
            id: "test",
            command: "vp test run recovery.test.ts",
            turnId: "turn-1",
          }),
          commandActivity({
            id: "head",
            command: "git rev-parse HEAD",
            output: "1234567890abcdef1234567890abcdef12345678",
          }),
          commandActivity({
            id: "build",
            command: "gradlew.bat assembleRelease",
          }),
          commandActivity({
            id: "install",
            command: "adb install -r app-release.apk",
            output: "Success",
          }),
          commandActivity({
            id: "commit",
            command: "git commit -m recovery",
            output: "[feature/mobile abc1234] recovery",
          }),
          commandActivity({
            id: "signer",
            command: "apksigner verify --print-certs app-release.apk",
            kind: "tool.started",
            status: "inProgress",
          }),
        ],
      }),
      connectionState: "connected",
      gitStatus: gitStatus(),
      projectTitle: "T3 Code",
    });

    expect(result?.prompt).toContain("Last reliable T3 checkpoint: turn 1");
    expect(result?.prompt).toContain("Implemented the recovery evidence reducer");
    expect(result?.prompt).toContain("Recorded successful checks");
    expect(result?.prompt).toContain("Recorded successful build");
    expect(result?.prompt).toContain("Recorded successful install");
    expect(result?.prompt).toContain("Commit created by a completed command: abc1234");
    expect(result?.prompt).toContain("1234567890abcdef1234567890abcdef12345678");
    expect(result?.prompt).toContain("worktree dirty");
    expect(result?.prompt).toContain("Last recorded assistant progress (partial");
    expect(result?.prompt).toContain("Ambiguous command at interruption: `apksigner verify");
    expect(result?.prompt).toContain("Inspect only the minimum Git/runtime evidence");
    expect(result?.prompt).toContain("Do not redo work already covered");
    expect(result!.prompt.length).toBeLessThan(4_000);
  });

  it("marks cancellation or unexpected termination as ambiguous", () => {
    const result = buildCheckpointContinuation({
      thread: thread({
        latestTurn: { ...thread().latestTurn!, state: "interrupted" },
        session: { ...thread().session!, status: "stopped", lastError: null },
      }),
      connectionState: "connected",
      gitStatus: null,
    });

    expect(result?.kind).toBe("cancellation-or-termination");
    expect(result?.prompt).toContain(
      "cancellation and unexpected termination are not distinguishable",
    );
    expect(result?.prompt).toContain("Do not assume the interrupted operation succeeded or failed");
    expect(result?.prompt).not.toContain("successfully completed");
  });

  it("marks a disconnect with an active turn as unknown and defaults busy continuation to queue", () => {
    const disconnected = thread({
      latestTurn: { ...thread().latestTurn!, state: "running", completedAt: null },
      session: {
        ...thread().session!,
        status: "running",
        activeTurnId: TurnId.make("turn-2"),
        lastError: null,
      },
    });
    const result = buildCheckpointContinuation({
      thread: disconnected,
      connectionState: "offline",
      gitStatus: null,
    });

    expect(result?.kind).toBe("disconnect");
    expect(result?.prompt).toContain("server-side outcome is unknown");
    expect(
      resolveCheckpointContinuationActionState({
        continuationKind: result!.kind,
        connectionState: "connected",
        sessionStatus: "running",
        latestTurnState: "running",
      }),
    ).toEqual({ canContinueNow: false, canSteer: true, primaryAction: "queue" });
  });

  it("includes clean/dirty state only when a Git status snapshot exists", () => {
    const unavailable = buildCheckpointContinuation({
      thread: thread(),
      connectionState: "connected",
      gitStatus: null,
    });
    const available = buildCheckpointContinuation({
      thread: thread(),
      connectionState: "connected",
      gitStatus: gitStatus({
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      }),
    });

    expect(unavailable?.prompt).toContain("current Git state is unavailable");
    expect(unavailable?.prompt).not.toContain("worktree clean");
    expect(available?.prompt).toContain("worktree clean");
  });

  it("does not promote an error-toned command into successful check evidence", () => {
    const result = buildCheckpointContinuation({
      thread: thread({
        activities: [
          commandActivity({
            id: "failed-test",
            command: "vp test run recovery.test.ts",
            status: null,
            tone: "error",
          }),
        ],
      }),
      connectionState: "connected",
      gitStatus: null,
    });

    expect(result?.prompt).not.toContain("Recorded successful checks");
    expect(result?.prompt).toContain("Last command recorded failed/interrupted");
  });

  it("does not offer recovery for a normally completed connected turn", () => {
    expect(
      buildCheckpointContinuation({
        thread: thread({
          latestTurn: { ...thread().latestTurn!, state: "completed" },
          session: { ...thread().session!, status: "ready", lastError: null },
        }),
        connectionState: "connected",
        gitStatus: gitStatus(),
      }),
    ).toBeNull();
  });

  it("allows a terminal runtime failure to continue now while keeping usage limits queued", () => {
    expect(
      resolveCheckpointContinuationActionState({
        continuationKind: "runtime-error",
        connectionState: "connected",
        sessionStatus: "error",
        latestTurnState: "error",
      }),
    ).toEqual({ canContinueNow: true, canSteer: false, primaryAction: "continue-now" });
  });

  it("does not steer a stale running turn after the provider session has failed", () => {
    expect(
      resolveCheckpointContinuationActionState({
        continuationKind: "runtime-error",
        connectionState: "connected",
        sessionStatus: "error",
        latestTurnState: "running",
      }),
    ).toEqual({ canContinueNow: true, canSteer: false, primaryAction: "continue-now" });
  });

  it("maps continuation actions onto the existing outbox modes without implicit steering", () => {
    expect(
      resolveCheckpointContinuationDeliveryMode({
        intent: "now",
        continuationKind: "runtime-error",
        threadBusy: false,
      }),
    ).toBe("immediate");
    expect(
      resolveCheckpointContinuationDeliveryMode({
        intent: "later",
        continuationKind: "runtime-error",
        threadBusy: true,
      }),
    ).toBe("after-success");
    expect(
      resolveCheckpointContinuationDeliveryMode({
        intent: "later",
        continuationKind: "usage-limit",
        threadBusy: false,
      }),
    ).toBe("paused");
    expect(
      resolveCheckpointContinuationDeliveryMode({
        intent: "later",
        continuationKind: "runtime-error",
        threadBusy: false,
      }),
    ).toBe("paused");
    expect(
      resolveCheckpointContinuationDeliveryMode({
        intent: "steer",
        continuationKind: "disconnect",
        threadBusy: true,
      }),
    ).toBe("steer");
  });
});
