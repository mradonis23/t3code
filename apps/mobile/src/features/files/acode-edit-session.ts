import { diffLines } from "diff";

import type {
  MobileExternalEditSession,
  MobileExternalEditSessionState,
} from "../../persistence/mobile-preferences";

export const MAX_EXTERNAL_EDIT_SESSIONS = 8;
export const PREPARING_SESSION_RETENTION_MS = 60 * 60 * 1000;
export const ORPHAN_SNAPSHOT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface AcodeEditTarget {
  readonly environmentId: string;
  readonly cwd: string;
  readonly path: string;
}

export interface AcodeEditDiffLine {
  readonly kind: "context" | "add" | "remove";
  readonly text: string;
}

export interface AcodeEditDiff {
  readonly lines: ReadonlyArray<AcodeEditDiffLine>;
  readonly additions: number;
  readonly deletions: number;
}

export function isExternalEditSessionForTarget(
  session: Pick<MobileExternalEditSession, "environmentId" | "cwd" | "path">,
  target: AcodeEditTarget,
): boolean {
  return (
    session.environmentId === target.environmentId &&
    session.cwd === target.cwd &&
    session.path === target.path
  );
}

export function findExternalEditSession(
  sessions: ReadonlyArray<MobileExternalEditSession>,
  target: AcodeEditTarget,
): MobileExternalEditSession | undefined {
  return sessions.find((session) => isExternalEditSessionForTarget(session, target));
}

export function createExternalEditSession(input: {
  readonly snapshotId: string;
  readonly snapshotUri: string;
  readonly contentUri: string;
  readonly target: AcodeEditTarget;
  readonly originalRevision: string;
  readonly editor: "acode" | "system";
  readonly now: number;
}): MobileExternalEditSession {
  return {
    snapshotId: input.snapshotId,
    snapshotUri: input.snapshotUri,
    contentUri: input.contentUri,
    environmentId: input.target.environmentId,
    cwd: input.target.cwd,
    path: input.target.path,
    originalRevision: input.originalRevision,
    originalContentHash: input.originalRevision,
    createdAt: input.now,
    lastOpenedAt: input.now,
    lastCheckedAt: 0,
    state: "preparing",
    editor: input.editor,
  };
}

export function markExternalEditOpened(
  session: MobileExternalEditSession,
  now: number,
): MobileExternalEditSession {
  return { ...session, state: "open", lastOpenedAt: now };
}

export function compareExternalEditSnapshot(input: {
  readonly session: MobileExternalEditSession;
  readonly originalContents: string;
  readonly snapshotContents: string;
  readonly now: number;
}): {
  readonly changed: boolean;
  readonly session: MobileExternalEditSession;
} {
  const changed = input.originalContents !== input.snapshotContents;
  const state: MobileExternalEditSessionState = changed ? "ready" : "open";
  return {
    changed,
    session: { ...input.session, state, lastCheckedAt: input.now },
  };
}

function splitDiffValue(value: string): ReadonlyArray<string> {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function buildExternalEditDiff(original: string, edited: string): AcodeEditDiff {
  const lines: AcodeEditDiffLine[] = [];
  for (const part of diffLines(original, edited)) {
    const kind = part.added ? "add" : part.removed ? "remove" : "context";
    for (const text of splitDiffValue(part.value)) {
      lines.push({ kind, text });
    }
  }
  return {
    lines,
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "remove").length,
  };
}

export function buildExternalEditWriteInput(
  session: Pick<MobileExternalEditSession, "cwd" | "path" | "originalRevision">,
  contents: string,
  overwrite = false,
) {
  return {
    cwd: session.cwd,
    relativePath: session.path,
    contents,
    expectedRevision: session.originalRevision,
    overwrite,
  } as const;
}

export function removeExternalEditSession(
  sessions: ReadonlyArray<MobileExternalEditSession>,
  snapshotId: string,
): ReadonlyArray<MobileExternalEditSession> {
  return sessions.filter((session) => session.snapshotId !== snapshotId);
}

export function prunePreparingExternalEditSessions(
  sessions: ReadonlyArray<MobileExternalEditSession>,
  now: number,
): {
  readonly sessions: ReadonlyArray<MobileExternalEditSession>;
  readonly expiredSnapshotIds: ReadonlyArray<string>;
} {
  const expiredSnapshotIds: string[] = [];
  const retained = sessions.filter((session) => {
    const expired =
      session.state === "preparing" && now - session.createdAt >= PREPARING_SESSION_RETENTION_MS;
    if (expired) expiredSnapshotIds.push(session.snapshotId);
    return !expired;
  });
  return { sessions: retained, expiredSnapshotIds };
}
