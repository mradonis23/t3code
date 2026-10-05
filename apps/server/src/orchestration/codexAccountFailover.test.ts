import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  exhaustedProviderRetryAfterMs,
  isCodexUsageExhaustionMessage,
  providerHasUsableCodexCapacity,
  selectCodexFailoverProvider,
} from "./codexAccountFailover.ts";

const checkedAt = "2026-10-04T22:00:00.000Z";

function provider(input: {
  id: string;
  sessionLeft: number;
  weeklyLeft: number;
  displayName?: string;
  authenticated?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driver: ProviderDriverKind.make("codex"),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: input.authenticated === false ? "unauthenticated" : "authenticated" },
    checkedAt,
    availability: "available",
    models: [
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: 100 - input.sessionLeft,
          resetsAt: "2026-10-05T01:00:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 100 - input.weeklyLeft,
          resetsAt: "2026-10-09T01:00:00.000Z",
        },
      ],
    },
  };
}

const selection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
};

describe("Codex account failover", () => {
  it("chooses the alternate account with the strongest bottleneck capacity", () => {
    const dad = provider({ id: "codex", sessionLeft: 0, weeklyLeft: 9, displayName: "Dad" });
    const mom = provider({ id: "codex_mom", sessionLeft: 100, weeklyLeft: 53, displayName: "Mom" });
    const nena = provider({
      id: "codex_nena",
      sessionLeft: 100,
      weeklyLeft: 57,
      displayName: "Nena",
    });

    expect(
      selectCodexFailoverProvider({
        providers: [dad, mom, nena],
        currentInstanceId: dad.instanceId,
        modelSelection: selection,
      })?.instanceId,
    ).toBe(nena.instanceId);
  });

  it("fails over from Mom to Nena when Dad is exhausted and Nena has usable capacity", () => {
    const dad = provider({ id: "codex", sessionLeft: 100, weeklyLeft: 0, displayName: "Dad" });
    const mom = provider({
      id: "codex_mom",
      sessionLeft: 0,
      weeklyLeft: 53,
      displayName: "Mom",
    });
    const nena = provider({
      id: "codex_nena",
      sessionLeft: 100,
      weeklyLeft: 57,
      displayName: "Nena",
    });

    expect(
      selectCodexFailoverProvider({
        providers: [dad, mom, nena],
        currentInstanceId: mom.instanceId,
        modelSelection: {
          ...selection,
          instanceId: mom.instanceId,
        },
      })?.instanceId,
    ).toBe(nena.instanceId);
  });

  it("skips a previously exhausted account and falls through to the next usable one", () => {
    const dad = provider({ id: "codex", sessionLeft: 0, weeklyLeft: 9 });
    const mom = provider({ id: "codex_mom", sessionLeft: 100, weeklyLeft: 53 });
    const nena = provider({ id: "codex_nena", sessionLeft: 100, weeklyLeft: 57 });

    expect(
      selectCodexFailoverProvider({
        providers: [dad, mom, nena],
        currentInstanceId: dad.instanceId,
        modelSelection: selection,
        blockedInstanceIds: new Set(["codex_nena"]),
      })?.instanceId,
    ).toBe(mom.instanceId);
  });

  it("returns no target when every alternate account is exhausted or unavailable", () => {
    const dad = provider({ id: "codex", sessionLeft: 0, weeklyLeft: 9 });
    const mom = provider({ id: "codex_mom", sessionLeft: 0, weeklyLeft: 53 });
    const nena = provider({
      id: "codex_nena",
      sessionLeft: 100,
      weeklyLeft: 57,
      authenticated: false,
    });

    expect(providerHasUsableCodexCapacity(mom)).toBe(false);
    expect(
      selectCodexFailoverProvider({
        providers: [dad, mom, nena],
        currentInstanceId: dad.instanceId,
        modelSelection: selection,
      }),
    ).toBeNull();
  });

  it("recognizes explicit usage exhaustion and only treats generic rate limits as exhaustion when quota is empty", () => {
    const exhausted = provider({ id: "codex", sessionLeft: 0, weeklyLeft: 9 });
    const available = provider({ id: "codex", sessionLeft: 50, weeklyLeft: 50 });

    expect(isCodexUsageExhaustionMessage("Usage limit reached. Try again later.", available)).toBe(
      true,
    );
    expect(isCodexUsageExhaustionMessage("Account quota exhausted.", available)).toBe(true);
    expect(isCodexUsageExhaustionMessage("Rate limit exceeded.", available)).toBe(false);
    expect(isCodexUsageExhaustionMessage("Rate limit exceeded.", exhausted)).toBe(true);
  });

  it("blocks an exhausted account until the reported quota reset", () => {
    const exhausted = provider({ id: "codex", sessionLeft: 0, weeklyLeft: 9 });
    expect(exhaustedProviderRetryAfterMs(exhausted, Date.parse(checkedAt))).toBe(
      Date.parse("2026-10-05T01:00:00.000Z"),
    );
  });
});
