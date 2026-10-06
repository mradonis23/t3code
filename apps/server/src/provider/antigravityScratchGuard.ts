// @effect-diagnostics nodeBuiltinImport:off - this launch-boundary guard needs filesystem capacity metadata.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { WINDOWS_ANTIGRAVITY_SCRATCH_ROOT } from "./antigravityAuthSupport.ts";

export const ANTIGRAVITY_SCRATCH_BLOCK_LAUNCH_DIRECTORIES = 8;
export const ANTIGRAVITY_SCRATCH_BLOCK_FREE_BYTES = 20 * 1024 * 1024 * 1024;
export const ANTIGRAVITY_SCRATCH_BLOCK_FREE_PERCENT = 5;

const launchIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AntigravityScratchPressure {
  readonly root: string;
  readonly freeBytes: number;
  readonly freePercent: number | null;
  readonly ownedLaunchDirectoryCount: number;
}

export function antigravityScratchBlockReason(pressure: AntigravityScratchPressure): string | null {
  if (pressure.freeBytes <= ANTIGRAVITY_SCRATCH_BLOCK_FREE_BYTES) {
    return `only ${formatGiB(pressure.freeBytes)} free remains on the runtime-scratch volume`;
  }
  if (
    pressure.freePercent !== null &&
    pressure.freePercent <= ANTIGRAVITY_SCRATCH_BLOCK_FREE_PERCENT
  ) {
    return `only ${pressure.freePercent.toFixed(1)}% free remains on the runtime-scratch volume`;
  }
  if (pressure.ownedLaunchDirectoryCount >= ANTIGRAVITY_SCRATCH_BLOCK_LAUNCH_DIRECTORIES) {
    return `${pressure.ownedLaunchDirectoryCount} T3-owned Antigravity launch directories remain under ${pressure.root}`;
  }
  return null;
}

export async function inspectWindowsAntigravityScratchPressure(
  root = WINDOWS_ANTIGRAVITY_SCRATCH_ROOT,
): Promise<AntigravityScratchPressure> {
  const volumePath = NodePath.parse(root).root || root;
  const volume = await NodeFSP.statfs(volumePath);
  const totalBytes = Number(volume.blocks) * Number(volume.bsize);
  const freeBytes = Number(volume.bavail) * Number(volume.bsize);
  const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : null;

  let ownedLaunchDirectoryCount = 0;
  try {
    const entries = await NodeFSP.readdir(root, { withFileTypes: true });
    ownedLaunchDirectoryCount = entries.filter(
      (entry) => entry.isDirectory() && launchIdPattern.test(entry.name),
    ).length;
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }

  return { root, freeBytes, freePercent, ownedLaunchDirectoryCount };
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
