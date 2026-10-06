// @effect-diagnostics nodeBuiltinImport:off - Operational diagnostics inspect filesystem metadata without mutating it.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ServerOperationalDiagnosticsResult } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SessionStore } from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import { WINDOWS_ANTIGRAVITY_SCRATCH_ROOT } from "../provider/antigravityAuthSupport.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";

const SCRATCH_SCAN_ENTRY_LIMIT = 2_000;
const DISK_WARNING_FREE_PERCENT = 10;
const DISK_CRITICAL_FREE_PERCENT = 5;
const SCRATCH_WARNING_LAUNCH_DIRECTORIES = 8;
const SCRATCH_CRITICAL_LAUNCH_DIRECTORIES = 24;
const windowsLaunchIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{12}$/iu;

type StorageStatus = ServerOperationalDiagnosticsResult["disk"]["status"];

function storageStatusFromFreePercent(freePercent: number | null): StorageStatus {
  if (freePercent === null) return "unavailable";
  if (freePercent <= DISK_CRITICAL_FREE_PERCENT) return "critical";
  if (freePercent <= DISK_WARNING_FREE_PERCENT) return "warning";
  return "ok";
}

function scratchStatusFromCount(count: number, scanTruncated: boolean): StorageStatus {
  if (count >= SCRATCH_CRITICAL_LAUNCH_DIRECTORIES) return "critical";
  if (scanTruncated || count >= SCRATCH_WARNING_LAUNCH_DIRECTORIES) return "warning";
  return "ok";
}

export function nativeSessionIdFromCursor(provider: string, cursor: unknown): string | null {
  if (!Predicate.isObject(cursor)) return null;
  // Claude's threadId is T3's id; its native UUID lives in resume.
  const keys =
    provider === "claudeAgent"
      ? ["resume"]
      : provider === "codex"
        ? ["threadId"]
        : ["cursor", "grok", "opencode", "antigravity"].includes(provider)
          ? ["sessionId"]
          : [];
  for (const key of keys) {
    const value = Reflect.get(cursor, key);
    if (Predicate.isString(value) && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function lastNativeSynchronizationFromPayload(
  runtimePayload: unknown,
  nativeSessionId: string | null,
): string | null {
  if (nativeSessionId === null || !Predicate.isObject(runtimePayload)) return null;
  const importedTranscripts = Reflect.get(runtimePayload, "importedTranscripts");
  if (!Array.isArray(importedTranscripts)) return null;

  let latestMtimeMs: number | null = null;
  for (const source of importedTranscripts) {
    if (!Predicate.isObject(source)) continue;
    if (Reflect.get(source, "providerSessionId") !== nativeSessionId) continue;
    const mtimeMs = Reflect.get(source, "mtimeMs");
    if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs) || mtimeMs < 0) continue;
    latestMtimeMs = latestMtimeMs === null ? mtimeMs : Math.max(latestMtimeMs, mtimeMs);
  }
  return latestMtimeMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(latestMtimeMs));
}

async function sampleDirectory(
  root: string,
  signal: AbortSignal,
): Promise<{
  readonly launchDirectoryCount: number;
  readonly meiDirectoryCount: number;
  readonly sampledBytes: number;
  readonly scanTruncated: boolean;
}> {
  // An absent/unreadable scratch root is unavailable, never a clean bill of health.
  await NodeFSP.access(root);
  let launchDirectoryCount = 0;
  let meiDirectoryCount = 0;
  let sampledBytes = 0;
  let visited = 0;
  const pending = [root];

  while (pending.length > 0 && visited < SCRATCH_SCAN_ENTRY_LIMIT) {
    signal.throwIfAborted();
    const current = pending.pop();
    if (current === undefined) break;
    let directory: import("node:fs").Dir;
    try {
      directory = await NodeFSP.opendir(current);
    } catch {
      throw new Error("Scratch directory could not be sampled");
    }
    for await (const entry of directory) {
      signal.throwIfAborted();
      visited += 1;
      if (visited > SCRATCH_SCAN_ENTRY_LIMIT) break;
      const fullPath = NodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        if (current === root && windowsLaunchIdPattern.test(entry.name)) launchDirectoryCount += 1;
        if (entry.name.startsWith("_MEI")) meiDirectoryCount += 1;
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await NodeFSP.stat(fullPath);
        sampledBytes += stat.size;
      } catch {
        throw new Error("Scratch file metadata could not be sampled");
      }
    }
  }

  return {
    launchDirectoryCount,
    meiDirectoryCount,
    sampledBytes,
    scanTruncated: pending.length > 0 || visited >= SCRATCH_SCAN_ENTRY_LIMIT,
  };
}

