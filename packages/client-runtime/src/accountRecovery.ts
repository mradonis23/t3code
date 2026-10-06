import {
  CodexAccountRecoveryUnavailable,
  pendingCodexAccountRecoveryOffer,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { formatResetsIn, limitsNotice, remainingPercent } from "@t3tools/shared/usageLimits";

const isCodexAccountRecoveryUnavailable = Schema.is(CodexAccountRecoveryUnavailable);

export { pendingCodexAccountRecoveryOffer };

export function codexAccountLabel(instanceId: string, displayName?: string): string {
  if (instanceId === "codex") return "Dad's Codex";
  if (instanceId === "codex_mom") return "Mom's Codex";
  if (instanceId === "codex_nena") return "Nena's Codex";
  return displayName?.trim() || instanceId;
}

export function accountSwitchBlocked(
  thread: Pick<OrchestrationThreadShell, "session" | "modelSelection">,
  nextInstanceId: string,
) {
  return (
    nextInstanceId !== (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId) &&
    (thread.session?.status === "starting" || thread.session?.status === "running")
  );
}

export function codexAccountSummaries(providers: ReadonlyArray<ServerProvider>, now: number) {
  return providers
    .filter((provider) => provider.driver === "codex")
    .map((provider) => {
      const limits = provider.usageLimits;
      const notice = limits ? limitsNotice(limits) : "Usage unavailable";
      return {
        instanceId: provider.instanceId,
        label: codexAccountLabel(String(provider.instanceId), provider.displayName),
        summary:
          notice ||
          limits?.windows
            .map((window) => `${window.label} ${remainingPercent(window)}% left`)
            .join(" · ") ||
          "Usage unavailable",
        detail: [
          provider.status,
          provider.auth.status,
          ...(limits?.windows.map(
            (window) =>
              `${window.label}: ${formatResetsIn(window, now) ?? "reset time unavailable"}${window.resetsAt ? ` (${window.resetsAt})` : ""}`,
          ) ?? []),
        ].join(" · "),
      };
    });
}

export function availableAccountRecovery(thread: OrchestrationThread) {
  if (thread.session?.status === "starting" || thread.session?.status === "running") return null;
  return pendingCodexAccountRecoveryOffer(thread);
}

export function unavailableAccountRecoveryReason(thread: OrchestrationThread) {
  const activity = thread.activities.findLast((entry) =>
    entry.kind.startsWith("codex.account.failover."),
  );
  if (
    activity?.kind !== "codex.account.failover.unavailable" ||
    !isCodexAccountRecoveryUnavailable(activity.payload) ||
    activity.payload.providerInstanceId !== thread.modelSelection.instanceId ||
    (activity.turnId !== null && activity.turnId !== thread.latestTurn?.turnId) ||
    (thread.messages.findLast((message) => message.role === "user")?.id ?? null) !==
      activity.payload.sourceMessageId
  )
    return null;
  return `${activity.payload.reason} ${activity.payload.detail}`;
}
