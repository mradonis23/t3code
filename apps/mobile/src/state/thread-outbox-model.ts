import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@t3tools/client-runtime/state/attachments";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  type OrchestrationLatestTurn,
  type ProjectId as ProjectIdType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DraftComposerAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { resolveProviderInteractionMode } from "../features/threads/legacy-plan-mode";

const THREAD_OUTBOX_SCHEMA_VERSION = 4;
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;

const QueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  // Snapshot of the project's display metadata so a pending task stays
  // presentable in the thread list even when the project shell is not loaded.
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, THREAD_OUTBOX_SCHEMA_VERSION, 4]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  attachments: Schema.Array(DraftComposerAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  deliveryMode: Schema.optional(Schema.Literals(["immediate", "after-success", "steer", "paused"])),
  // Present when the queued item creates a brand-new thread (pending task)
  // instead of appending a turn to an existing one.
  creation: Schema.optional(QueuedThreadCreationSchema),
  createdAt: IsoDateTime,
});

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema);

export interface QueuedThreadCreation {
  readonly projectId: ProjectIdType;
  readonly projectTitle?: string;
  readonly projectCwd?: string;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
}

export interface QueuedThreadMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly modelSelection?: ModelSelectionType;
  readonly runtimeMode?: RuntimeModeType;
  readonly interactionMode?: ProviderInteractionModeType;
  readonly deliveryMode?: "immediate" | "after-success" | "steer" | "paused";
  readonly creation?: QueuedThreadCreation;
  readonly createdAt: string;
}

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelectionType;
  readonly runtimeMode: RuntimeModeType;
  readonly interactionMode: ProviderInteractionModeType;
}

export type ComposerSendIntent = "default" | "steer";

export function resolveComposerDeliveryMode(input: {
  readonly intent: ComposerSendIntent;
  readonly connected: boolean;
  readonly threadBusy: boolean;
}): NonNullable<QueuedThreadMessage["deliveryMode"]> {
  if (input.intent === "steer") return "steer";
  return input.connected && !input.threadBusy ? "immediate" : "after-success";
}

export function reorderQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
  messageId: MessageId,
  direction: -1 | 1,
): ReadonlyArray<QueuedThreadMessage> {
  const index = messages.findIndex((message) => message.messageId === messageId);
  const neighborIndex = index + direction;
  if (index < 0 || neighborIndex < 0 || neighborIndex >= messages.length) return messages;
  const next = [...messages];
  const message = messages[index]!;
  const neighbor = messages[neighborIndex]!;
  next[index] = { ...neighbor, createdAt: message.createdAt };
  next[neighborIndex] = { ...message, createdAt: neighbor.createdAt };
  return next;
}

export function prioritizeQueuedThreadMessage(
  messages: ReadonlyArray<QueuedThreadMessage>,
  messageId: MessageId,
  deliveryMode: "immediate" | "steer",
): ReadonlyArray<QueuedThreadMessage> {
  const index = messages.findIndex((message) => message.messageId === messageId);
  if (index <= 0) {
    return index === 0 ? [{ ...messages[0]!, deliveryMode }, ...messages.slice(1)] : messages;
  }
  const timestamps = messages.map((message) => message.createdAt);
  const prioritized = messages[index]!;
  return [
    { ...prioritized, createdAt: timestamps[0]!, deliveryMode },
    ...messages.slice(0, index).map((message, priorIndex) => ({
      ...message,
      createdAt: timestamps[priorIndex + 1]!,
    })),
    ...messages.slice(index + 1),
  ];
}

export function pauseQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): ReadonlyArray<QueuedThreadMessage> {
  return messages.map((message) =>
    message.deliveryMode === "paused" ? message : { ...message, deliveryMode: "paused" as const },
  );
}

export function resumeQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
  safelyIdle: boolean,
): ReadonlyArray<QueuedThreadMessage> {
  return messages.map((message, index) => ({
    ...message,
    deliveryMode: safelyIdle && index === 0 ? ("immediate" as const) : ("after-success" as const),
  }));
}

