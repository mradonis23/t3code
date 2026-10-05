import type {
  OrchestrationThread,
  OrchestrationThreadActivity,
  VcsStatusResult,
} from "@t3tools/contracts";

export type CheckpointInterruptionKind =
  | "usage-limit"
  | "runtime-error"
  | "cancellation-or-termination"
  | "disconnect"
  | "interrupted";

export interface CheckpointContinuation {
  readonly kind: CheckpointInterruptionKind;
  readonly prompt: string;
  readonly reason: string;
}

export interface CheckpointContinuationActionState {
  readonly canContinueNow: boolean;
  readonly canSteer: boolean;
  readonly primaryAction: "continue-now" | "queue";
}

export type CheckpointContinuationSubmissionIntent = "now" | "later" | "steer";
export type CheckpointContinuationDeliveryMode = "immediate" | "after-success" | "steer" | "paused";

type ConnectionState =
  | "available"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "offline"
  | "error";

interface CommandEvidence {
  readonly activity: OrchestrationThreadActivity;
  readonly command: string;
  readonly output: string | null;
  readonly status: string | null;
  readonly toolCallId: string | null;
}

const SUCCESS_STATUSES = new Set(["completed", "success", "succeeded"]);
const FAILURE_STATUSES = new Set(["failed", "error", "declined", "cancelled", "interrupted"]);
const RUNNING_STATUSES = new Set(["inprogress", "in_progress", "running", "started"]);
const SHA_PATTERN = /\b[0-9a-f]{40}\b/iu;
const COMMIT_OUTPUT_PATTERN = /\[[^\]]+\s+([0-9a-f]{7,40})\]/iu;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function firstText(...values: ReadonlyArray<unknown>): string | null {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return null;
}

function activityOrder(left: OrchestrationThreadActivity, right: OrchestrationThreadActivity) {
  const sequenceDelta = (left.sequence ?? -1) - (right.sequence ?? -1);
  if (sequenceDelta !== 0 && left.sequence !== undefined && right.sequence !== undefined) {
    return sequenceDelta;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

function commandEvidence(activity: OrchestrationThreadActivity): CommandEvidence | null {
  const payload = asRecord(activity.payload);
  if (!payload || payload.itemType !== "command_execution") return null;
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const dataInput = asRecord(data?.input);
  const rawOutput = asRecord(data?.rawOutput);
  const command = firstText(
    data?.command,
    item?.command,
    itemInput?.command,
    dataInput?.command,
    itemResult?.command,
    payload.detail,
  );
  if (!command) return null;

  return {
    activity,
    command: compact(command, 180),
    output: firstText(
      item?.aggregatedOutput,
      itemResult?.content,
      rawOutput?.content,
      data?.aggregatedOutput,
    ),
    status: asText(payload.status)?.toLocaleLowerCase() ?? null,
    toolCallId: firstText(payload.toolCallId, data?.toolCallId),
  };
}

function isSuccessfulCommand(evidence: CommandEvidence): boolean {
  return (
    evidence.activity.kind === "tool.completed" &&
    evidence.activity.tone !== "error" &&
    (evidence.status === null || SUCCESS_STATUSES.has(evidence.status)) &&
    !FAILURE_STATUSES.has(evidence.status ?? "")
  );
}

function commandEvidenceFromActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<CommandEvidence> {
  return [...activities]
    .sort(activityOrder)
    .map(commandEvidence)
    .filter((evidence): evidence is CommandEvidence => evidence !== null);
}

function latestUnsettledCommand(evidence: ReadonlyArray<CommandEvidence>): CommandEvidence | null {
  const completedIds = new Set(
    evidence
      .filter((entry) => entry.activity.kind === "tool.completed")
      .map((entry) => entry.toolCallId)
      .filter((id): id is string => id !== null),
  );
  const completedCommands = new Set(
    evidence
      .filter((entry) => entry.activity.kind === "tool.completed")
      .map((entry) => entry.command),
  );

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]!;
    if (entry.activity.kind === "tool.completed") continue;
    if (
      entry.toolCallId ? completedIds.has(entry.toolCallId) : completedCommands.has(entry.command)
    ) {
      continue;
    }
    if (
      entry.activity.kind === "tool.started" ||
      entry.activity.kind === "tool.updated" ||
      RUNNING_STATUSES.has(entry.status ?? "")
    ) {
      return entry;
    }
  }
  return null;
}

