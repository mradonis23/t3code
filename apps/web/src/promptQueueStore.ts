import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import {
  PersistedComposerFileAttachment,
  PersistedComposerImageAttachment,
} from "./composerDraftStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";

export const PROMPT_QUEUE_STORAGE_KEY = "t3code:prompt-queue:v1";
const PROMPT_QUEUE_STORAGE_VERSION = 1;
export const MAX_PROMPT_QUEUE_ENTRIES = 50;

export const PromptQueueDeliveryMode = Schema.Literals([
  "immediate",
  "after-success",
  "steer",
  "paused",
]);
export type PromptQueueDeliveryMode = typeof PromptQueueDeliveryMode.Type;

const PromptQueueCreationSchema = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  threadCreatedAt: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  prepareWorktree: Schema.optionalKey(
    Schema.Struct({
      projectCwd: Schema.String,
      baseBranch: Schema.String,
      branch: Schema.String,
      startFromOrigin: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const PromptQueueEntrySchema = Schema.Struct({
  id: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  images: Schema.Array(PersistedComposerImageAttachment),
  files: Schema.Array(PersistedComposerFileAttachment),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  deliveryMode: PromptQueueDeliveryMode,
  creation: Schema.optionalKey(PromptQueueCreationSchema),
  createdAt: Schema.String,
  pendingImageCount: Schema.optionalKey(Schema.Number),
  droppedImageNames: Schema.optionalKey(Schema.Array(Schema.String)),
  unreadableImageNames: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type PromptQueueEntry = typeof PromptQueueEntrySchema.Type;

const PersistedPromptQueueState = Schema.Struct({
  entries: Schema.Array(PromptQueueEntrySchema),
});
const decodePersistedPromptQueueState = Schema.decodeUnknownSync(PersistedPromptQueueState);

export type PromptQueueSendIntent = "default" | "steer";
export function resolvePromptQueueDeliveryMode(input: {
  readonly intent: PromptQueueSendIntent;
  readonly connected: boolean;
  readonly threadBusy: boolean;
}): PromptQueueDeliveryMode {
  if (input.intent === "steer") return "steer";
  return input.connected && !input.threadBusy ? "immediate" : "after-success";
}
export function promptQueueThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

export function promptQueueEntriesForThread(
  entries: ReadonlyArray<PromptQueueEntry>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<PromptQueueEntry> {
  const key = promptQueueThreadKey(environmentId, threadId);
  return entries.filter(
    (entry) => promptQueueThreadKey(entry.environmentId, entry.threadId) === key,
  );
}

export function isPromptQueuePaused(entries: ReadonlyArray<PromptQueueEntry>): boolean {
  return entries.length > 0 && entries.every((entry) => entry.deliveryMode === "paused");
}

export function reorderPromptQueueEntries(
  entries: ReadonlyArray<PromptQueueEntry>,
  entryId: string,
  direction: -1 | 1,
): ReadonlyArray<PromptQueueEntry> {
  const index = entries.findIndex((entry) => entry.id === entryId);
  const neighborIndex = index + direction;
  if (index < 0 || neighborIndex < 0 || neighborIndex >= entries.length) return entries;
  const next = [...entries];
  const current = entries[index]!;
  const neighbor = entries[neighborIndex]!;
  next[index] = { ...neighbor, createdAt: current.createdAt };
  next[neighborIndex] = { ...current, createdAt: neighbor.createdAt };
  return next;
}
export function prioritizePromptQueueEntry(
  entries: ReadonlyArray<PromptQueueEntry>,
  entryId: string,
  deliveryMode: "immediate" | "steer",
): ReadonlyArray<PromptQueueEntry> {
  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) return entries;
  const timestamps = entries.map((entry) => entry.createdAt);
  const prioritized = entries[index]!;
  return [
    { ...prioritized, createdAt: timestamps[0]!, deliveryMode },
    ...entries.slice(0, index).map((entry, priorIndex) => ({
      ...entry,
      createdAt: timestamps[priorIndex + 1]!,
    })),
    ...entries.slice(index + 1),
  ];
}

export function pausePromptQueueEntries(
  entries: ReadonlyArray<PromptQueueEntry>,
): ReadonlyArray<PromptQueueEntry> {
  return entries.map((entry) =>
    entry.deliveryMode === "paused" ? entry : { ...entry, deliveryMode: "paused" as const },
  );
}

export function resumePromptQueueEntries(
  entries: ReadonlyArray<PromptQueueEntry>,
  safelyIdle: boolean,
): ReadonlyArray<PromptQueueEntry> {
  return entries.map((entry, index) => ({
    ...entry,
    deliveryMode: safelyIdle && index === 0 ? ("immediate" as const) : ("after-success" as const),
  }));
}
export type PromptQueueDispatchAction = "wait" | "send";
export type PromptQueueCreationDispatchAction = "wait" | "remove" | "send";

export function resolvePromptQueueCreationDispatchAction(input: {
  readonly entry: PromptQueueEntry;
  readonly connected: boolean;
  readonly shellBootstrapped: boolean;
  readonly threadExists: boolean;
}): PromptQueueCreationDispatchAction {
  if (input.entry.creation === undefined) return "wait";
  if (input.entry.deliveryMode === "paused" || (input.entry.pendingImageCount ?? 0) > 0) {
    return "wait";
  }
  if (!input.shellBootstrapped) return "wait";
  if (input.threadExists) return "remove";
  return input.connected ? "send" : "wait";
}

export function resolvePromptQueueDispatchAction(input: {
  readonly entry: PromptQueueEntry;
  readonly connected: boolean;
  readonly threadBusy: boolean;
  readonly latestTurnState: "running" | "interrupted" | "completed" | "error" | null;
  readonly latestTurnCompletedAt: string | null;
}): PromptQueueDispatchAction {
  if ((input.entry.pendingImageCount ?? 0) > 0) return "wait";
  if (input.entry.deliveryMode === "paused" || !input.connected) return "wait";
  if (input.entry.deliveryMode === "steer") return "send";
  if (input.entry.deliveryMode === "immediate") return input.threadBusy ? "wait" : "send";
  if (input.threadBusy || input.latestTurnState !== "completed" || !input.latestTurnCompletedAt) {
    return "wait";
  }
  return input.latestTurnCompletedAt > input.entry.createdAt ? "send" : "wait";
}

function settleHydratedEntries(
  entries: ReadonlyArray<PromptQueueEntry>,
): ReadonlyArray<PromptQueueEntry> {
  return entries.map((entry) => {
    const pendingImageCount = entry.pendingImageCount ?? 0;
    const staleSteer = entry.deliveryMode === "steer";
    if (pendingImageCount === 0 && !staleSteer) return entry;
    const lostImages =
      pendingImageCount > 0
        ? Array.from(
            { length: pendingImageCount },
            (_, index) => `image ${index + 1} (not saved before reload)`,
          )
        : [];
    return {
      ...entry,
      deliveryMode: "paused" as const,
      pendingImageCount: 0,
      unreadableImageNames: [...(entry.unreadableImageNames ?? []), ...lostImages],
    };
  });
}
function resolveBaseStorage(): { storage: StateStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {
    // Fall through.
  }
  return { storage: createMemoryStorage(), durable: false };
}

const { storage: baseQueueStorage, durable: queueStorageIsDurable } = resolveBaseStorage();
function persistEntries(entries: ReadonlyArray<PromptQueueEntry>): {
  readonly written: boolean;
  readonly durable: boolean;
} {
  try {
    baseQueueStorage.setItem(
      PROMPT_QUEUE_STORAGE_KEY,
      JSON.stringify({
        version: PROMPT_QUEUE_STORAGE_VERSION,
        state: { entries },
      }),
    );
    return { written: true, durable: queueStorageIsDurable };
  } catch (error) {
    console.error("[PROMPT-QUEUE] Could not persist queue.", error);
    return { written: false, durable: false };
  }
}
function readPersistedEntries(): ReadonlyArray<PromptQueueEntry> {
  try {
    const raw = baseQueueStorage.getItem(PROMPT_QUEUE_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return [];
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown } | null)?.state;
    if (!state) return [];
    return settleHydratedEntries(decodePersistedPromptQueueState(state).entries);
  } catch {
    return [];
  }
}
function replaceThreadEntries(
  allEntries: ReadonlyArray<PromptQueueEntry>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  replacement: ReadonlyArray<PromptQueueEntry>,
): ReadonlyArray<PromptQueueEntry> {
  const key = promptQueueThreadKey(environmentId, threadId);
  const others = allEntries.filter(
    (entry) => promptQueueThreadKey(entry.environmentId, entry.threadId) !== key,
  );
  return [...others, ...replacement].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}
export interface PromptQueueStoreState {
  entries: ReadonlyArray<PromptQueueEntry>;
  enqueue: (entry: PromptQueueEntry) => { written: boolean; durable: boolean };
  updateEntry: (
    entryId: string,
    patch: Partial<
      Pick<
        PromptQueueEntry,
        "text" | "deliveryMode" | "modelSelection" | "runtimeMode" | "interactionMode"
      >
    >,
  ) => boolean;
  removeEntry: (entryId: string) => boolean;
  moveEntry: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    entryId: string,
    direction: -1 | 1,
  ) => boolean;
  prioritizeEntry: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    entryId: string,
    deliveryMode: "immediate" | "steer",
  ) => boolean;
  pauseThread: (environmentId: EnvironmentId, threadId: ThreadId) => boolean;
  resumeThread: (environmentId: EnvironmentId, threadId: ThreadId, safelyIdle: boolean) => boolean;
  finalizeImages: (
    entryId: string,
    result: {
      images: ReadonlyArray<PersistedComposerImageAttachment>;
      droppedImageNames: ReadonlyArray<string>;
      unreadableImageNames: ReadonlyArray<string>;
    },
  ) => boolean;
}

function storeEntries(nextEntries: ReadonlyArray<PromptQueueEntry>): boolean {
  const { written } = persistEntries(nextEntries);
  return written;
}

const initialEntries = readPersistedEntries();
if (initialEntries.length > 0) {
  persistEntries(initialEntries);
}
export const usePromptQueueStore = create<PromptQueueStoreState>()((set, get) => ({
  entries: initialEntries,
  enqueue: (entry) => {
    const deduped = get().entries.filter((candidate) => candidate.id !== entry.id);
    const nextEntries = [...deduped, entry]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-MAX_PROMPT_QUEUE_ENTRIES);
    const result = persistEntries(nextEntries);
    if (result.written) set({ entries: nextEntries });
    return result;
  },
  updateEntry: (entryId, patch) => {
    const entries = get().entries;
    const index = entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) return false;
    const nextEntries = [...entries];
    nextEntries[index] = { ...entries[index]!, ...patch };
    if (!storeEntries(nextEntries)) return false;
    set({ entries: nextEntries });
    return true;
  },
  removeEntry: (entryId) => {
    const entries = get().entries;
    const nextEntries = entries.filter((entry) => entry.id !== entryId);
    if (nextEntries.length === entries.length) return false;
    if (!storeEntries(nextEntries)) return false;
    set({ entries: nextEntries });
    return true;
  },
  moveEntry: (environmentId, threadId, entryId, direction) => {
    const entries = get().entries;
    const threadEntries = promptQueueEntriesForThread(entries, environmentId, threadId);
    const reordered = reorderPromptQueueEntries(threadEntries, entryId, direction);
    if (reordered === threadEntries) return false;
    const nextEntries = replaceThreadEntries(entries, environmentId, threadId, reordered);
    if (!storeEntries(nextEntries)) return false;
    set({ entries: nextEntries });
    return true;
  },
  prioritizeEntry: (environmentId, threadId, entryId, deliveryMode) => {
    const entries = get().entries;
    const threadEntries = promptQueueEntriesForThread(entries, environmentId, threadId);
    const prioritized = prioritizePromptQueueEntry(threadEntries, entryId, deliveryMode);
    if (prioritized === threadEntries) return false;
    const nextEntries = replaceThreadEntries(entries, environmentId, threadId, prioritized);
    if (!storeEntries(nextEntries)) return false;
    set({ entries: nextEntries });
    return true;
  },
  pauseThread: (environmentId, threadId) => {
    const entries = get().entries;
    const threadEntries = promptQueueEntriesForThread(entries, environmentId, threadId);
    if (threadEntries.length === 0) return false;
    const nextEntries = replaceThreadEntries(
      entries,
      environmentId,
      threadId,
      pausePromptQueueEntries(threadEntries),
    );
    if (!storeEntries(nextEntries)) return false;
    set({ entries: nextEntries });
    return true;
  },
  resumeThread: (environmentId, threadId, safelyIdle) => {
    const entries = get().entries;
    const threadEntries = promptQueueEntriesForThread(entries, environmentId, threadId);
    if (threadEntries.length === 0) return false;
    const nextEntries = replaceThreadEntries(
      entries,
      environmentId,
      threadId,
      resumePromptQueueEntries(threadEntries, safelyIdle),
    );
    if (!storeEntries(nextEntries)) return false;
    set({ entries: nextEntries });
    return true;
  },
  finalizeImages: (entryId, result) => {
    const entries = get().entries;
    const index = entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) return false;
    const nextEntries = [...entries];
    nextEntries[index] = {
      ...entries[index]!,
      images: [...result.images],
      pendingImageCount: 0,
      droppedImageNames: [...result.droppedImageNames],
      unreadableImageNames: [...result.unreadableImageNames],
    };
    if (!storeEntries(nextEntries)) return false;
    set({ entries: nextEntries });
    return true;
  },
}));
