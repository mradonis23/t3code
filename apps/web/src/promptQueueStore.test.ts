import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import {
  isPromptQueuePaused,
  pausePromptQueueEntries,
  prioritizePromptQueueEntry,
  reorderPromptQueueEntries,
  resolvePromptQueueCreationDispatchAction,
  resolvePromptQueueDeliveryMode,
  resolvePromptQueueDispatchAction,
  resumePromptQueueEntries,
  type PromptQueueEntry,
} from "./promptQueueStore";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const baseTime = "2026-09-14T12:00:00.000Z";

function entry(id: string, createdAt: string = baseTime): PromptQueueEntry {
  return {
    id,
    environmentId,
    threadId,
    messageId: MessageId.make(`message-${id}`),
    commandId: CommandId.make(`command-${id}`),
    text: `prompt ${id}`,
    images: [],
    files: [],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    deliveryMode: "after-success",
    createdAt,
  };
}

function creationEntry(id: string): PromptQueueEntry {
  return {
    ...entry(id),
    creation: {
      projectId: ProjectId.make("project-1"),
      title: "Queued first message",
      threadCreatedAt: "2026-09-14T11:59:00.000Z",
      branch: null,
      worktreePath: null,
      prepareWorktree: {
        projectCwd: "F:\\repo",
        baseBranch: "main",
        branch: "t3code/queued-123",
        startFromOrigin: true,
      },
    },
  };
}

describe("prompt queue delivery", () => {
  it("sends immediately only when connected and idle", () => {
    expect(
      resolvePromptQueueDeliveryMode({ intent: "default", connected: true, threadBusy: false }),
    ).toBe("immediate");
    expect(
      resolvePromptQueueDeliveryMode({ intent: "default", connected: true, threadBusy: true }),
    ).toBe("after-success");
    expect(
      resolvePromptQueueDeliveryMode({ intent: "default", connected: false, threadBusy: false }),
    ).toBe("after-success");
    expect(
      resolvePromptQueueDeliveryMode({ intent: "steer", connected: true, threadBusy: true }),
    ).toBe("steer");
  });
  it("waits for synchronized shell truth before creating a queued first thread", () => {
    const queued = creationEntry("create");
    expect(
      resolvePromptQueueCreationDispatchAction({
        entry: queued,
        connected: true,
        shellBootstrapped: false,
        threadExists: false,
      }),
    ).toBe("wait");
    expect(
      resolvePromptQueueCreationDispatchAction({
        entry: queued,
        connected: true,
        shellBootstrapped: true,
        threadExists: false,
      }),
    ).toBe("send");
  });

  it("removes a queued creation instead of duplicating a thread already projected after reload", () => {
    expect(
      resolvePromptQueueCreationDispatchAction({
        entry: creationEntry("already-created"),
        connected: true,
        shellBootstrapped: true,
        threadExists: true,
      }),
    ).toBe("remove");
  });

  it("never creates a paused first-thread entry", () => {
    expect(
      resolvePromptQueueCreationDispatchAction({
        entry: { ...creationEntry("paused-create"), deliveryMode: "paused" },
        connected: true,
        shellBootstrapped: true,
        threadExists: false,
      }),
    ).toBe("wait");
  });

  it("waits for a successful completion newer than an after-success entry", () => {
    const queued = entry("later");
    expect(
      resolvePromptQueueDispatchAction({
        entry: queued,
        connected: true,
        threadBusy: false,
        latestTurnState: "completed",
        latestTurnCompletedAt: "2026-09-14T11:59:59.000Z",
      }),
    ).toBe("wait");
    expect(
      resolvePromptQueueDispatchAction({
        entry: queued,
        connected: true,
        threadBusy: false,
        latestTurnState: "completed",
        latestTurnCompletedAt: "2026-09-14T12:00:01.000Z",
      }),
    ).toBe("send");
  });

  it("never auto-sends paused entries or entries with images still saving", () => {
    expect(
      resolvePromptQueueDispatchAction({
        entry: { ...entry("paused"), deliveryMode: "paused" },
        connected: true,
        threadBusy: false,
        latestTurnState: "completed",
        latestTurnCompletedAt: "2026-09-14T12:01:00.000Z",
      }),
    ).toBe("wait");
    expect(
      resolvePromptQueueDispatchAction({
        entry: { ...entry("saving"), pendingImageCount: 1, deliveryMode: "immediate" },
        connected: true,
        threadBusy: false,
        latestTurnState: "completed",
        latestTurnCompletedAt: "2026-09-14T12:01:00.000Z",
      }),
    ).toBe("wait");
  });

  it("allows explicit steer while busy but never while disconnected", () => {
    const steer = { ...entry("steer"), deliveryMode: "steer" as const };
    expect(
      resolvePromptQueueDispatchAction({
        entry: steer,
        connected: true,
        threadBusy: true,
        latestTurnState: "running",
        latestTurnCompletedAt: null,
      }),
    ).toBe("send");
    expect(
      resolvePromptQueueDispatchAction({
        entry: steer,
        connected: false,
        threadBusy: true,
        latestTurnState: "running",
        latestTurnCompletedAt: null,
      }),
    ).toBe("wait");
  });
});
describe("prompt queue management", () => {
  const first = entry("first", "2026-09-14T12:00:00.000Z");
  const second = entry("second", "2026-09-14T12:00:01.000Z");
  const third = entry("third", "2026-09-14T12:00:02.000Z");

  it("reorders entries while preserving queue time slots", () => {
    const result = reorderPromptQueueEntries([first, second, third], "second", -1);
    expect(result.map((candidate) => candidate.id)).toEqual(["second", "first", "third"]);
    expect(result.map((candidate) => candidate.createdAt)).toEqual([
      first.createdAt,
      second.createdAt,
      third.createdAt,
    ]);
  });

  it("prioritizes an entry and marks its explicit delivery intent", () => {
    const result = prioritizePromptQueueEntry([first, second, third], "third", "steer");
    expect(result.map((candidate) => candidate.id)).toEqual(["third", "first", "second"]);
    expect(result[0]?.deliveryMode).toBe("steer");
    expect(result.map((candidate) => candidate.createdAt)).toEqual([
      first.createdAt,
      second.createdAt,
      third.createdAt,
    ]);
  });
  it("pauses and safely resumes the queue", () => {
    const paused = pausePromptQueueEntries([first, second]);
    expect(isPromptQueuePaused(paused)).toBe(true);
    expect(paused.map((candidate) => candidate.deliveryMode)).toEqual(["paused", "paused"]);

    const idleResume = resumePromptQueueEntries(paused, true);
    expect(idleResume.map((candidate) => candidate.deliveryMode)).toEqual([
      "immediate",
      "after-success",
    ]);

    const busyResume = resumePromptQueueEntries(paused, false);
    expect(busyResume.map((candidate) => candidate.deliveryMode)).toEqual([
      "after-success",
      "after-success",
    ]);
  });
});
