import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { nativeSessionIdFromCursor } from "../diagnostics/OperationalDiagnostics.ts";
import { importRecentAgentThreads } from "./AgentSessionImporter.ts";

const MAX_THREADS_PER_PASS = 50;
const MAX_PROJECTS_PER_PASS = 4;

/** Revisit only recorded imports whose exact native binding is safely stopped. */
export const makeReconcile = Effect.fn("NativeHistoryReconciler.makeReconcile")(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  let offset = 0;

  return Effect.gen(function* () {
    const bindings = yield* directory.listBindings();
    const shell = yield* snapshots.getShellSnapshot();
    const byId = new Map(shell.threads.map((thread) => [thread.id, thread]));
    const eligible = bindings.filter((binding) => {
      const thread = byId.get(binding.threadId);
      const nativeId = nativeSessionIdFromCursor(binding.provider, binding.resumeCursor);
      // Other import formats have no safe append path yet. Preserve that boundary.
      return (
        binding.provider === "codex" &&
        binding.status === "stopped" &&
        binding.providerInstanceId !== undefined &&
        nativeId !== null &&
        binding.threadId === `import:${binding.providerInstanceId}:${nativeId}` &&
        thread !== undefined &&
        thread.archivedAt === null &&
        (thread.session === null || thread.session.status === "stopped") &&
        !thread.hasPendingApprovals &&
        !thread.hasPendingUserInput
      );
    });
    const groups = new Map<ProjectId, Set<ThreadId>>();
    let selectedCount = 0;
    for (let i = 0; i < Math.min(eligible.length, MAX_THREADS_PER_PASS); i++) {
      const binding = eligible[(offset + i) % eligible.length]!;
      const thread = byId.get(binding.threadId)!;
      if (!groups.has(thread.projectId) && groups.size >= MAX_PROJECTS_PER_PASS) break;
      const ids = groups.get(thread.projectId) ?? new Set<ThreadId>();
      ids.add(thread.id);
      groups.set(thread.projectId, ids);
      selectedCount += 1;
    }
    offset = eligible.length === 0 ? 0 : (offset + selectedCount) % eligible.length;
    for (const [projectId, reconcileThreadIds] of groups) {
      const project = shell.projects.find((entry) => entry.id === projectId);
      if (project === undefined) continue;
      yield* importRecentAgentThreads(
        { projectId, expectedWorkspaceRoot: project.workspaceRoot },
        { reconcileThreadIds },
      ).pipe(
        Effect.timeout("15 seconds"),
        Effect.catch((cause) =>
          Effect.logWarning("Native history reconciliation skipped a project", {
            projectId,
            cause,
          }),
        ),
      );
    }
  });
});

/** Delay the first pass and keep the worker scoped so startup/shutdown never await a scan. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reconcile = yield* makeReconcile();
    const startup = yield* ServerRuntimeStartup;
    const worker = Effect.forever(
      Effect.sleep("60 seconds").pipe(
        Effect.andThen(
          reconcile.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Native history reconciliation failed", { cause }),
            ),
          ),
        ),
      ),
    );
    yield* startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(worker), Effect.forkScoped);
  }),
);
