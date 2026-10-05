import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { projectThreadAwareness, type AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import * as Notifications from "expo-notifications";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import { useProjects, useThreadShells } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import { androidAttentionNotificationForTransition } from "./androidAttentionNotifications.logic";

const CHANNEL_ID = "default";

function awarenessStates(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): Map<string, AgentAwarenessState | null> {
  const projectsByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  return new Map(
    threads.map((thread) => {
      const key = `${thread.environmentId}:${thread.id}`;
      const project = projectsByKey.get(`${thread.environmentId}:${thread.projectId}`);
      return [
        key,
        project
          ? projectThreadAwareness({ environmentId: thread.environmentId, project, thread })
          : null,
      ] as const;
    }),
  );
}

/** Emits local Android alerts from the same authoritative shell transitions used by T3 Connect. */
export function useAndroidAttentionNotifications(): void {
  const projects = useProjects();
  const threads = useThreadShells();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const previousByThreadKeyRef = useRef<Map<string, AgentAwarenessState | null> | null>(null);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.attentionNotificationsEnabled === true;

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const currentByThreadKey = awarenessStates(projects, threads);
    const previousByThreadKey = previousByThreadKeyRef.current;
    previousByThreadKeyRef.current = currentByThreadKey;
    if (!enabled || previousByThreadKey === null) return;

    for (const [threadKey, current] of currentByThreadKey) {
      const notification = androidAttentionNotificationForTransition(
        previousByThreadKey.get(threadKey) ?? null,
        current,
      );
      if (!notification) continue;
      void Notifications.scheduleNotificationAsync({
        content: {
          title: notification.title,
          body: notification.body,
          data: notification.data,
          sound: "default",
        },
        trigger: null,
      }).catch((error: unknown) => {
        console.warn("[agent-awareness] failed to schedule Android attention notification", error);
      });
    }
  }, [enabled, projects, threads]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    void Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Agent attention",
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 180],
    }).catch((error: unknown) => {
      console.warn("[agent-awareness] failed to configure Android notification channel", error);
    });
  }, []);
}
