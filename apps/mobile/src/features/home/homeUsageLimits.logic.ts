import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

export interface HomeLimitEntry {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
}

export function selectActiveHomeLimitEntry(input: {
  readonly entries: ReadonlyArray<HomeLimitEntry>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly stickyProviderInstanceId: ProviderInstanceId | null;
}): HomeLimitEntry | null {
  const runningEntry =
    [...input.threads]
      .filter(
        (thread) => thread.session?.status === "running" || thread.session?.status === "starting",
      )
      .sort(
        (left, right) =>
          Date.parse(right.session?.updatedAt ?? right.updatedAt ?? right.createdAt) -
          Date.parse(left.session?.updatedAt ?? left.updatedAt ?? left.createdAt),
      )
      .flatMap((thread) => {
        const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
        const entry = input.entries.find(
          ({ environmentId, provider }) =>
            environmentId === thread.environmentId && provider.instanceId === instanceId,
        );
        return entry ? [entry] : [];
      })[0] ?? null;

  if (runningEntry) return runningEntry;

  if (input.stickyProviderInstanceId) {
    const selectedEnvironmentEntry =
      input.selectedEnvironmentId === null
        ? null
        : (input.entries.find(
            ({ environmentId, provider }) =>
              environmentId === input.selectedEnvironmentId &&
              provider.instanceId === input.stickyProviderInstanceId,
          ) ?? null);
    if (selectedEnvironmentEntry) return selectedEnvironmentEntry;

    const stickyEntry =
      input.entries.find(
        ({ provider }) => provider.instanceId === input.stickyProviderInstanceId,
      ) ?? null;
    if (stickyEntry) return stickyEntry;
  }

  return (
    input.entries.find(({ provider }) => provider.instanceId === "codex") ??
    input.entries[0] ??
    null
  );
}
