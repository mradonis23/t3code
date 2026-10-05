import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { androidAttentionNotificationForTransition } from "./androidAttentionNotifications.logic";

function state(phase: AgentAwarenessState["phase"], detail?: string): AgentAwarenessState {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    projectTitle: "T3 Code",
    threadTitle: "Gate 1",
    phase,
    headline: phase,
    ...(detail ? { detail } : {}),
    modelTitle: "gpt-5",
    updatedAt: "2026-09-09T12:00:00.000Z",
    deepLink: "/threads/environment-1/thread-1",
  };
}

describe("Android attention notifications", () => {
  it.each([
    ["completed", undefined, "Turn completed"],
    ["failed", "Provider failed.", "Turn failed"],
    ["failed", "Usage limit reached.", "Usage limit reached"],
    ["waiting_for_input", undefined, "Needs input"],
  ] as const)("emits meaningful %s transitions", (phase, detail, title) => {
    expect(
      androidAttentionNotificationForTransition(state("running"), state(phase, detail)),
    ).toEqual({
      title,
      body: "Gate 1",
      data: {
        environmentId: "environment-1",
        threadId: "thread-1",
        deepLink: "/threads/environment-1/thread-1",
      },
    });
  });

  it("does not notify for ordinary working updates or hydrated terminal state", () => {
    expect(
      androidAttentionNotificationForTransition(state("running"), state("running")),
    ).toBeNull();
    expect(androidAttentionNotificationForTransition(null, state("completed"))).toBeNull();
  });
});
