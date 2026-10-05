import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ThreadBranchError,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type ThreadBranchBoundariesInput,
  type ThreadBranchBoundariesResult,
  type ThreadBranchInput,
  type ThreadBranchResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  ProviderThreadForkSnapshot,
  ProviderThreadSnapshot,
} from "../provider/Services/ProviderAdapter.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

const error = (code: ConstructorParameters<typeof ThreadBranchError>[0]["code"], message: string) =>
  new ThreadBranchError({ code, message });

function stableHash(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function branchThreadId(sourceThreadId: ThreadId, nativeThreadId: string): ThreadId {
  return ThreadId.make(
    `branch:${stableHash(`${String(sourceThreadId)}\0${nativeThreadId}`).slice(0, 48)}`,
  );
}

function branchMessageId(input: {
  readonly nativeThreadId: string;
  readonly turnId: TurnId;
  readonly index: number;
  readonly role: "user" | "assistant";
  readonly text: string;
}): MessageId {
  return MessageId.make(
    `branch-message:${stableHash(
      `${input.nativeThreadId}\0${input.turnId}\0${input.index}\0${input.role}\0${input.text}`,
    ).slice(0, 48)}`,
  );
}

function nativeItemText(
  item: unknown,
): { readonly role: "user" | "assistant"; readonly text: string } | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  if (record.type === "agentMessage" && typeof record.text === "string") {
    const text = record.text.trim();
    return text.length > 0 ? { role: "assistant", text } : null;
  }
  if (record.type !== "userMessage" || !Array.isArray(record.content)) return null;
  const text = record.content
    .flatMap((content) => {
      if (content === null || typeof content !== "object" || Array.isArray(content)) return [];
      const contentRecord = content as Record<string, unknown>;
      return contentRecord.type === "text" && typeof contentRecord.text === "string"
        ? [contentRecord.text]
        : [];
    })
    .join("\n\n")
    .trim();
  return text.length > 0 ? { role: "user", text } : null;
}

export function resolveHistoricalBranchBoundaries(
  source: OrchestrationThread,
  native: ProviderThreadSnapshot,
): ThreadBranchBoundariesResult["boundaries"] {
  const direct = source.messages.flatMap((message) =>
    message.role === "assistant" && message.turnId !== null
      ? [{ messageId: message.id, turnId: message.turnId }]
      : [],
  );
  const directMessageIds = new Set(direct.map((entry) => entry.messageId));

  const projected = source.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        !directMessageIds.has(message.id),
    )
    .map((message) => ({
      messageId: message.id,
      role: message.role,
      text: message.text.trim(),
      turnId: message.turnId,
    }));

  const nativeMessages = native.turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      const message = nativeItemText(item);
      return message === null ? [] : [{ ...message, turnId: turn.id }];
    }),
  );
  if (projected.length === 0 || nativeMessages.length === 0) {
    return direct;
  }

  const candidates = projected.map((message) =>
    nativeMessages.flatMap((nativeMessage, index) =>
      message.role === nativeMessage.role &&
      message.text === nativeMessage.text &&
      (message.turnId === null || message.turnId === nativeMessage.turnId)
        ? [index]
        : [],
    ),
  );
  const candidateUseCounts = new Map<number, number>();
  for (const matches of candidates) {
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    candidateUseCounts.set(match, (candidateUseCounts.get(match) ?? 0) + 1);
  }

  return [
    ...direct,
    ...projected.flatMap((message, index) => {
      if (message.role !== "assistant" || message.turnId !== null) return [];
      const matches = candidates[index]!;
      if (matches.length !== 1 || candidateUseCounts.get(matches[0]!) !== 1) return [];
      return [{ messageId: message.messageId, turnId: nativeMessages[matches[0]!]!.turnId }];
    }),
  ];
}

function nativeTimestamp(seconds: number | null, fallback: string): string {
  return seconds !== null && Number.isFinite(seconds)
    ? DateTime.formatIso(DateTime.fromEpochSeconds(seconds))
    : fallback;
}

function branchMessages(
  forked: ProviderThreadForkSnapshot,
  fallbackTimestamp: string,
  lastTurnId: TurnId,
) {
  const boundaryIndex = forked.turns.findIndex((turn) => turn.id === lastTurnId);
  const turns = boundaryIndex < 0 ? [] : forked.turns.slice(0, boundaryIndex + 1);
  return turns.flatMap((turn) => {
    let itemIndex = 0;
    return turn.items.flatMap((item) => {
      const message = nativeItemText(item);
      if (message === null) return [];
      const createdAt = nativeTimestamp(
        message.role === "assistant" ? turn.completedAt : turn.startedAt,
        fallbackTimestamp,
      );
      const result = {
        messageId: branchMessageId({
          nativeThreadId: forked.threadId,
          turnId: turn.id,
          index: itemIndex,
          role: message.role,
          text: message.text,
        }),
        role: message.role,
        text: message.text,
        createdAt,
        turnId: turn.id,
      } as const;
      itemIndex += 1;
      return [result];
    });
  });
}

