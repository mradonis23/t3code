import { describe, expect, it } from "@effect/vitest";
import { MessageId, ThreadId, TurnId, type OrchestrationThread } from "@t3tools/contracts";

import type { ProviderThreadSnapshot } from "../provider/Services/ProviderAdapter.ts";
import { resolveHistoricalBranchBoundaries } from "./ThreadBranchService.ts";

describe("resolveHistoricalBranchBoundaries", () => {
  it("keeps stored turn ids and recovers only unambiguous assistant boundaries", () => {
    const storedTurnId = TurnId.make("turn-stored");
    const source = {
      id: ThreadId.make("thread-source"),
      messages: [
        {
          id: MessageId.make("message-unique"),
          role: "assistant",
          text: "Unique answer",
          turnId: null,
        },
        {
          id: MessageId.make("message-duplicate-a"),
          role: "assistant",
          text: "Repeated answer",
          turnId: null,
        },
        {
          id: MessageId.make("message-duplicate-b"),
          role: "assistant",
          text: "Repeated answer",
          turnId: null,
        },
        {
          id: MessageId.make("message-stored"),
          role: "assistant",
          text: "Already identified",
          turnId: storedTurnId,
        },
      ],
    } as unknown as OrchestrationThread;

    const native = {
      threadId: ThreadId.make("thread-native"),
      turns: [
        {
          id: TurnId.make("turn-unique"),
          items: [{ type: "agentMessage", text: "Unique answer" }],
          startedAt: null,
          completedAt: null,
          status: "completed",
          error: null,
        },
        {
          id: TurnId.make("turn-repeat-a"),
          items: [{ type: "agentMessage", text: "Repeated answer" }],
          startedAt: null,
          completedAt: null,
          status: "completed",
          error: null,
        },
        {
          id: TurnId.make("turn-repeat-b"),
          items: [{ type: "agentMessage", text: "Repeated answer" }],
          startedAt: null,
          completedAt: null,
          status: "completed",
          error: null,
        },
      ],
    } satisfies ProviderThreadSnapshot;

    expect(resolveHistoricalBranchBoundaries(source, native)).toEqual([
      { messageId: MessageId.make("message-stored"), turnId: storedTurnId },
      { messageId: MessageId.make("message-unique"), turnId: TurnId.make("turn-unique") },
    ]);
  });
});
