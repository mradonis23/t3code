import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  diagnosticsProviderLabel,
  diagnosticsTextSummary,
  operationalReportCards,
  summarizeWork,
  WORK_CATEGORIES,
  workCount,
} from "@t3tools/client-runtime/diagnostics";
import type { EnvironmentId, ServerTraceDiagnosticsResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { useEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { usePromptQueueStore } from "../../promptQueueStore";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

export function OperationalStatus({
  environmentId,
  traces,
  onRun,
}: {
  readonly environmentId: EnvironmentId;
  readonly traces: ServerTraceDiagnosticsResult | null;
  readonly onRun: () => void;
}) {
  const environment = useEnvironment(environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const snapshot = Option.getOrNull(shell.snapshot);
  const queue = usePromptQueueStore((state) => state.entries);
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    serverEnvironment.operationalDiagnostics({ environmentId, input: {} }),
  );
  const work = useMemo(
    () =>
      summarizeWork({
        environmentId,
        threads: snapshot?.threads ?? [],
        queue,
        now: [data?.readAt ?? "", snapshot?.updatedAt ?? ""].toSorted().at(-1) ?? "",
      }),
    [environmentId, snapshot, queue, data?.readAt],
  );
  const cards = operationalReportCards({
    data,
    config,
    connection: environment?.connection.phase ?? "unavailable",
    sync: shell.status,
    syncSequence: snapshot?.snapshotSequence ?? null,
    error,
    work,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "diagnostics summary" });
  const summary = diagnosticsTextSummary({
    cards,
    config,
    data,
    work,
    recentErrors: traces?.latestFailures
      .slice(0, 5)
      .map((failure) => `${failure.name}: ${failure.cause.slice(0, 500)}`) ?? [
      "Trace diagnostics unavailable",
    ],
  });

  return (
    <>
      <SettingsSection
        id="t3-status"
        title="T3 Status"
        description="Operational facts for this environment. Checks run when this page opens or when requested."
        headerAction={
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={isPending}
              onClick={() => {
                refresh();
                onRun();
              }}
            >
              {isPending ? "Checking…" : "Run T3 diagnostics"}
            </Button>
            <Button size="xs" variant="outline" onClick={() => copyToClipboard(summary)}>
              {isCopied ? "Copied" : "Copy summary"}
            </Button>
          </div>
        }
      >
        {error ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            Latest check failed: {error}
            {data ? ` · Showing last successful report from ${data.readAt}` : ""}
          </p>
        ) : null}
        <div className="grid gap-px sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => (
            <div key={card.label} className="min-w-0 p-4">
              <div className="text-xs text-muted-foreground">{card.label}</div>
              <div className="mt-1 break-words text-sm font-medium">{card.value}</div>
              <p className="mt-1 break-words text-xs text-muted-foreground">{card.detail}</p>
            </div>
          ))}
        </div>
        <div className="space-y-3 border-t border-border/60 p-4">
          <h3 className="text-sm font-medium">Providers / accounts · last known checks</h3>
          {config?.providers.map((provider) => (
            <div key={provider.instanceId} className="text-sm">
              <div>
                {diagnosticsProviderLabel(provider)} · {provider.driver} · {provider.status} ·{" "}
                {provider.auth.status}
              </div>
              <p className="text-xs text-muted-foreground">
                Version {provider.version ?? "unavailable"} · checked {provider.checkedAt}
                {provider.message ? ` · ${provider.message}` : ""}
              </p>
            </div>
          )) ?? <p className="text-xs text-muted-foreground">Provider state unavailable.</p>}
        </div>
        <div className="space-y-2 border-t border-border/60 p-4">
          <h3 className="text-sm font-medium">Recent trace errors</h3>
          {traces === null ? (
            <p className="text-xs text-muted-foreground">Trace diagnostics unavailable.</p>
          ) : traces.latestFailures.length === 0 ? (
            <p className="text-xs text-muted-foreground">No failures in available traces.</p>
          ) : (
            traces.latestFailures.slice(0, 5).map((failure) => (
              <p
                key={`${failure.traceId}:${failure.spanId}`}
                className="break-words text-xs text-muted-foreground"
              >
                {failure.name}: {failure.cause.slice(0, 300)}
              </p>
            ))
          )}
        </div>
      </SettingsSection>
      <SettingsSection
        id="work-queue"
        title="Work Queue"
        description="All threads in this environment; queued and paused counts are messages on this client. Completed recently means the last 24 hours, as of the latest state or check."
      >
        {shell.status !== "live" ? (
          <p className="p-4 text-xs text-muted-foreground">
            Work state is {shell.status}; counts may be incomplete or stale.
          </p>
        ) : null}
        {WORK_CATEGORIES.map((category) => (
          <details key={category} className="p-4">
            <summary className="cursor-pointer text-sm">
              {category}: {workCount(work[category])}
            </summary>
            <div className="mt-2 flex flex-col gap-2 text-xs">
              {work[category].map((entry) =>
                entry.navigable ? (
                  <Link
                    key={entry.threadId}
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: entry.threadId }}
                    className="text-primary underline"
                  >
                    {entry.title}
                    {entry.count > 1 ? ` (${entry.count} messages)` : ""}
                  </Link>
                ) : (
                  <span key={entry.threadId}>
                    {entry.title} · thread creation pending
                    {entry.count > 1 ? ` (${entry.count} messages)` : ""}
                  </span>
                ),
              )}
              {work[category].length === 0 ? (
                <span className="text-muted-foreground">None in the available state.</span>
              ) : null}
            </div>
          </details>
        ))}
      </SettingsSection>
      <SettingsSection
        id="native-sessions"
        title="Native Sessions"
        description="Last known attachment state. Resumable means a stopped binding has a native cursor; provider availability and authentication still apply."
      >
        {!data?.nativeSessionsAvailable ? (
          <p className="p-4 text-xs text-muted-foreground">Native session state unavailable.</p>
        ) : data.nativeSessions.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">No native bindings recorded.</p>
        ) : (
          data.nativeSessions.map((session) => {
            const provider = config?.providers.find(
              (entry) => entry.instanceId === session.providerInstanceId,
            );
            const thread = snapshot?.threads.find((entry) => entry.id === session.threadId);
            return (
              <div key={session.threadId} className="p-4 text-sm">
                {thread ? (
                  <Link
                    className="text-primary underline"
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: session.threadId }}
                  >
                    {thread.title}
                  </Link>
                ) : (
                  <span>Thread unavailable in the active snapshot</span>
                )}
                <div>
                  {provider
                    ? diagnosticsProviderLabel(provider)
                    : (session.providerInstanceId ?? session.provider)}{" "}
                  · {session.status ?? "unknown"} · resumable: {session.resumable ? "yes" : "no"}
                </div>
                <p className="text-xs text-muted-foreground">
                  Last seen {session.lastSeenAt} · synchronized{" "}
                  {session.lastSynchronizedAt ?? "time unavailable"}
                </p>
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer">Details / Advanced</summary>
                  <p className="mt-1 break-all font-mono">
                    Native session ID: {session.nativeSessionId ?? "unavailable"}
                  </p>
                </details>
              </div>
            );
          })
        )}
      </SettingsSection>
    </>
  );
}
