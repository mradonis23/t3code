import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ServerConfig,
  ServerOperationalDiagnosticsResult,
  ThreadId,
} from "@t3tools/contracts";
import { isUsageLimitInterruptionError } from "@t3tools/shared/checkpointContinuation";
import { codexAccountLabel } from "./accountRecovery.ts";

export const WORK_CATEGORIES = [
  "Running",
  "Queued",
  "Paused",
  "Needs Input",
  "Usage Limited",
  "Failed",
  "Completed recently",
] as const;
export type WorkCategory = (typeof WORK_CATEGORIES)[number];

export interface DiagnosticsQueueEntry {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly deliveryMode?: string;
}

export interface WorkEntry {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly count: number;
  readonly navigable: boolean;
}
export type WorkSummary = Record<WorkCategory, ReadonlyArray<WorkEntry>>;

/** Shell facts cover the environment; unsent queue facts belong to this client. */
export function summarizeWork(input: {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly queue: ReadonlyArray<DiagnosticsQueueEntry>;
  readonly now: string;
}): WorkSummary {
  const groups: Record<WorkCategory, Map<ThreadId, WorkEntry>> = {
    Running: new Map(),
    Queued: new Map(),
    Paused: new Map(),
    "Needs Input": new Map(),
    "Usage Limited": new Map(),
    Failed: new Map(),
    "Completed recently": new Map(),
  };
  const threads = new Map(
    input.threads
      .filter((thread) => thread.archivedAt === null)
      .map((thread) => [thread.id, thread]),
  );
  const now = Date.parse(input.now);
  for (const thread of threads.values()) {
    let category: WorkCategory | null = null;
    const status = thread.session?.status;
    const error = thread.session?.lastError;
    if (
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.hasActionableProposedPlan
    )
      category = "Needs Input";
    else if (
      error &&
      isUsageLimitInterruptionError(error) &&
      (status === "error" || status === "interrupted" || status === "stopped")
    )
      category = "Usage Limited";
    else if (status === "error" || thread.latestTurn?.state === "error") category = "Failed";
    else if (
      status === "starting" ||
      status === "running" ||
      thread.latestTurn?.state === "running" ||
      thread.backgroundLiveness != null
    )
      category = "Running";
    else if (thread.latestTurn?.state === "completed" && thread.latestTurn.completedAt !== null) {
      const age = now - Date.parse(thread.latestTurn.completedAt);
      if (age >= 0 && age <= 24 * 60 * 60 * 1000) category = "Completed recently";
    }
    if (category)
      groups[category].set(thread.id, {
        threadId: thread.id,
        title: thread.title,
        count: 1,
        navigable: true,
      });
  }
  for (const entry of input.queue) {
    if (entry.environmentId !== input.environmentId) continue;
    const category = entry.deliveryMode === "paused" ? "Paused" : "Queued";
    const thread = threads.get(entry.threadId);
    const previous = groups[category].get(entry.threadId);
    groups[category].set(entry.threadId, {
      threadId: entry.threadId,
      title: thread?.title ?? "Pending thread",
      count: (previous?.count ?? 0) + 1,
      navigable: thread !== undefined,
    });
  }
  return {
    Running: [...groups.Running.values()],
    Queued: [...groups.Queued.values()],
    Paused: [...groups.Paused.values()],
    "Needs Input": [...groups["Needs Input"].values()],
    "Usage Limited": [...groups["Usage Limited"].values()],
    Failed: [...groups.Failed.values()],
    "Completed recently": [...groups["Completed recently"].values()],
  };
}

export function workCount(entries: ReadonlyArray<WorkEntry>): number {
  return entries.reduce((count, entry) => count + entry.count, 0);
}

export function diagnosticsProviderLabel(provider: {
  readonly driver: string;
  readonly instanceId: string;
  readonly displayName?: string | undefined;
}): string {
  return provider.driver === "codex"
    ? codexAccountLabel(provider.instanceId, provider.displayName)
    : (provider.displayName ?? provider.instanceId);
}

