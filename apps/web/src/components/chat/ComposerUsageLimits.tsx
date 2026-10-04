import type { EnvironmentId, UsageLimitsReport } from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";

import { getDriverOption } from "../settings/providerDriverMeta";
import { LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Driver name, then the instance when there could be more than one of that driver. */
function accountLabel(account: UsageLimitsReport["accounts"][number]): string {
  if (account.driver === "codex" && account.instanceId) {
    if (account.instanceId === "codex_mom") return "Mom's Codex";
    if (account.instanceId === "codex_nena") return "Nana's Codex";
    if (account.instanceId === "codex") return "Dad's Codex";
  }
  if (!account.instanceId) return account.label;
  const driver = getDriverOption(account.driver)?.label ?? String(account.driver);
  const instance =
    account.displayName?.trim() ||
    (String(account.instanceId) !== String(account.driver) ? account.instanceId : "");
  return instance && instance.toLowerCase() !== driver.toLowerCase()
    ? `${driver} · ${instance}`
    : driver;
}

function accountIdentityColor(account: UsageLimitsReport["accounts"][number]): string | null {
  if (account.driver !== "codex" || !account.instanceId) return null;
  if (account.instanceId === "codex_mom") return "#FF9F0A";
  if (account.instanceId === "codex_nena") return "#30D158";
  if (account.instanceId === "codex") return "#0A84FF";
  return null;
}

/** The /usage-limits result as a composer notice: it stacks under warnings and dismisses like one. */
export function usageLimitsBannerItem(
  id: string,
  report: UsageLimitsReport,
  environmentId: EnvironmentId,
  onDismiss: () => void,
): ComposerBannerStackItem {
  const [first] = report.accounts;
  const single = report.accounts.length === 1 && first ? first : null;
  const summary = single
    ? [accountLabel(single), single.plan].filter(Boolean).join(" · ")
    : `${report.accounts.length} accounts`;
  return {
    id,
    variant: "info",
    priority: "notice",
    icon: <GaugeIcon />,
    title: "Usage limits",
    description: summary,
    dismissLabel: "Dismiss usage limits",
    onDismiss,
    children: <UsageLimitsBannerBody report={report} environmentId={environmentId} />,
  };
}

function UsageLimitsBannerBody({
  report,
  environmentId,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
}) {
  const now = Date.parse(report.createdAt);
  return (
    <ComposerBanner.Scroll>
      <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
        {report.accounts.map((account) => {
          const notice = limitsNotice(account.limits);
          return (
            <div key={account.id} className="flex min-w-0 flex-col gap-1">
              {report.accounts.length > 1 ? (
                <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
                  {accountIdentityColor(account) ? (
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: accountIdentityColor(account) ?? undefined }}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="truncate">
                    {[accountLabel(account), account.plan].filter(Boolean).join(" · ")}
                  </span>
                </span>
              ) : null}
              {notice ? (
                <span className="text-xs text-muted-foreground">{notice}</span>
              ) : (
                <LimitWindows
                  compact
                  driver={account.driver}
                  windows={account.limits.windows}
                  now={now}
                />
              )}
              {account.instanceId && account.limits.resetCredits ? (
                <ResetCredits
                  environmentId={environmentId}
                  instanceId={account.instanceId}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              ) : null}
            </div>
          );
        })}
        {report.notices.map((notice) => (
          <span key={notice} className="text-xs text-muted-foreground">
            {notice}
          </span>
        ))}
      </ComposerBanner.Body>
    </ComposerBanner.Scroll>
  );
}
