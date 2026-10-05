import {
  collectLimitAccounts,
  formatResetsIn,
  limitsNotice,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { useAtomValue } from "@effect/atom-react";
import { GaugeIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderResetCredits,
} from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  LimitWindows,
  ResetCreditDialog,
  ResetCredits,
  resetCreditsSummary,
  useResetCredit,
} from "../usage/UsageLimits";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

interface CodexLimitEntry {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly accountLabel: string;
  readonly provider: ServerProvider;
}

function codexAccountPresentation(instanceId: string): {
  readonly label: string;
  readonly color: string;
} {
  switch (instanceId) {
    case "codex_mom":
      return { label: "Mom's Codex", color: "#FF9F0A" };
    case "codex_nena":
      return { label: "Nena's Codex", color: "#30D158" };
    case "codex":
    default:
      return { label: "Dad's Codex", color: "#0A84FF" };
  }
}

function SidebarResetCreditPill({
  environmentId,
  instanceId,
  credits,
  now,
  color,
  accountLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly credits: ServerProviderResetCredits;
  readonly now: number;
  readonly color: string;
  readonly accountLabel: string;
}) {
  const { confirming, setConfirming, busy, status, redeem } = useResetCredit(
    environmentId,
    instanceId,
  );
  if (credits.availableCount === 0 && status === null) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {credits.availableCount > 0 ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirming(true)}
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[9px] font-semibold tabular-nums transition-opacity hover:opacity-80 disabled:opacity-50"
          style={{
            borderColor: `${color}80`,
            backgroundColor: `${color}14`,
            color,
          }}
          aria-label={`Use a reset credit for ${accountLabel}`}
          title={resetCreditsSummary(credits, now)}
        >
          <RefreshCwIcon className={busy ? "size-2.5 animate-spin" : "size-2.5"} />
          {busy
            ? "Using…"
            : `${credits.availableCount} reset${credits.availableCount === 1 ? "" : "s"}`}
        </button>
      ) : null}
      {status ? (
        <span className="min-w-0 text-[9px] leading-tight text-sidebar-foreground">{status}</span>
      ) : null}
      <ResetCreditDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => void redeem()}
      />
    </div>
  );
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
  const account = codexAccountPresentation(String(provider.instanceId));

  return (
    <section className="grid gap-3 rounded-lg border border-border/60 bg-background/35 p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={entry.accountLabel}
          accentColor={account.color}
          showBadge
          className="size-5"
          iconClassName="size-4"
          badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{entry.accountLabel}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {[planLabel, showEnvironment ? entry.environmentLabel : null]
              .filter(Boolean)
              .join(" - ")}
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
  const threadShells = useThreadShells();
  const [expanded, setExpanded] = useState(false);
  const accounts = collectLimitAccounts(presentations).filter(
    (account) => account.driver === "codex",
  );
  const activeAccount =
    [...threadShells]
      .filter(
        (thread) => thread.session?.status === "running" || thread.session?.status === "starting",
      )
      .sort(
        (left, right) =>
          Date.parse(right.session?.updatedAt ?? right.updatedAt ?? right.createdAt) -
          Date.parse(left.session?.updatedAt ?? left.updatedAt ?? left.createdAt),
      )
      .flatMap((thread) => {
        const instanceId =
          thread.session?.providerInstanceId ?? thread.modelSelection.instanceId ?? null;
        if (!instanceId) return [];
        const account = accounts.find(
          (candidate) =>
            candidate.redeem?.instanceId === instanceId &&
            candidate.redeem.environmentId === thread.environmentId,
        );
        return account ? [account] : [];
      })[0] ??
    accounts.find((account) => String(account.redeem?.instanceId ?? "") === "codex") ??
    accounts[0] ??
    null;
  const visibleAccounts = expanded ? accounts : activeAccount ? [activeAccount] : [];
  const now = Date.now();

  return (
    <div
      className="mb-1 grid gap-1.5 overflow-hidden rounded-lg border border-border/60 bg-sidebar-accent/35"
      aria-label="Codex subscription limits summary"
    >
      <button
        type="button"
        className="flex items-center justify-between gap-2 px-2.5 py-2 text-left hover:bg-sidebar-accent/55"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          ChatGPT limits
        </span>
        <span className="text-[10px] font-medium text-muted-foreground">
          {expanded
            ? "Show active"
            : accounts.length > 1
              ? `Show all ${accounts.length}`
              : "Details"}
        </span>
      </button>
      <div className="grid gap-1.5 border-t border-border/50 px-2.5 py-2">
        {accounts.length === 0 ? (
          <div className="text-[10px] text-muted-foreground">Refreshing subscription limits...</div>
        ) : visibleAccounts.length === 0 ? (
          <div className="text-[10px] text-muted-foreground">No Codex limits available.</div>
        ) : (
          visibleAccounts.map((account, index) => {
            const identity = codexAccountPresentation(
              String(account.redeem?.instanceId ?? "codex"),
            );
            const resetCredits = account.limits.resetCredits;
            return (
              <div
                key={account.key}
                className={
                  index === 0 ? "grid gap-1" : "grid gap-1 border-t border-border/40 pt-1.5"
                }
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: identity.color }}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1 text-[11px] font-semibold text-sidebar-foreground">
                    {identity.label}
                  </div>
                  {account.redeem && resetCredits ? (
                    <SidebarResetCreditPill
                      environmentId={account.redeem.environmentId}
                      instanceId={account.redeem.instanceId}
                      credits={resetCredits}
                      now={now}
                      color={identity.color}
                      accountLabel={identity.label}
                    />
                  ) : null}
                </div>
                {account.email ? (
                  <div className="break-all pl-3.5 text-[9px] leading-tight text-muted-foreground">
                    {account.email}
                  </div>
                ) : null}
                {account.plan ? (
                  <div className="pl-3.5 text-[9px] leading-tight text-muted-foreground">
                    {account.plan}
                  </div>
                ) : null}
                <div className="grid gap-0.5 pl-3.5 text-[10px] tabular-nums text-muted-foreground">
                  {account.limits.windows.map((window) => {
                    const resetsIn = formatResetsIn(window, now);
                    return (
                      <div key={window.id} className="flex flex-wrap items-baseline gap-x-1">
                        <span>{window.label}:</span>
                        <strong className="font-semibold text-sidebar-foreground">
                          {remainingPercent(window)}%
                        </strong>
                        {resetsIn ? <span>- {resetsIn}</span> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
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
              accountLabel: codexAccountPresentation(String(provider.instanceId)).label,
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
