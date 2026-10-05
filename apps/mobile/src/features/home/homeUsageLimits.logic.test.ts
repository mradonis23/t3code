import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectActiveHomeLimitEntry, type HomeLimitEntry } from "./homeUsageLimits.logic.ts";

const environmentId = EnvironmentId.make("rad-media");

function entry(instanceId: string): HomeLimitEntry {
  return {
    environmentId,
    provider: {
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("codex"),
    } as ServerProvider,
  };
}

describe("home usage limits active account", () => {
  it("follows the sticky composer account when no thread is running", () => {
    const dad = entry("codex");
    const mom = entry("codex_mom");
    const nena = entry("codex_nena");

    expect(
      selectActiveHomeLimitEntry({
        entries: [dad, mom, nena],
        threads: [],
        selectedEnvironmentId: environmentId,
        stickyProviderInstanceId: mom.provider.instanceId,
      }),
    ).toBe(mom);
  });

  it("prefers the actual running thread provider over the sticky composer account", () => {
    const dad = entry("codex");
    const mom = entry("codex_mom");
    const nena = entry("codex_nena");
    const running = {
      environmentId,
      createdAt: "2026-10-05T20:00:00.000Z",
      updatedAt: "2026-10-05T20:00:00.000Z",
      modelSelection: { instanceId: nena.provider.instanceId, model: "gpt-5.6-sol" },
      session: {
        status: "running",
        providerInstanceId: nena.provider.instanceId,
        updatedAt: "2026-10-05T20:01:00.000Z",
      },
    } as unknown as EnvironmentThreadShell;

    expect(
      selectActiveHomeLimitEntry({
        entries: [dad, mom, nena],
        threads: [running],
        selectedEnvironmentId: environmentId,
        stickyProviderInstanceId: mom.provider.instanceId,
      }),
    ).toBe(nena);
  });
});
