import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionSource,
  AgentSessionScanError,
  isImportedAgentSessionMessageId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AgentSessionUnresumableSessionError extends Schema.TaggedErrorClass<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedErrorClass<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedErrorClass<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' changed before its history import completed.`;
  }
}

function hasImportedHistory(thread: OrchestrationThread): boolean {
  return thread.messages.some((message) => isImportedAgentSessionMessageId(message.id));
}

function hasImportBlockingActivity(
  thread: OrchestrationThread,
  importedHistoryPresent: boolean,
): boolean {
  return (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.latestTurn !== null ||
    thread.session !== null ||
    thread.messages.some((message) => !isImportedAgentSessionMessageId(message.id)) ||
    thread.proposedPlans.length > 0 ||
    thread.activities.length > 0 ||
    thread.checkpoints.length > 0 ||
    thread.snoozedUntil != null ||
    thread.snoozedAt != null ||
    thread.pinnedAt != null ||
    thread.pinOrderKey != null ||
    thread.titleRegeneration != null ||
    thread.linkedPullRequest != null ||
    thread.unsettledAt != null ||
    (importedHistoryPresent
      ? thread.settledOverride !== "settled"
      : thread.settledOverride !== null || thread.settledAt !== null)
  );
}

type ImportedHistoryAppendMessage = {
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId: TurnId;
  readonly createdAt: string;
};

function codexHistoryAppendSuffix(
  threadId: ThreadId,
  existingThread: OrchestrationThread,
  sourceThread: AgentSessionScanner.AgentSessionThread,
): ReadonlyArray<ImportedHistoryAppendMessage> | null {
  if (sourceThread.source !== "codex") return [];

  const consumedExisting = new Set<number>();
  let sawMissing = false;
  const suffix: Array<ImportedHistoryAppendMessage> = [];

  for (const [index, sourceMessage] of sourceThread.messages.entries()) {
    const importedMessageId = MessageId.make(
      String(threadId) + ":" + String(index).padStart(6, "0"),
    );
    const exactImportedIndex = existingThread.messages.findIndex(
      (message, existingIndex) =>
        !consumedExisting.has(existingIndex) &&
        message.id === importedMessageId &&
        message.role === sourceMessage.role &&
        message.text === sourceMessage.text,
    );
    const providerTurnIndex =
      exactImportedIndex >= 0 || sourceMessage.providerTurnId === undefined
        ? -1
        : existingThread.messages.findIndex(
            (message, existingIndex) =>
              !consumedExisting.has(existingIndex) &&
              message.turnId === sourceMessage.providerTurnId &&
              message.role === sourceMessage.role &&
              message.text === sourceMessage.text,
          );
    const pairedLocalUserIndex =
      exactImportedIndex >= 0 ||
      providerTurnIndex >= 0 ||
      sourceMessage.role !== "user" ||
      sourceMessage.providerTurnId === undefined
        ? -1
        : (() => {
            const nextSource = sourceThread.messages[index + 1];
            if (
              nextSource?.role !== "assistant" ||
              nextSource.providerTurnId !== sourceMessage.providerTurnId
            ) {
              return -1;
            }

            const candidates: Array<number> = [];
            for (const [existingIndex, message] of existingThread.messages.entries()) {
              if (
                consumedExisting.has(existingIndex) ||
                message.role !== "user" ||
                message.text !== sourceMessage.text ||
                message.turnId !== null
              ) {
                continue;
              }
              const nextExisting = existingThread.messages[existingIndex + 1];
              if (
                nextExisting === undefined ||
                consumedExisting.has(existingIndex + 1) ||
                nextExisting.role !== "assistant" ||
                nextExisting.turnId !== sourceMessage.providerTurnId ||
                nextExisting.text !== nextSource.text
              ) {
                continue;
              }
              candidates.push(existingIndex);
            }
            return candidates.length === 1 ? (candidates[0] ?? -1) : -1;
          })();
    const matchedIndex =
      exactImportedIndex >= 0
        ? exactImportedIndex
        : providerTurnIndex >= 0
          ? providerTurnIndex
          : pairedLocalUserIndex;

    if (matchedIndex >= 0) {
      if (sawMissing) return null;
      consumedExisting.add(matchedIndex);
      continue;
    }

    if (existingThread.messages.some((message) => message.id === importedMessageId)) {
      return null;
    }
    if (sourceMessage.providerTurnId === undefined) {
      return [];
    }

    sawMissing = true;
    suffix.push({
      messageId: importedMessageId,
      role: sourceMessage.role,
      text: sourceMessage.text,
      turnId: TurnId.make(sourceMessage.providerTurnId),
      createdAt: sourceMessage.createdAt,
    });
  }

  return suffix;
}