export const getThreadBranchBoundaries = Effect.fn("getThreadBranchBoundaries")(function* (
  input: ThreadBranchBoundariesInput,
) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const providerService = yield* ProviderService.ProviderService;

  const sourceOption = yield* snapshots.getThreadDetailById(input.threadId);
  if (Option.isNone(sourceOption)) {
    return yield* error("thread-not-found", `Thread '${input.threadId}' was not found.`);
  }
  const source = sourceOption.value;
  const bindingOption = yield* directory.getBinding(source.id);
  if (Option.isNone(bindingOption) || bindingOption.value.provider !== CODEX_DRIVER) {
    return { boundaries: [] } satisfies ThreadBranchBoundariesResult;
  }

  const readThread = providerService.readThread;
  if (readThread === undefined) {
    return yield* error(
      "provider-unavailable",
      "This provider cannot read native conversation history.",
    );
  }
  const native = yield* readThread({ threadId: source.id }).pipe(
    Effect.mapError((cause) =>
      error(
        "provider-unavailable",
        cause instanceof Error ? cause.message : "Native Codex history is unavailable.",
      ),
    ),
  );
  return {
    boundaries: resolveHistoricalBranchBoundaries(source, native),
  } satisfies ThreadBranchBoundariesResult;
});

export const branchThread = Effect.fn("branchThread")(function* (input: ThreadBranchInput) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const providerService = yield* ProviderService.ProviderService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const sourceOption = yield* snapshots.getThreadDetailById(input.threadId);
  if (Option.isNone(sourceOption)) {
    return yield* error("thread-not-found", `Thread '${input.threadId}' was not found.`);
  }
  const source = sourceOption.value;
  const bindingOption = yield* directory.getBinding(source.id);
  if (Option.isNone(bindingOption) || bindingOption.value.provider !== CODEX_DRIVER) {
    return yield* error("provider-unavailable", "Only native Codex conversations can be branched.");
  }
  const sourceBinding = bindingOption.value;
  const providerInstanceId = sourceBinding.providerInstanceId ?? source.modelSelection.instanceId;

  const forkThread = providerService.forkThread;
  if (forkThread === undefined) {
    return yield* error(
      "provider-unavailable",
      "This provider cannot branch native conversations.",
    );
  }
  const forked = yield* forkThread({ threadId: source.id, lastTurnId: input.lastTurnId }).pipe(
    Effect.mapError((cause) =>
      error("fork-failed", cause instanceof Error ? cause.message : "Native Codex fork failed."),
    ),
  );

  const sourceNativeThreadId =
    sourceBinding.resumeCursor !== null &&
    typeof sourceBinding.resumeCursor === "object" &&
    "threadId" in sourceBinding.resumeCursor &&
    typeof sourceBinding.resumeCursor.threadId === "string"
      ? sourceBinding.resumeCursor.threadId
      : null;
  if (
    forked.threadId.trim().length === 0 ||
    (sourceNativeThreadId !== null && forked.threadId === sourceNativeThreadId)
  ) {
    return yield* error("fork-failed", "Codex returned the source thread instead of a new fork.");
  }
  if (!forked.turns.some((turn) => turn.id === input.lastTurnId)) {
    return yield* error("turn-not-forkable", "Codex fork did not include the selected turn.");
  }

  const timestamp = DateTime.formatIso(yield* DateTime.now);
  const messages = branchMessages(forked, timestamp, input.lastTurnId);
  if (messages.length === 0) {
    return yield* error("fork-failed", "Codex fork returned no readable conversation messages.");
  }

  const childThreadId = branchThreadId(source.id, forked.threadId);

  yield* directory.upsert({
    threadId: childThreadId,
    provider: CODEX_DRIVER,
    providerInstanceId,
    status: "stopped",
    resumeCursor: { threadId: forked.threadId },
    runtimeMode: source.runtimeMode,
    runtimePayload: {
      cwd: forked.cwd,
      modelSelection: source.modelSelection,
      forkedFromId: forked.forkedFromId,
      reasoningEffort: forked.reasoningEffort,
    },
  });

  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(yield* crypto.randomUUIDv4),
    threadId: childThreadId,
    projectId: source.projectId,
    title: source.title,
    modelSelection: source.modelSelection,
    runtimeMode: source.runtimeMode,
    interactionMode: source.interactionMode,
    branch: source.branch,
    worktreePath: source.worktreePath,
    createdAt: timestamp,
    historyImport: true,
  });

  yield* engine.dispatch({
    type: "thread.history.import",
    commandId: CommandId.make(yield* crypto.randomUUIDv4),
    threadId: childThreadId,
    messages,
  });

  return {
    threadId: childThreadId,
    nativeThreadId: forked.threadId,
    forkedFromId: forked.forkedFromId,
  } satisfies ThreadBranchResult;
});