async function latestBackup(
  directory: string,
  signal: AbortSignal,
): Promise<{
  readonly path: string | null;
  readonly modifiedAt: string | null;
  readonly scanTruncated: boolean;
}> {
  try {
    const candidates: Array<{ path: string; modifiedMs: number }> = [];
    const entries = await NodeFSP.opendir(directory);
    let visited = 0;
    let scanTruncated = false;
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (++visited > SCRATCH_SCAN_ENTRY_LIMIT) {
        scanTruncated = true;
        break;
      }
      if (!entry.isFile() || !/\.(sqlite(?:3)?|db|zip|tar|gz|bak)$/iu.test(entry.name)) continue;
      try {
        const path = NodePath.join(directory, entry.name);
        const stat = await NodeFSP.stat(path);
        candidates.push({ path, modifiedMs: stat.mtimeMs });
      } catch {}
    }
    const latest = candidates
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .toSorted((left, right) => right.modifiedMs - left.modifiedMs)[0];
    return latest
      ? {
          path: latest.path,
          modifiedAt: DateTime.formatIso(DateTime.makeUnsafe(latest.modifiedMs)),
          scanTruncated,
        }
      : { path: null, modifiedAt: null, scanTruncated };
  } catch {
    return { path: null, modifiedAt: null, scanTruncated: false };
  }
}

export class OperationalDiagnostics extends Context.Service<
  OperationalDiagnostics,
  { readonly read: Effect.Effect<ServerOperationalDiagnosticsResult> }
>()("t3/diagnostics/OperationalDiagnostics") {}

