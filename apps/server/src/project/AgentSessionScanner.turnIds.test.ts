import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { parseAgentSessionTranscript } from "./AgentSessionScanner.ts";

it("preserves native Codex turn ids on imported visible messages", () => {
  const thread = parseAgentSessionTranscript({
    contents: [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-session" } }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "Fix the actual bug" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          content: [{ type: "input_text", text: "Fix the actual bug" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Fixed" }],
        },
      }),
    ].join("\n"),
    source: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    fallbackSessionId: "fallback",
    lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
  });

  expect(thread?.messages).toMatchObject([
    { role: "user", text: "Fix the actual bug", providerTurnId: "turn-1" },
    { role: "assistant", text: "Fixed", providerTurnId: "turn-1" },
  ]);
});
