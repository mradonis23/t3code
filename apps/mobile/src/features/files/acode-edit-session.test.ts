import { describe, expect, it } from "vite-plus/test";

import {
  buildExternalEditDiff,
  buildExternalEditWriteInput,
  compareExternalEditSnapshot,
  createExternalEditSession,
  findExternalEditSession,
  isExternalEditSessionForTarget,
  prunePreparingExternalEditSessions,
  removeExternalEditSession,
} from "./acode-edit-session";

const target = { environmentId: "host-a", cwd: "F:\\workspace-a", path: "src/foo.ts" };
const revision = "a".repeat(64);
const session = createExternalEditSession({
  snapshotId: "00000000-0000-4000-8000-000000000001",
  snapshotUri:
    "file:///documents/t3-external-edit-snapshots/00000000-0000-4000-8000-000000000001.snapshot",
  contentUri:
    "content://com.t3tools.t3code.FileSystemFileProvider/file/documents/t3-external-edit-snapshots/00000000-0000-4000-8000-000000000001.snapshot",
  target,
  originalRevision: revision,
  editor: "acode",
  now: 100,
});

describe("Acode external edit sessions", () => {
  it("retains full target and revision identity", () => {
    expect(session).toMatchObject({
      snapshotId: "00000000-0000-4000-8000-000000000001",
      snapshotUri: expect.stringContaining("t3-external-edit-snapshots"),
      contentUri: expect.stringContaining("content://"),
      environmentId: "host-a",
      cwd: "F:\\workspace-a",
      path: "src/foo.ts",
      originalRevision: revision,
      originalContentHash: revision,
    });
  });

  it("does not confuse the same basename in another workspace", () => {
    expect(
      isExternalEditSessionForTarget(session, {
        ...target,
        cwd: "F:\\workspace-b",
      }),
    ).toBe(false);
    expect(
      findExternalEditSession([session], {
        ...target,
        environmentId: "host-b",
      }),
    ).toBeUndefined();
  });

  it("detects only a changed snapshot", () => {
    expect(
      compareExternalEditSnapshot({
        session,
        originalContents: "one\ntwo\n",
        snapshotContents: "one\ntwo\n",
        now: 200,
      }),
    ).toMatchObject({ changed: false, session: { state: "open", lastCheckedAt: 200 } });
    expect(
      compareExternalEditSnapshot({
        session,
        originalContents: "one\ntwo\n",
        snapshotContents: "one\nchanged\ntwo\n",
        now: 201,
      }),
    ).toMatchObject({ changed: true, session: { state: "ready", lastCheckedAt: 201 } });
  });

  it("builds the review diff from original to edited content", () => {
    const diff = buildExternalEditDiff("one\ntwo\n", "one\nchanged\n");
    expect(diff).toMatchObject({ additions: 1, deletions: 1 });
    expect(diff.lines).toEqual([
      { kind: "context", text: "one" },
      { kind: "remove", text: "two" },
      { kind: "add", text: "changed" },
    ]);
  });

  it("keeps revision protection on normal apply and makes overwrite explicit", () => {
    expect(buildExternalEditWriteInput(session, "edited")).toEqual({
      cwd: target.cwd,
      relativePath: target.path,
      contents: "edited",
      expectedRevision: revision,
      overwrite: false,
    });
    expect(buildExternalEditWriteInput(session, "edited", true).overwrite).toBe(true);
  });

  it("discards only the matching snapshot record", () => {
    const other = { ...session, snapshotId: "00000000-0000-4000-8000-000000000002" };
    expect(removeExternalEditSession([session, other], session.snapshotId)).toEqual([other]);
  });

  it("only expires abandoned preparing records", () => {
    const ready = { ...session, state: "ready" as const, createdAt: 0 };
    const stalePreparing = { ...session, snapshotId: otherId(), createdAt: 0 };
    const result = prunePreparingExternalEditSessions([ready, stalePreparing], 3_600_001);
    expect(result.sessions).toEqual([ready]);
    expect(result.expiredSnapshotIds).toEqual([stalePreparing.snapshotId]);
  });
});

function otherId(): string {
  return "00000000-0000-4000-8000-000000000003";
}
