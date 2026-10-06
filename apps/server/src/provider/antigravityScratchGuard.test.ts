// @effect-diagnostics nodeBuiltinImport:off - verifies the real filesystem pressure probe in a disposable directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  ANTIGRAVITY_SCRATCH_BLOCK_FREE_BYTES,
  ANTIGRAVITY_SCRATCH_BLOCK_FREE_PERCENT,
  ANTIGRAVITY_SCRATCH_BLOCK_LAUNCH_DIRECTORIES,
  antigravityScratchBlockReason,
  inspectWindowsAntigravityScratchPressure,
} from "./antigravityScratchGuard.ts";

describe("Antigravity runtime-scratch guard", () => {
  it("allows a healthy scratch volume and owned launch count", () => {
    expect(
      antigravityScratchBlockReason({
        root: "F:\\RuntimeScratch\\T3\\antigravity",
        freeBytes: ANTIGRAVITY_SCRATCH_BLOCK_FREE_BYTES + 1,
        freePercent: ANTIGRAVITY_SCRATCH_BLOCK_FREE_PERCENT + 1,
        ownedLaunchDirectoryCount: ANTIGRAVITY_SCRATCH_BLOCK_LAUNCH_DIRECTORIES - 1,
      }),
    ).toBeNull();
  });

  it("blocks before free bytes can reach the emergency floor", () => {
    expect(
      antigravityScratchBlockReason({
        root: "F:\\RuntimeScratch\\T3\\antigravity",
        freeBytes: ANTIGRAVITY_SCRATCH_BLOCK_FREE_BYTES,
        freePercent: 50,
        ownedLaunchDirectoryCount: 0,
      }),
    ).toContain("free remains");
  });

  it("blocks a critically full volume even when the byte floor is not reached", () => {
    expect(
      antigravityScratchBlockReason({
        root: "F:\\RuntimeScratch\\T3\\antigravity",
        freeBytes: ANTIGRAVITY_SCRATCH_BLOCK_FREE_BYTES * 2,
        freePercent: ANTIGRAVITY_SCRATCH_BLOCK_FREE_PERCENT,
        ownedLaunchDirectoryCount: 0,
      }),
    ).toContain(ANTIGRAVITY_SCRATCH_BLOCK_FREE_PERCENT.toFixed(1) + "% free");
  });

  it("blocks repeated owned launch-directory accumulation before it can snowball", () => {
    expect(
      antigravityScratchBlockReason({
        root: "F:\\RuntimeScratch\\T3\\antigravity",
        freeBytes: ANTIGRAVITY_SCRATCH_BLOCK_FREE_BYTES * 2,
        freePercent: 50,
        ownedLaunchDirectoryCount: ANTIGRAVITY_SCRATCH_BLOCK_LAUNCH_DIRECTORIES,
      }),
    ).toContain(String(ANTIGRAVITY_SCRATCH_BLOCK_LAUNCH_DIRECTORIES) + " T3-owned");
  });

  it("counts only UUID-v4 launch directories in the inspected root", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-scratch-guard-"));
    try {
      await NodeFSP.mkdir(NodePath.join(root, "123e4567-e89b-42d3-a456-426614174000"));
      await NodeFSP.mkdir(NodePath.join(root, "123e4567-e89b-42d3-a456-426614174001"));
      await NodeFSP.mkdir(NodePath.join(root, "_MEI12345"));
      await NodeFSP.mkdir(NodePath.join(root, "not-owned"));

      const pressure = await inspectWindowsAntigravityScratchPressure(root);
      expect(pressure.root).toBe(root);
      expect(pressure.freeBytes).toBeGreaterThan(0);
      expect(pressure.ownedLaunchDirectoryCount).toBe(2);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
