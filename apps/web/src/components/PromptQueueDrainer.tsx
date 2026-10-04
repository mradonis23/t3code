import { useEffect, useRef } from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { CommandId } from "@t3tools/contracts";

import { useEnvironments } from "../state/environments";
import { useAllEnvironmentShellsBootstrapped, useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { releasePersistedAttachmentUpload } from "../lib/attachmentUploadQueue";
import {
  resolvePromptQueueCreationDispatchAction,
  resolvePromptQueueDispatchAction,
  usePromptQueueStore,
  type PromptQueueEntry,
} from "../promptQueueStore";

function modelSelectionsEqual(
  left: PromptQueueEntry["modelSelection"],
  right: PromptQueueEntry["modelSelection"],
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}
export function PromptQueueDrainer() {
  const entries = usePromptQueueStore((state) => state.entries);
  const updateEntry = usePromptQueueStore((state) => state.updateEntry);
  const removeEntry = usePromptQueueStore((state) => state.removeEntry);
  const { environments } = useEnvironments();
  const threadShells = useThreadShells();
  const allEnvironmentShellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const dispatchingIdsRef = useRef(new Set<string>());

  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  useEffect(() => {
    let cancelled = false;

    const releaseEntryFiles = (entry: PromptQueueEntry) => {
      for (const file of entry.files) {
        releasePersistedAttachmentUpload({
          id: file.id,
          environmentId: entry.environmentId,
          attachmentId: file.attachmentId,
        });
      }
    };

    const dispatchEntry = async (entry: PromptQueueEntry) => {
      const thread = threadShells.find(
        (candidate) =>
          candidate.environmentId === entry.environmentId && candidate.id === entry.threadId,
      );
      const environment = environments.find(
        (candidate) => candidate.environmentId === entry.environmentId,
      );
      if (!environment) return;
      const connected = environment.connection.phase === "connected";
      if (entry.creation !== undefined) {
        const creationAction = resolvePromptQueueCreationDispatchAction({
          entry,
          connected,
          shellBootstrapped: allEnvironmentShellsBootstrapped,
          threadExists: thread !== undefined,
        });
        if (creationAction === "remove") {
          if (!cancelled && removeEntry(entry.id)) releaseEntryFiles(entry);
          return;
        }
        if (creationAction !== "send") return;
      } else {
        if (!thread) return;
        const threadBusy =
          thread.session?.status === "running" ||
          thread.session?.status === "starting" ||
          thread.latestTurn?.state === "running";
        const action = resolvePromptQueueDispatchAction({
          entry,
          connected,
          threadBusy,
          latestTurnState: thread.latestTurn?.state ?? null,
          latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
        });
        if (action !== "send") return;
      }
      if (dispatchingIdsRef.current.has(entry.id)) return;

      dispatchingIdsRef.current.add(entry.id);
      const pause = () => {
        updateEntry(entry.id, { deliveryMode: "paused" });
      };

      try {
        if (thread !== undefined) {
          if (!modelSelectionsEqual(entry.modelSelection, thread.modelSelection)) {
            const result = await updateThreadMetadata({
              environmentId: entry.environmentId,
              input: {
                commandId: CommandId.make(`${entry.commandId}:model-selection`),
                threadId: entry.threadId,
                modelSelection: entry.modelSelection,
              },
            });
            if (AsyncResult.isFailure(result)) {
              pause();
              return;
            }
          }
          if (entry.runtimeMode !== thread.runtimeMode) {
            const result = await setThreadRuntimeMode({
              environmentId: entry.environmentId,
              input: {
                commandId: CommandId.make(`${entry.commandId}:runtime-mode`),
                threadId: entry.threadId,
                runtimeMode: entry.runtimeMode,
                createdAt: entry.createdAt,
              },
            });
            if (AsyncResult.isFailure(result)) {
              pause();
              return;
            }
          }
          if (entry.interactionMode !== thread.interactionMode) {
            const result = await setThreadInteractionMode({
              environmentId: entry.environmentId,
              input: {
                commandId: CommandId.make(`${entry.commandId}:interaction-mode`),
                threadId: entry.threadId,
                interactionMode: entry.interactionMode,
                createdAt: entry.createdAt,
              },
            });
            if (AsyncResult.isFailure(result)) {
              pause();
              return;
            }
          }
        }

        const attachments = [
          ...entry.images.map((image) => ({
            type: "image" as const,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: image.dataUrl,
          })),
          ...entry.files.map((file) => ({
            type: "file" as const,
            id: file.attachmentId,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
          })),
        ];
        const creation = entry.creation;
        const result = await startThreadTurn({
          environmentId: entry.environmentId,
          input: {
            commandId: entry.commandId,
            threadId: entry.threadId,
            message: {
              messageId: entry.messageId,
              role: "user",
              text: entry.text,
              attachments,
            },
            modelSelection: entry.modelSelection,
            ...(creation ? { titleSeed: creation.title } : {}),
            runtimeMode: entry.runtimeMode,
            interactionMode: entry.interactionMode,
            ...(creation
              ? {
                  bootstrap: {
                    createThread: {
                      projectId: creation.projectId,
                      title: creation.title,
                      modelSelection: entry.modelSelection,
                      runtimeMode: entry.runtimeMode,
                      interactionMode: entry.interactionMode,
                      branch: creation.branch,
                      worktreePath: creation.worktreePath,
                      createdAt: creation.threadCreatedAt,
                    },
                    ...(creation.prepareWorktree
                      ? {
                          prepareWorktree: creation.prepareWorktree,
                          runSetupScript: true,
                        }
                      : {}),
                  },
                }
              : {}),
            createdAt: entry.createdAt,
          },
        });
        if (AsyncResult.isFailure(result)) {
          pause();
          return;
        }

        if (!cancelled && removeEntry(entry.id)) releaseEntryFiles(entry);
      } catch (error) {
        console.warn("[PROMPT-QUEUE] queued desktop prompt delivery failed", error);
        pause();
      } finally {
        dispatchingIdsRef.current.delete(entry.id);
      }
    };

    for (const entry of entries) {
      void dispatchEntry(entry);
    }
    return () => {
      cancelled = true;
    };
  }, [
    allEnvironmentShellsBootstrapped,
    entries,
    environments,
    removeEntry,
    setThreadInteractionMode,
    setThreadRuntimeMode,
    startThreadTurn,
    threadShells,
    updateEntry,
    updateThreadMetadata,
  ]);

  return null;
}
