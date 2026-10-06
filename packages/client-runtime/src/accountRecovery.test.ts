import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  accountSwitchBlocked,
  availableAccountRecovery,
  codexAccountSummaries,
  unavailableAccountRecoveryReason,
} from "./accountRecovery.ts";

const before = "2026-10-06T10:00:00.000Z";
const stopped = "2026-10-06T10:01:00.000Z";
function thread(): { -readonly [Key in keyof OrchestrationThread]: OrchestrationThread[Key] } {
  const id = ThreadId.make("thread");
  const turnId = TurnId.make("limited-turn");
  return {
    id,
    projectId: ProjectId.make("project"),
    title: "Task",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId,
      state: "error",
      requestedAt: before,
      startedAt: before,
      completedAt: stopped,
      assistantMessageId: null,
    },
    createdAt: before,
    updatedAt: stopped,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    messages: [],
    proposedPlans: [],
    checkpoints: [],
    activities: [
      {
        id: EventId.make("offer"),
        kind: "codex.account.failover.offered",
        tone: "info",
        summary: "Dad is at limit. Continue with Mom?",
        turnId,
        createdAt: stopped,
        payload: {
          fromProviderInstanceId: ProviderInstanceId.make("codex"),
          toProviderInstanceId: ProviderInstanceId.make("codex_mom"),
          sourceMessageId: null,
          reason: "Usage limit reached",
        },
      },
    ],
    session: {
      threadId: id,
      status: "error",
      providerName: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Usage limit reached",
      updatedAt: stopped,
    },
  };
}

describe("account recovery across clients", () => {
  it("offers a continuation without changing the sticky account", () => {
    const limited = thread();
    expect(availableAccountRecovery(limited)?.toProviderInstanceId).toBe("codex_mom");
    expect(limited.modelSelection.instanceId).toBe("codex");
  });

  it.each(["starting", "running"] as const)("fails closed while the account is %s", (status) => {
    const active = thread();
    active.session = { ...active.session!, status };
    expect(availableAccountRecovery(active)).toBeNull();
    expect(accountSwitchBlocked(active, "codex_mom")).toBe(true);
    expect(accountSwitchBlocked(active, "codex")).toBe(false);
  });

  it("expires an offer after new user work, acceptance, or a changed sticky account", () => {
    const sent = thread();
    sent.messages = [
      {
        id: MessageId.make("new-work"),
        role: "user",
        text: "New task",
        turnId: null,
        streaming: false,
        createdAt: stopped,
        updatedAt: stopped,
      },
    ];
    expect(availableAccountRecovery(sent)).toBeNull();
    const accepted = thread();
    accepted.activities = [
      ...accepted.activities,
      {
        ...accepted.activities[0]!,
        id: EventId.make("accepted"),
        kind: "codex.account.failover.accepted",
      },
    ];
    expect(availableAccountRecovery(accepted)).toBeNull();
    const changed = thread();
    changed.modelSelection = {
      ...changed.modelSelection,
      instanceId: ProviderInstanceId.make("codex_nena"),
    };
    expect(availableAccountRecovery(changed)).toBeNull();
  });

  it("rejects malformed offers and gives a truthful no-target reason", () => {
    const limited = thread();
    limited.activities = [
      { ...limited.activities[0]!, payload: { toProviderInstanceId: "codex_mom" } },
    ];
    expect(availableAccountRecovery(limited)).toBeNull();
    limited.activities = [
      {
        ...limited.activities[0]!,
        kind: "codex.account.failover.unavailable",
        payload: {
          providerInstanceId: ProviderInstanceId.make("codex"),
          sourceMessageId: null,
          reason: "Usage limit reached.",
          detail: "No alternate account reports usable capacity.",
        },
      },
    ];
    expect(unavailableAccountRecoveryReason(limited)).toContain(
      "No alternate account reports usable capacity",
    );
  });

  it("uses durable message identity when client and server clocks differ", () => {
    const limited = thread();
    const messageId = MessageId.make("original-request");
    limited.messages = [
      {
        id: messageId,
        role: "user",
        text: "Keep working",
        turnId: limited.latestTurn!.turnId,
        streaming: false,
        createdAt: "2026-10-06T11:00:00.000Z",
        updatedAt: "2026-10-06T11:00:00.000Z",
      },
    ];
    limited.activities = [
      {
        ...limited.activities[0]!,
        payload: {
          fromProviderInstanceId: ProviderInstanceId.make("codex"),
          toProviderInstanceId: ProviderInstanceId.make("codex_mom"),
          sourceMessageId: messageId,
          reason: "Usage limit reached",
        },
      },
    ];
    expect(availableAccountRecovery(limited)?.id).toBe("offer");
  });
});

function provider(id: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: before,
    availability: "available",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("persistent account summaries", () => {
  it("includes every configured account, including missing telemetry, without inventing quota", () => {
    const dad = {
      ...provider("codex"),
      usageLimits: {
        checkedAt: before,
        windows: [
          {
            id: "session",
            kind: "session" as const,
            label: "Session",
            usedPercent: 2,
            resetsAt: "2026-10-06T12:00:00.000Z",
          },
        ],
      },
    };
    const accounts = codexAccountSummaries(
      [dad, provider("codex_mom"), provider("codex_nena"), provider("codex_work")],
      Date.parse(before),
    );
    expect(accounts.map((account) => account.label)).toEqual([
      "Dad's Codex",
      "Mom's Codex",
      "Nena's Codex",
      "codex_work",
    ]);
    expect(accounts[0]?.summary).toBe("Session 98% left");
    expect(accounts[0]?.detail).toContain("2026-10-06T12:00:00.000Z");
    expect(accounts[1]?.summary).toBe("Usage unavailable");
  });
});