export function diagnosticsBytes(bytes: number | null): string {
  if (bytes === null) return "unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export interface DiagnosticsCard {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}

/** The same compact production report is rendered and copied on every client. */
export function operationalReportCards(input: {
  readonly data: ServerOperationalDiagnosticsResult | null;
  readonly config: ServerConfig | null;
  readonly connection: string;
  readonly sync: string;
  readonly syncSequence: number | null;
  readonly error: string | null;
  readonly work?: WorkSummary;
}): ReadonlyArray<DiagnosticsCard> {
  const { data, config, work } = input;
  return [
    {
      label: "Backend",
      value: input.connection,
      detail: data
        ? `RPC succeeded at ${data.readAt}${input.error ? `; latest check failed: ${input.error}` : ""}`
        : (input.error ?? "Run diagnostics to check backend reachability."),
    },
    {
      label: "Server",
      value: config?.environment.serverVersion ?? "Version unavailable",
      detail: "Host-service / NSSM state is unavailable through the portable server API.",
    },
    {
      label: "Database",
      value: data ? `${data.database.status} · query ${data.database.queryStatus}` : "Not checked",
      detail: data
        ? `${diagnosticsBytes(data.database.sizeBytes)} · metadata and read query (not an integrity scan)`
        : "",
    },
    {
      label: "Disk",
      value: data
        ? `${data.disk.status} · ${diagnosticsBytes(data.disk.freeBytes)} free`
        : "Not checked",
      detail: data ? `${data.disk.freePercent?.toFixed(1) ?? "?"}% free on ${data.disk.path}` : "",
    },
    {
      label: "Runtime scratch",
      value: data
        ? `${data.runtimeScratch.status} · ${data.runtimeScratch.meiDirectoryCount} _MEI`
        : "Not checked",
      detail: data
        ? `${data.runtimeScratch.launchDirectoryCount} launch directories · ${diagnosticsBytes(data.runtimeScratch.sampledBytes)} sampled${data.runtimeScratch.scanTruncated ? " · scan limit reached; totals are partial" : ""}`
        : "",
    },
    {
      label: "Clients",
      value: data?.clients
        ? `${data.clients.filter((client) => client.connected).length} connected`
        : "Unavailable",
      detail: data?.clients
        ? data.clients
            .map(
              (client) =>
                `${client.label ?? "Client"} (${client.deviceType}; ${client.surface ?? "app surface not reported"}): ${client.connected ? "connected" : "disconnected"}`,
            )
            .join("; ") || "No active client credentials"
        : "Connected-client state could not be read.",
    },
    {
      label: "Sync",
      value: input.sync,
      detail:
        input.syncSequence === null
          ? "No shell snapshot"
          : `This client's shell sequence ${input.syncSequence}; peer sync progress is unavailable.`,
    },
    {
      label: "Native sessions",
      value: data?.nativeSessionsAvailable
        ? `${data.nativeSessions.length} bindings · ${data.nativeSessions.filter((session) => session.resumable).length} resumable`
        : "Unavailable",
      detail: data?.nativeSessionsAvailable
        ? ["starting", "running", "stopped", "error"]
            .map(
              (status) =>
                `${status}: ${data.nativeSessions.filter((session) => session.status === status).length}`,
            )
            .join(" · ")
        : "Last known attachment state could not be read.",
    },
    {
      label: "Work",
      value:
        work && input.syncSequence !== null
          ? `${workCount(work.Running)} running · ${workCount(work["Needs Input"])} need input`
          : "Unavailable",
      detail: work
        ? input.syncSequence === null
          ? `Thread state unavailable; queued: ${workCount(work.Queued)} · paused: ${workCount(work.Paused)} messages on this client`
          : WORK_CATEGORIES.filter(
              (category) => category !== "Running" && category !== "Needs Input",
            )
              .map((category) => `${category}: ${workCount(work[category])}`)
              .join(" · ") + " · queued/paused messages on this client"
        : "Open the work summary for thread and local queue state.",
    },
    {
      label: "Latest known backup",
      value:
        data?.backup.latestModifiedAt ??
        (data?.backup.directory ? "No readable backup found" : "Not configured or discovered"),
      detail: `${data?.backup.latestPath ?? data?.backup.directory ?? "Configure T3CODE_BACKUP_DIR or use the environment's backups directory."}${data?.backup.scanTruncated ? " · directory scan limit reached; newest sampled backup only" : ""}`,
    },
  ];
}

export function diagnosticsTextSummary(input: {
  readonly cards: ReadonlyArray<DiagnosticsCard>;
  readonly config: ServerConfig | null;
  readonly data: ServerOperationalDiagnosticsResult | null;
  readonly work: WorkSummary;
  readonly recentErrors: ReadonlyArray<string>;
}): string {
  return [
    "T3 Status",
    ...input.cards.map(
      (card) => `${card.label}: ${card.value}${card.detail ? ` — ${card.detail}` : ""}`,
    ),
    "Providers (last known checks):",
    ...(input.config?.providers.map(
      (provider) =>
        `${diagnosticsProviderLabel(provider)}: ${provider.status}; auth ${provider.auth.status}; version ${provider.version ?? "unavailable"}; checked ${provider.checkedAt}`,
    ) ?? ["Unavailable"]),
    "Work (environment threads; queued/paused messages on this client; completed within 24h):",
    ...WORK_CATEGORIES.map((category) => `${category}: ${workCount(input.work[category])}`),
    "Native sessions (last known bindings):",
    ...(input.data?.nativeSessionsAvailable
      ? input.data.nativeSessions.map(
          (session) =>
            `${session.providerInstanceId ?? session.provider}: ${session.status ?? "unknown"}; resumable ${session.resumable}; last seen ${session.lastSeenAt}`,
        )
      : ["Unavailable"]),
    "Recent trace errors:",
    ...input.recentErrors,
  ].join("\n");
}