function latestFailedCommand(evidence: ReadonlyArray<CommandEvidence>): CommandEvidence | null {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]!;
    if (
      entry.activity.kind === "tool.completed" &&
      (FAILURE_STATUSES.has(entry.status ?? "") || entry.activity.tone === "error")
    ) {
      return entry;
    }
  }
  return null;
}

export function isUsageLimitInterruptionError(message: string): boolean {
  const normalized = message.trim().toLocaleLowerCase();
  return (
    normalized.includes("usage limit") ||
    normalized.includes("usage cap") ||
    /\bquota\b.{0,80}\b(?:exhausted|reached|used\s+up)\b/iu.test(normalized) ||
    /\b(?:exhausted|reached)\b.{0,80}\bquota\b/iu.test(normalized) ||
    /\brate\s+limit(?:ed)?\b|\brate\s+limit\s+(?:reached|exceeded)\b/iu.test(normalized)
  );
}

function detectInterruptionKind(input: {
  readonly thread: OrchestrationThread;
  readonly connectionState: ConnectionState;
}): CheckpointInterruptionKind | null {
  const { thread } = input;
  const error = thread.session?.lastError?.trim().toLocaleLowerCase() ?? "";
  if (isUsageLimitInterruptionError(error)) return "usage-limit";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "runtime-error";
  }
  if (
    input.connectionState !== "connected" &&
    (thread.latestTurn?.state === "running" ||
      thread.session?.status === "running" ||
      thread.session?.status === "starting")
  ) {
    return "disconnect";
  }
  if (thread.latestTurn?.state !== "interrupted") return null;
  return thread.session?.status === "stopped" ? "cancellation-or-termination" : "interrupted";
}

function interruptionReason(kind: CheckpointInterruptionKind, thread: OrchestrationThread): string {
  const recordedError = thread.session?.lastError?.trim();
  switch (kind) {
    case "usage-limit":
      return recordedError ?? "The provider reported a usage limit.";
    case "runtime-error":
      return recordedError ?? "T3 recorded a runtime error without a specific cause.";
    case "cancellation-or-termination":
      return "T3 recorded the latest turn as interrupted after the provider session stopped; cancellation and unexpected termination are not distinguishable here.";
    case "disconnect":
      return "The client connection was lost while T3 still recorded the turn as active; the server-side outcome is unknown.";
    case "interrupted":
      return "T3 recorded the latest turn as interrupted without a successful completion.";
  }
}

function latestReadyCheckpoint(thread: OrchestrationThread) {
  return [...thread.checkpoints]
    .filter((checkpoint) => checkpoint.status === "ready")
    .sort((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
    .at(-1);
}

function formatFileList(files: ReadonlyArray<string>): string {
  const unique = [...new Set(files)].slice(0, 8);
  const remaining = new Set(files).size - unique.length;
  return `${unique.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ""}`;
}

function successfulCommandGroups(evidence: ReadonlyArray<CommandEvidence>) {
  const successful = evidence.filter(isSuccessfulCommand);
  const checks = successful.filter((entry) =>
    /(?:^|\s)(?:vp|pnpm|npm|bun|yarn|tsc|gradlew(?:\.bat)?)(?:\s|.*\s)(?:test|lint|typecheck|check|tsc)(?:\s|$)/iu.test(
      entry.command,
    ),
  );
  const builds = successful.filter((entry) =>
    /(?:assemble|bundle)?release|(?:^|\s)build(?:\s|$)/iu.test(entry.command),
  );
  const installs = successful.filter(
    (entry) =>
      /(?:^|\s)adb(?:\.exe)?\s+.*install\b/iu.test(entry.command) &&
      /success/iu.test(entry.output ?? ""),
  );
  return { successful, checks, builds, installs };
}

function latestRecordedHead(evidence: ReadonlyArray<CommandEvidence>): string | null {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]!;
    if (!isSuccessfulCommand(entry) || !/git\s+rev-parse\s+HEAD(?:\s|$)/iu.test(entry.command)) {
      continue;
    }
    return entry.output?.match(SHA_PATTERN)?.[0] ?? null;
  }
  return null;
}

function latestRecordedCommit(evidence: ReadonlyArray<CommandEvidence>): string | null {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]!;
    if (!isSuccessfulCommand(entry) || !/git\s+commit(?:\s|$)/iu.test(entry.command)) continue;
    return entry.output?.match(COMMIT_OUTPUT_PATTERN)?.[1] ?? null;
  }
  return null;
}

