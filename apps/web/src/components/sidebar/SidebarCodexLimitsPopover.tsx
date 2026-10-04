import {
  collectLimitAccounts,
  formatResetsIn,
  limitsNotice,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { useAtomValue } from "@effect/atom-react";
import { GaugeIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

interface CodexLimitEntry {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly accountLabel: string;
  readonly provider: ServerProvider;
}

function CodexLimitProviderCard({
  entry,
  showEnvironment,
  now,
}: {
  readonly entry: CodexLimitEntry;
  readonly showEnvironment: boolean;
  readonly now: number;
}) {
  const { provider } = entry;
  const limits = provider.usageLimits;
  if (!limits) return null;

  const planLabel = provider.auth.label ?? provider.auth.type ?? null;
  const notice = limitsNotice(limits);

  return (
    <section className="grid gap-3 rounded-lg border border-border/60 bg-background/35 p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={entry.accountLabel}
          accentColor={provider.accentColor}
          showBadge={Boolean(provider.accentColor)}
          className="size-5"
          iconClassName="size-4"
          badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{entry.accountLabel}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {[planLabel, showEnvironment ? entry.environmentLabel : null]
              .filter(Boolean)
              .join(" Â· ")}
          </div>
        </div>
      </div>

      {notice ? (
        <div className="rounded-md bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
          {notice}
        </div>
      ) : (
        <LimitWindows compact driver={provider.driver} windows={limits.windows} now={now} />
      )}

      {limits.resetCredits ? (
        <ResetCredits
          environmentId={entry.environmentId}
          instanceId={provider.instanceId}
          credits={limits.resetCredits}
          now={now}
        />
      ) : null}
    </section>
  );
}

/**
 * Main-sidebar access to subscription quota. This deliberately reads the same
 * typed provider snapshots as Usage -> Limits and the /usage-limits composer
 * command so desktop, web, and mobile never disagree about the account state.
 */
export function SidebarCodexLimitsSummary() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const accounts = collectLimitAccounts(presentations).filter(
    (account) => account.driver === "codex",
  );
  const now = Date.now();

  return (
    <div
      className="mb-1 grid gap-1.5 rounded-lg border border-border/60 bg-sidebar-accent/35 px-2.5 py-2"
      aria-label="Codex subscription limits summary"
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        ChatGPT limits
      </div>
      {accounts.length === 0 ? (
        <div className="text-[10px] text-muted-foreground">Refreshing subscription limits…</div>
      ) : (
        accounts.map((account) => (
          <div key={account.key} className="grid gap-0.5">
            <div className="truncate text-[11px] font-medium text-sidebar-foreground">
              {account.displayName ?? account.email ?? "Codex"}
            </div>
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground">
              {account.limits.windows.map((window) => (
                <span key={window.id}>
                  {window.label}:{" "}
                  <strong className="font-semibold text-sidebar-foreground">
                    {remainingPercent(window)}%
                  </strong>
                  {formatResetsIn(window, now) ? ` · ${formatResetsIn(window, now)}` : ""}
                </span>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export function SidebarCodexLimitsPopover() {
  const { environments } = useEnvironments();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);

  const entries = useMemo<ReadonlyArray<CodexLimitEntry>>(
    () =>
      environments.flatMap((environment) => {
        const providerEntries = deriveProviderInstanceEntries(
          environment.serverConfig?.providers ?? [],
        );
        return providerEntries.flatMap((providerEntry) => {
          const provider = providerEntry.snapshot;
          if (String(providerEntry.driverKind) !== "codex" || !provider.usageLimits) return [];
          return [
            {
              environmentId: environment.environmentId,
              environmentLabel: environment.label,
              accountLabel: providerEntry.displayName,
              provider,
            },
          ];
        });
      }),
    [environments],
  );

  const environmentIds = useMemo(
    () => [...new Set(entries.map((entry) => entry.environmentId))],
    [entries],
  );
  const showEnvironment = environmentIds.length > 1;
  const now = Date.now();

  const refresh = useCallback(() => {
    if (isRefreshing || environmentIds.length === 0) return;
    setIsRefreshing(true);
    void Promise.all(
      environmentIds.map((environmentId) => refreshProviders({ environmentId, input: {} })),
    ).finally(() => setIsRefreshing(false));
  }, [environmentIds, isRefreshing, refreshProviders]);

  if (entries.length === 0) return null;

  return (
    <SidebarMenuItem className="shrink-0">
      <Popover>
        <PopoverTrigger
          render={
            <SidebarMenuButton
              aria-label="Codex subscription limits"
              title="Codex subscription limits"
              size="icon"
            />
          }
        >
          <GaugeIcon />
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="start"
          sideOffset={8}
          className="w-[min(22rem,calc(100vw-1rem))]"
          viewportClassName="p-3!"
        >
          <div className="grid gap-3">
            <div className="flex items-start justify-between gap-3 px-0.5">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">Codex limits</div>
                <div className="text-[11px] text-muted-foreground">
                  ChatGPT subscription windows across configured accounts
                </div>
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                disabled={isRefreshing}
                onClick={refresh}
                aria-label="Refresh Codex subscription limits"
                title="Refresh limits"
              >
                {isRefreshing ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3.5" />
                )}
              </Button>
            </div>

            <div className="grid gap-2">
              {entries.map((entry) => (
                <CodexLimitProviderCard
                  key={`${entry.environmentId}:${entry.provider.instanceId}`}
                  entry={entry}
                  showEnvironment={showEnvironment}
                  now={now}
                />
              ))}
            </div>
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}