export function isThreadQueuePaused(messages: ReadonlyArray<QueuedThreadMessage>): boolean {
  return messages.length > 0 && messages.every((message) => message.deliveryMode === "paused");
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "showInteractionModeToggle">> = [],
): ThreadSettingsSnapshot {
  const modelSelection = message.modelSelection ?? thread.modelSelection;
  const provider = providers.find(
    (candidate) => candidate.instanceId === modelSelection.instanceId,
  );
  return {
    modelSelection,
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode: resolveProviderInteractionMode(
      provider,
      message.interactionMode ?? thread.interactionMode,
    ),
  };
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown {
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value);
  return message;
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  const deduplicated = new Map<MessageId, QueuedThreadMessage>();
  for (const message of messages) {
    deduplicated.set(message.messageId, message);
  }

  const grouped: Record<string, Array<QueuedThreadMessage>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedThreadKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export type ThreadOutboxDeliveryAction = "wait" | "remove" | "send";

export function resolveThreadOutboxDeliveryAction(input: {
  readonly isCreation: boolean;
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadBusy: boolean;
  readonly deliveryMode?: QueuedThreadMessage["deliveryMode"];
  readonly successfulCompletionAvailable?: boolean;
}): ThreadOutboxDeliveryAction {
  if (input.isCreation) {
    if (input.threadExists) return "remove";
    return input.environmentConnected && input.shellStatus === "live" ? "send" : "wait";
  }
  if (!input.threadExists) {
    return input.shellStatus === "live" ? "remove" : "wait";
  }
  if (!input.environmentConnected) return "wait";
  if (input.deliveryMode === "immediate" || input.deliveryMode === "steer") return "send";
  return !input.threadBusy && input.successfulCompletionAvailable === true ? "send" : "wait";
}

export function successfulQueuedTurnCompletion(
  previous: OrchestrationLatestTurn | null | undefined,
  current: OrchestrationLatestTurn | null | undefined,
): string | null {
  return previous?.state === "running" &&
    current?.state === "completed" &&
    previous.turnId === current.turnId
    ? current.turnId
    : null;
}

export type ThreadOutboxDispatchStep =
  | { readonly step: "wait" }
  | { readonly step: "remove" }
  | { readonly step: "retry" }
  | { readonly step: "restore"; readonly reason: string }
  | { readonly step: "send" };

/**
 * Wait for provider and file capabilities before sending. Cleanup does not
 * need config: a creation whose thread exists, or a message whose thread is
 * gone, can still be removed while config loads.
 */
export function resolveThreadOutboxDispatchStep(input: {
  readonly deliveryAction: ThreadOutboxDeliveryAction;
  readonly fileAttachments: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
  /** Null while the environment's server config has not synced yet. */
  readonly serverConfig: { readonly maxFileUploadBytes: number | undefined } | null;
}): ThreadOutboxDispatchStep {
  if (input.deliveryAction !== "send") {
    return { step: input.deliveryAction };
  }
  if (input.serverConfig === null) {
    return { step: "retry" };
  }
  if (input.fileAttachments.length === 0) {
    return { step: "send" };
  }
  const maxBytes = input.serverConfig.maxFileUploadBytes;
  if (maxBytes === undefined) {
    return { step: "restore", reason: "This server does not support file attachments." };
  }
  const effectiveMaxBytes = clampFileAttachmentUploadBytes(maxBytes);
  const oversized = input.fileAttachments.find(
    (attachment) => attachment.sizeBytes > effectiveMaxBytes,
  );
  return oversized
    ? { step: "restore", reason: fileAttachmentTooLargeMessage(oversized.name, effectiveMaxBytes) }
    : { step: "send" };
}

/**
 * A queued creation can only be dispatched once its payload would pass server
 * validation; incomplete payloads stay pending until the user edits them.
 */
export function isQueuedThreadCreationSendable(message: QueuedThreadMessage): boolean {
  if (!message.creation) {
    return false;
  }
  if (message.text.trim().length === 0 || message.modelSelection === undefined) {
    return false;
  }
  return message.creation.workspaceMode !== "worktree" || Boolean(message.creation.branch);
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ConnectionTransientError"
  ) {
    return true;
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "restore";

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  if (
    input.stage === "settings-sync" ||
    input.interrupted ||
    shouldRetryThreadOutboxDelivery(input.error)
  ) {
    return "retry";
  }
  return "restore";
}