export function resolveCheckpointContinuationActionState(input: {
  readonly continuationKind: CheckpointInterruptionKind;
  readonly connectionState: ConnectionState;
  readonly sessionStatus: NonNullable<OrchestrationThread["session"]>["status"] | null;
  readonly latestTurnState: NonNullable<OrchestrationThread["latestTurn"]>["state"] | null;
}): CheckpointContinuationActionState {
  // Provider session state is authoritative for steering. A provider
  // failure can leave latestTurnState="running" persisted after the live
  // adapter session is already terminal.
  const busy = input.sessionStatus === "running" || input.sessionStatus === "starting";
  const providerLimited = input.continuationKind === "usage-limit";
  const canContinueNow = input.connectionState === "connected" && !busy && !providerLimited;
  return {
    canContinueNow,
    canSteer: input.connectionState === "connected" && busy && !providerLimited,
    primaryAction: canContinueNow ? "continue-now" : "queue",
  };
}

export function resolveCheckpointContinuationDeliveryMode(input: {
  readonly intent: CheckpointContinuationSubmissionIntent;
  readonly continuationKind: CheckpointInterruptionKind;
  readonly threadBusy: boolean;
}): CheckpointContinuationDeliveryMode {
  if (input.intent === "steer") return "steer";
  if (input.intent === "now") return "immediate";
  if (input.continuationKind === "usage-limit" || !input.threadBusy) return "paused";
  return "after-success";
}