function bindingResumesCodexSession(
  binding: ProviderSessionDirectory.ProviderRuntimeBinding,
  providerSessionId: string,
): boolean {
  return (
    binding.provider === "codex" &&
    binding.status === "stopped" &&
    typeof binding.resumeCursor === "object" &&
    binding.resumeCursor !== null &&
    "threadId" in binding.resumeCursor &&
    binding.resumeCursor.threadId === providerSessionId
  );
}
/** Import recent transcript text and persist the cursor needed to resume its provider session. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
        onSome: Effect.succeed,
      }),
    ),
  );
  const workspaceRoot = project.workspaceRoot;
  if (
    input.expectedWorkspaceRoot !== undefined &&
    normalizeProjectPathForComparison(workspaceRoot) !==
      normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
  ) {
    return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
  }
  const completedSources = yield* snapshots
    .getImportedAgentSessionSources(input.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const threads = scanner.recentThreads(
    workspaceRoot,
    completedSources.map((entry) => entry.source),
  );
  const importedThreadIds = new Set<ThreadId>();
  let importedCount = 0;
  let skippedCount = 0;

  yield* Stream.runForEach(threads, (outcome) =>
    Effect.gen(function* () {
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        return;
      }
      if (outcome._tag === "AlreadyImported" || outcome._tag === "Duplicate") {
        const threadId = ThreadId.make(
          `import:${outcome.source.providerInstanceId}:${outcome.source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (importedThreadIds.has(threadId)) {
          const recorded = yield* directory
            .recordImportedTranscript({ threadId, source: outcome.source })
            .pipe(Effect.result);
          if (recorded._tag === "Failure") {
            skippedCount += 1;
            yield* Effect.logWarning("Could not record an imported transcript copy", {
              threadId,
              cause: recorded.failure,
            });
          }
        }
        return;
      }
      const thread = outcome.thread;
      const threadId = ThreadId.make(
        `import:${thread.providerInstanceId}:${thread.providerSessionId}`,
      );
      const imported = yield* Effect.gen(function* () {
        const provider = ProviderDriverKind.make(thread.source);
        const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
        const existingThread = yield* snapshots.getThreadDetailById(threadId);
        const existingBinding = yield* directory.getBinding(threadId);

        if (
          thread.source === "claudeAgent" &&
          !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
        ) {
          return yield* new AgentSessionUnresumableSessionError({
            source: thread.source,
            providerSessionId: thread.providerSessionId,
          });
        }

        if (Option.isSome(existingThread) && existingThread.value.projectId !== input.projectId) {
          return yield* new AgentSessionThreadProjectConflictError({
            threadId,
            expectedProjectId: input.projectId,
            actualProjectId: existingThread.value.projectId,
          });
        }

        const importedHistoryPresent = Option.isSome(existingThread)
          ? hasImportedHistory(existingThread.value)
          : false;
        if (
          Option.isSome(existingThread) &&
          importedHistoryPresent &&
          Option.isSome(existingBinding)
        ) {
          if (thread.source === "codex") {
            const suffix = codexHistoryAppendSuffix(threadId, existingThread.value, thread);
            if (suffix === null) {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            if (suffix.length > 0) {
              if (!bindingResumesCodexSession(existingBinding.value, thread.providerSessionId)) {
                return yield* new AgentSessionThreadModifiedError({ threadId });
              }
              yield* engine.dispatch({
                type: "thread.history.append",
                commandId: CommandId.make(yield* crypto.randomUUIDv4),
                threadId,
                messages: suffix,
              });
            }
          }
          yield* directory.recordImportedTranscript({ threadId, source: outcome.source });
          return true;
        }

        if (
          Option.isSome(existingThread) &&
          hasImportBlockingActivity(existingThread.value, importedHistoryPresent)
        ) {
          return yield* new AgentSessionThreadModifiedError({ threadId });
        }

        if (
          Option.isSome(existingBinding) &&
          (existingBinding.value.provider !== provider ||
            existingBinding.value.providerInstanceId !== thread.providerInstanceId ||
            existingBinding.value.status !== "stopped")
        ) {
          return yield* new AgentSessionThreadModifiedError({ threadId });
        }

        // Install the cursor before the thread becomes visible. A concurrent
        // real session can replace it, while insert-ignore keeps this import
        // from replacing that newer binding.
        if (Option.isNone(existingBinding)) {
          yield* directory.upsert(
            {
              threadId,
              provider,
              providerInstanceId: thread.providerInstanceId,
              status: "stopped",
              runtimeMode: DEFAULT_RUNTIME_MODE,
              resumeCursor:
                thread.source === "codex"
                  ? { threadId: thread.providerSessionId }
                  : { threadId, resume: thread.providerSessionId },
              runtimePayload: { cwd: workspaceRoot },
            },
            { onConflict: "ignore" },
          );
        }

        if (Option.isNone(existingThread)) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            projectId: input.projectId,
            title: thread.title,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: thread.createdAt,
            historyImport: true,
          });
        }

        if (!importedHistoryPresent) {
          yield* engine.dispatch({
            type: "thread.history.import",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            messages: thread.messages.map((message, index) => ({
              messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
              role: message.role,
              text: message.text,
              ...(message.providerTurnId ? { turnId: TurnId.make(message.providerTurnId) } : {}),
              createdAt: message.createdAt,
            })),
          });
        }

        yield* directory.recordImportedTranscript({ threadId, source: outcome.source });

        return true;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not import an agent session", {
            provider: thread.source,
            sessionId: thread.providerSessionId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

      if (imported) {
        importedThreadIds.add(threadId);
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
    }),
  );

  return { importedCount, skippedCount } satisfies AgentSessionImportResult;
});