export const make = Effect.fn("OperationalDiagnostics.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sessions = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const clients = yield* SessionStore;
  const sql = yield* SqlClient.SqlClient;

  const read = Effect.gen(function* () {
    const readAt = DateTime.formatIso(yield* DateTime.now);
    const scratchRoot =
      environment.T3CODE_RUNTIME_SCRATCH_DIR?.trim() ||
      (platform === "win32"
        ? WINDOWS_ANTIGRAVITY_SCRATCH_ROOT
        : NodePath.join(config.baseDir, "runtime-scratch"));
    const discoveredBackupDirectory = NodePath.join(config.baseDir, "backups");
    const backupDirectory =
      environment.T3CODE_BACKUP_DIR?.trim() ||
      (yield* Effect.tryPromise(() => NodeFSP.access(discoveredBackupDirectory)).pipe(
        Effect.timeout("5 seconds"),
        Effect.as(discoveredBackupDirectory),
        Effect.orElseSucceed(() => null),
      ));
    const queryStatus = yield* sql`SELECT 1`.pipe(
      Effect.timeout("5 seconds"),
      Effect.as("ok" as const),
      Effect.orElseSucceed(() => "unavailable" as const),
    );

    const database = yield* Effect.tryPromise(async () => {
      const stat = await NodeFSP.stat(config.dbPath);
      return {
        path: config.dbPath,
        status:
          queryStatus === "ok" && stat.isFile() && stat.size > 0
            ? ("ok" as const)
            : ("warning" as const),
        queryStatus,
        sizeBytes: stat.size,
        modifiedAt: DateTime.formatIso(DateTime.makeUnsafe(stat.mtimeMs)),
      };
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => ({
        path: config.dbPath,
        status: "unavailable" as const,
        queryStatus,
        sizeBytes: null,
        modifiedAt: null,
      })),
    );

    const disk = yield* Effect.tryPromise(async () => {
      const stat = await NodeFSP.statfs(config.baseDir);
      const totalBytes = Number(stat.blocks) * Number(stat.bsize);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : null;
      return {
        path: NodePath.parse(config.baseDir).root || config.baseDir,
        status: storageStatusFromFreePercent(freePercent),
        totalBytes,
        freeBytes,
        freePercent,
      };
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => ({
        path: NodePath.parse(config.baseDir).root || config.baseDir,
        status: "unavailable" as const,
        totalBytes: null,
        freeBytes: null,
        freePercent: null,
      })),
    );

    const runtimeScratch = yield* Effect.tryPromise((signal) =>
      sampleDirectory(scratchRoot, signal),
    ).pipe(
      Effect.timeout("5 seconds"),
      Effect.map((sample) => ({
        path: scratchRoot,
        status: scratchStatusFromCount(
          Math.max(sample.launchDirectoryCount, sample.meiDirectoryCount),
          sample.scanTruncated,
        ),
        ...sample,
      })),
      Effect.orElseSucceed(() => ({
        path: scratchRoot,
        status: "unavailable" as const,
        launchDirectoryCount: 0,
        meiDirectoryCount: 0,
        sampledBytes: 0,
        scanTruncated: false,
      })),
    );

    const backup =
      backupDirectory === null
        ? { directory: null, latestPath: null, latestModifiedAt: null, scanTruncated: false }
        : yield* Effect.tryPromise((signal) => latestBackup(backupDirectory, signal)).pipe(
            Effect.timeout("5 seconds"),
            Effect.map((latest) => ({
              directory: backupDirectory,
              latestPath: latest.path,
              latestModifiedAt: latest.modifiedAt,
              scanTruncated: latest.scanTruncated,
            })),
            Effect.orElseSucceed(() => ({
              directory: backupDirectory,
              latestPath: null,
              latestModifiedAt: null,
              scanTruncated: false,
            })),
          );

    const nativeSessionsResult = yield* sessions.listBindings().pipe(
      Effect.map((bindings) =>
        bindings.map((binding) => {
          const nativeSessionId = nativeSessionIdFromCursor(binding.provider, binding.resumeCursor);
          return {
            threadId: binding.threadId,
            provider: binding.provider,
            ...(binding.providerInstanceId === undefined
              ? {}
              : { providerInstanceId: binding.providerInstanceId }),
            ...(binding.status === undefined ? {} : { status: binding.status }),
            nativeSessionId,
            resumable: binding.status === "stopped" && nativeSessionId !== null,
            lastSeenAt: binding.lastSeenAt,
            lastSynchronizedAt: lastNativeSynchronizationFromPayload(
              binding.runtimePayload,
              nativeSessionId,
            ),
          };
        }),
      ),
      Effect.result,
    );
    const clientResult = yield* clients.listActive().pipe(
      Effect.map((entries) =>
        entries.map((entry) => ({
          label: entry.client.label ?? null,
          // SessionStore records device type, but does not retain app surface metadata.
          surface: null,
          deviceType: entry.client.deviceType,
          connected: entry.connected,
          lastConnectedAt:
            entry.lastConnectedAt === null ? null : DateTime.formatIso(entry.lastConnectedAt),
        })),
      ),
      Effect.orElseSucceed(() => null),
    );

    return {
      readAt,
      baseDir: config.baseDir,
      database,
      disk,
      runtimeScratch,
      backup,
      nativeSessions: nativeSessionsResult._tag === "Success" ? nativeSessionsResult.success : [],
      nativeSessionsAvailable: nativeSessionsResult._tag === "Success",
      clients: clientResult,
    } satisfies ServerOperationalDiagnosticsResult;
  });

  return OperationalDiagnostics.of({ read });
});

export const layer = Layer.effect(OperationalDiagnostics, make());
