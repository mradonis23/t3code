import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";

export interface AndroidAttentionNotification {
  readonly title: string;
  readonly body: string;
  readonly data: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly deepLink: string;
  };
}

export function androidAttentionNotificationForTransition(
  previous: AgentAwarenessState | null,
  current: AgentAwarenessState | null,
): AndroidAttentionNotification | null {
  if (!previous || !current || previous.phase === current.phase) return null;

  const wasWorking = previous.phase === "starting" || previous.phase === "running";
  if (!wasWorking) return null;

  let title: string;
  switch (current.phase) {
    case "completed":
      title = "Turn completed";
      break;
    case "waiting_for_input":
      title = "Needs input";
      break;
    case "waiting_for_approval":
      title = "Approval needed";
      break;
    case "failed":
      title = current.detail?.toLocaleLowerCase().includes("usage limit")
        ? "Usage limit reached"
        : "Turn failed";
      break;
    default:
      return null;
  }

  return {
    title,
    body: current.threadTitle,
    data: {
      environmentId: current.environmentId,
      threadId: current.threadId,
      deepLink: current.deepLink,
    },
  };
}
