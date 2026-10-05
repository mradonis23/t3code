import * as Schema from "effect/Schema";

import { MessageId, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";

export const ThreadBranchErrorCode = Schema.Literals([
  "thread-not-found",
  "provider-unavailable",
  "turn-not-forkable",
  "fork-failed",
]);
export type ThreadBranchErrorCode = typeof ThreadBranchErrorCode.Type;

export class ThreadBranchError extends Schema.TaggedErrorClass<ThreadBranchError>()(
  "ThreadBranchError",
  {
    code: ThreadBranchErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}

export const ThreadBranchBoundariesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadBranchBoundariesInput = typeof ThreadBranchBoundariesInput.Type;

export const ThreadBranchBoundary = Schema.Struct({
  messageId: MessageId,
  turnId: TurnId,
});
export type ThreadBranchBoundary = typeof ThreadBranchBoundary.Type;

export const ThreadBranchBoundariesResult = Schema.Struct({
  boundaries: Schema.Array(ThreadBranchBoundary),
});
export type ThreadBranchBoundariesResult = typeof ThreadBranchBoundariesResult.Type;

export const ThreadBranchInput = Schema.Struct({
  threadId: ThreadId,
  lastTurnId: TurnId,
});
export type ThreadBranchInput = typeof ThreadBranchInput.Type;

export const ThreadBranchResult = Schema.Struct({
  threadId: ThreadId,
  nativeThreadId: TrimmedNonEmptyString,
  forkedFromId: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadBranchResult = typeof ThreadBranchResult.Type;
