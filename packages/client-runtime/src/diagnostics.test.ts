import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import {
  diagnosticsProviderLabel,
  diagnosticsTextSummary,
  operationalReportCards,
  summarizeWork,
  workCount,
} from "./diagnostics.ts";

const ENV = EnvironmentId.make("environment");
const NOW = "2026-10-06T12:00:00.000Z";
const makeThread = (
  id: string,
  patch: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project"),
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex_mom"), model: "default" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...patch,
});
const session = (status: "running" | "error", lastError: string | null = null) => ({
  threadId: ThreadId.make("thread"),
  status,
  providerName: "codex",
  activeTurnId: null,
  runtimeMode: "full-access" as const,
  lastError,
  updatedAt: NOW,
});
const completed = (at: string) => ({
  turnId: TurnId.make("turn"),
  state: "completed" as const,
  requestedAt: at,
  startedAt: at,
  completedAt: at,
  assistantMessageId: null,
});

describe("global work summary", () => {
  it("counts authoritative states and local queue messages without inventing paused or queued threads", () => {
    const threads = [
      makeThread("running", { session: session("running") }),
      makeThread("input", { session: session("running"), hasPendingApprovals: true }),
      makeThread("limited", { session: session("error", "Usage limit reached") }),
      makeThread("failed", { session: session("error", "Process failed") }),
      makeThread("recent", { latestTurn: completed("2026-10-06T11:00:00.000Z") }),
      makeThread("old", { latestTurn: completed("2026-10-03T11:00:00.000Z") }),
      makeThread("future", { latestTurn: completed("2026-10-07T11:00:00.000Z") }),
      makeThread("idle", { latestUserMessageAt: NOW }),
      makeThread("archived", { session: session("running"), archivedAt: NOW }),
    ];
    const work = summarizeWork({
      environmentId: ENV,
      threads: [...threads, threads[0]!],
      now: NOW,
      queue: [
        { environmentId: ENV, threadId: ThreadId.make("running"), deliveryMode: "after-success" },
        { environmentId: ENV, threadId: ThreadId.make("running"), deliveryMode: "after-success" },
        { environmentId: ENV, threadId: ThreadId.make("pending"), deliveryMode: "paused" },
        {
          environmentId: EnvironmentId.make("other"),
          threadId: ThreadId.make("other"),
          deliveryMode: "paused",
        },
      ],
    });
    expect(
      Object.fromEntries(Object.entries(work).map(([key, value]) => [key, workCount(value)])),
    ).toEqual({
      Running: 1,
      Queued: 2,
      Paused: 1,
      "Needs Input": 1,
      "Usage Limited": 1,
      Failed: 1,
      "Completed recently": 1,
    });
    expect(work.Queued).toMatchObject([{ threadId: "running", count: 2, navigable: true }]);
    expect(work.Paused).toMatchObject([{ threadId: "pending", navigable: false }]);
  });

  it("makes unavailable checks and peer-sync limits explicit in the copyable report", () => {
    const cards = operationalReportCards({
      data: null,
      config: null,
      connection: "offline",
      sync: "cached",
      syncSequence: 10,
      error: "Connection closed",
    });
    const work = summarizeWork({ environmentId: ENV, threads: [], queue: [], now: NOW });
    const text = diagnosticsTextSummary({
      cards,
      data: null,
      config: null,
      work,
      recentErrors: ["Unavailable"],
    });
    expect(text).toContain("Backend: offline");
    expect(text).toContain("Connection closed");
    expect(text).toContain("NSSM state is unavailable");
    expect(text).toContain("peer sync progress is unavailable");
    expect(text).toContain("queued/paused messages on this client");
    expect(text).toContain("Native sessions (last known bindings):\nUnavailable");
  });

  it("keeps the accepted Codex account labels", () => {
    expect(
      ["codex", "codex_mom", "codex_nena"].map((instanceId) =>
        diagnosticsProviderLabel({ driver: "codex", instanceId }),
      ),
    ).toEqual(["Dad's Codex", "Mom's Codex", "Nena's Codex"]);
  });
});