export function buildCheckpointContinuation(input: {
  readonly thread: OrchestrationThread;
  readonly connectionState: ConnectionState;
  readonly gitStatus: VcsStatusResult | null;
  readonly projectTitle?: string | null;
  readonly projectWorkspaceRoot?: string | null;
}): CheckpointContinuation | null {
  const kind = detectInterruptionKind(input);
  if (!kind) return null;

  const { thread } = input;
  const reason = interruptionReason(kind, thread);
  const latestTurnId = thread.latestTurn?.turnId ?? null;
  const allCommandEvidence = commandEvidenceFromActivities(thread.activities);
  const latestTurnEvidence = commandEvidenceFromActivities(
    thread.activities.filter(
      (activity) => latestTurnId === null || activity.turnId === latestTurnId,
    ),
  );
  const commandGroups = successfulCommandGroups(allCommandEvidence);
  const unresolvedCommand = latestUnsettledCommand(latestTurnEvidence);
  const failedCommand = latestFailedCommand(latestTurnEvidence);
  const checkpoint = latestReadyCheckpoint(thread);
  const confirmedAssistant = checkpoint
    ? thread.messages.find(
        (message) =>
          message.role === "assistant" &&
          (message.id === checkpoint.assistantMessageId || message.turnId === checkpoint.turnId),
      )
    : null;
  const partialAssistant = latestTurnId
    ? thread.messages
        .toReversed()
        .find((message) => message.role === "assistant" && message.turnId === latestTurnId)
    : null;
  const latestUserMessage = thread.messages
    .toReversed()
    .find((message) => message.role === "user" && message.text.trim().length > 0);
  const latestActivity = [...thread.activities]
    .filter((activity) => latestTurnId === null || activity.turnId === latestTurnId)
    .sort(activityOrder)
    .at(-1);
  const recordedHead = latestRecordedHead(allCommandEvidence);
  const recordedCommit = latestRecordedCommit(allCommandEvidence);

  const lines = [
    "CONTINUE FROM EXACT CHECKPOINT",
    "",
    "WHERE WE ARE",
    `- Thread: ${compact(thread.title, 120)} (${thread.id})`,
  ];
  if (input.projectTitle) lines.push(`- Project: ${compact(input.projectTitle, 100)}`);
  const workspace = thread.worktreePath ?? input.projectWorkspaceRoot;
  if (workspace) lines.push(`- Workspace: ${compact(workspace, 180)}`);
  if (latestUserMessage) {
    lines.push(`- Latest user request: ${compact(latestUserMessage.text, 260)}`);
  }

  lines.push("", "CONFIRMED COMPLETE");
  if (checkpoint) {
    lines.push(
      `- Last reliable T3 checkpoint: turn ${checkpoint.checkpointTurnCount}, ref ${checkpoint.checkpointRef}.`,
    );
    if (checkpoint.files.length > 0) {
      lines.push(
        `- Checkpoint files: ${formatFileList(checkpoint.files.map((file) => file.path))}`,
      );
    }
  } else {
    lines.push("- No ready Git checkpoint is recorded; do not infer one.");
  }
  if (confirmedAssistant?.text.trim()) {
    lines.push(`- Last confirmed assistant result: ${compact(confirmedAssistant.text, 320)}`);
  }
  if (commandGroups.checks.length > 0) {
    lines.push(
      `- Recorded successful checks: ${commandGroups.checks
        .slice(-3)
        .map((entry) => `\`${entry.command}\``)
        .join("; ")}.`,
    );
  }
  if (commandGroups.builds.length > 0) {
    lines.push(`- Recorded successful build: \`${commandGroups.builds.at(-1)!.command}\`.`);
  }
  if (commandGroups.installs.length > 0) {
    lines.push(`- Recorded successful install: \`${commandGroups.installs.at(-1)!.command}\`.`);
  }
  if (recordedCommit) lines.push(`- Commit created by a completed command: ${recordedCommit}.`);

  lines.push("", "CURRENT EVIDENCE");
  lines.push(`- Interruption: ${compact(reason, 320)}`);
  if (latestTurnId) {
    lines.push(
      `- Latest turn: ${latestTurnId}; state ${thread.latestTurn?.state ?? "unknown"}; no later successful completion is recorded.`,
    );
  }
  if (recordedHead) {
    lines.push(`- Last Git HEAD explicitly recorded by a completed command: ${recordedHead}.`);
  }
  if (input.gitStatus?.isRepo) {
    const branch = input.gitStatus.refName ?? "detached HEAD";
    lines.push(
      `- T3 Git snapshot: ${branch}; worktree ${input.gitStatus.hasWorkingTreeChanges ? "dirty" : "clean"}.`,
    );
    if (input.gitStatus.workingTree.files.length > 0) {
      lines.push(
        `- Current changed files reported by T3: ${formatFileList(
          input.gitStatus.workingTree.files.map((file) => file.path),
        )}`,
      );
    }
  } else if (thread.branch) {
    lines.push(
      `- Thread-recorded branch: ${compact(thread.branch, 120)}; current Git state is unavailable.`,
    );
  }
  if (partialAssistant?.text.trim() && partialAssistant.id !== confirmedAssistant?.id) {
    lines.push(
      `- Last recorded assistant progress (partial, not proof of completion): ${compact(partialAssistant.text, 360)}`,
    );
  }
  if (latestActivity) {
    lines.push(`- Last recorded activity: ${compact(latestActivity.summary, 180)}.`);
  }
  if (unresolvedCommand) {
    lines.push(
      `- Ambiguous command at interruption: \`${unresolvedCommand.command}\`; its final outcome is not recorded.`,
    );
  } else if (failedCommand) {
    lines.push(`- Last command recorded failed/interrupted: \`${failedCommand.command}\`.`);
  }

  lines.push("", "NEXT ACTION");
  if (unresolvedCommand) {
    lines.push(
      `- Inspect only the minimum Git/runtime evidence needed to determine whether \`${unresolvedCommand.command}\` completed, then continue only unfinished work.`,
    );
  } else if (failedCommand) {
    lines.push(
      `- Continue the latest user request from the recorded failure of \`${failedCommand.command}\`; inspect current state before retrying.`,
    );
  } else {
    lines.push(
      "- Continue the latest user request from the evidence above and execute only the remaining work.",
    );
  }

  lines.push("", "DO NOT REPEAT");
  if (checkpoint) lines.push("- Do not redo work already covered by the ready checkpoint.");
  if (commandGroups.checks.length > 0) {
    lines.push(
      "- Do not rerun recorded successful checks unless changed state makes it necessary.",
    );
  }
  if (commandGroups.builds.length > 0 || commandGroups.installs.length > 0) {
    lines.push(
      "- Do not repeat recorded successful build/install steps unless current evidence requires it.",
    );
  }
  lines.push(
    "- Do not assume the interrupted operation succeeded or failed; preserve ambiguity until inspected.",
    "- Preserve unrelated work and avoid destructive Git operations.",
    "- Inspect only minimum current evidence, continue execution, and do not restart discovery or replay the full conversation.",
  );

  return { kind, prompt: lines.join("\n"), reason };
}
