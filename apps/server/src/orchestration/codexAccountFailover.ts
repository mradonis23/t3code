import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

const EXPLICIT_USAGE_LIMIT_PATTERN =
  /\busage\s+(?:limit|cap)\b|\bquota\b.{0,80}\b(?:exhausted|reached|used\s+up)\b|\b(?:exhausted|reached)\b.{0,80}\bquota\b/iu;
const GENERIC_RATE_LIMIT_PATTERN =
  /\brate\s+limit(?:ed)?\b|\brate\s+limit\s+(?:reached|exceeded)\b/iu;

const remainingPercent = (usedPercent: number): number =>
  Math.max(0, Math.min(100, 100 - usedPercent));

export function providerHasUsableCodexCapacity(provider: ServerProvider): boolean {
  if (
    provider.driver !== "codex" ||
    !provider.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status === "error" ||
    provider.status === "disabled" ||
    provider.auth.status !== "authenticated"
  ) {
    return false;
  }
  const limits = provider.usageLimits;
  if (!limits || limits.unavailable || limits.windows.length === 0) {
    return false;
  }
  return limits.windows.every((window) => remainingPercent(window.usedPercent) > 0);
}

export function providerLooksExhausted(provider: ServerProvider | undefined): boolean {
  const windows = provider?.usageLimits?.windows ?? [];
  return windows.some((window) => remainingPercent(window.usedPercent) <= 0.5);
}

export function isCodexUsageExhaustionMessage(
  message: string | null | undefined,
  currentProvider?: ServerProvider,
): boolean {
  const normalized = message?.trim() ?? "";
  if (!normalized) return false;
  if (EXPLICIT_USAGE_LIMIT_PATTERN.test(normalized)) return true;
  return GENERIC_RATE_LIMIT_PATTERN.test(normalized) && providerLooksExhausted(currentProvider);
}

function modelIsSupported(provider: ServerProvider, selection: ModelSelection): boolean {
  if (provider.models.length === 0) return true;
  return provider.models.some((model) => model.slug === selection.model);
}

function capacityScore(provider: ServerProvider): { bottleneck: number; average: number } {
  const windows = provider.usageLimits?.windows ?? [];
  if (windows.length === 0) return { bottleneck: 0, average: 0 };
  const remaining = windows.map((window) => remainingPercent(window.usedPercent));
  return {
    bottleneck: Math.min(...remaining),
    average: remaining.reduce((sum, value) => sum + value, 0) / remaining.length,
  };
}

const TIE_BREAK_ORDER = new Map<string, number>([
  ["codex", 0],
  ["codex_mom", 1],
  ["codex_nena", 2],
]);

export function selectCodexFailoverProvider(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly blockedInstanceIds?: ReadonlySet<string>;
}): ServerProvider | null {
  const candidates = input.providers
    .filter((provider) => provider.instanceId !== input.currentInstanceId)
    .filter((provider) => !input.blockedInstanceIds?.has(String(provider.instanceId)))
    .filter(providerHasUsableCodexCapacity)
    .filter((provider) => modelIsSupported(provider, input.modelSelection))
    .map((provider) => ({ provider, ...capacityScore(provider) }))
    .sort(
      (left, right) =>
        right.bottleneck - left.bottleneck ||
        right.average - left.average ||
        (TIE_BREAK_ORDER.get(String(left.provider.instanceId)) ?? Number.MAX_SAFE_INTEGER) -
          (TIE_BREAK_ORDER.get(String(right.provider.instanceId)) ?? Number.MAX_SAFE_INTEGER) ||
        String(left.provider.instanceId).localeCompare(String(right.provider.instanceId)),
    );

  return candidates[0]?.provider ?? null;
}

export function exhaustedProviderRetryAfterMs(
  provider: ServerProvider | undefined,
  nowMs: number,
): number {
  const resetTimes = (provider?.usageLimits?.windows ?? [])
    .filter((window) => remainingPercent(window.usedPercent) <= 0.5 && window.resetsAt)
    .map((window) => Date.parse(window.resetsAt!))
    .filter((value) => Number.isFinite(value) && value > nowMs)
    .sort((left, right) => left - right);

  return resetTimes[0] ?? nowMs + 60 * 60 * 1000;
}
