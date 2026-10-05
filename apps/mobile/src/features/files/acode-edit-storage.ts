import { ORPHAN_SNAPSHOT_RETENTION_MS } from "./acode-edit-session";

const EXTERNAL_EDIT_DIRECTORY = "t3-external-edit-snapshots";
const SNAPSHOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertSnapshotId(snapshotId: string): void {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new Error("The external edit snapshot identity is invalid.");
  }
}

async function getSnapshotFiles(snapshotId: string) {
  assertSnapshotId(snapshotId);
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, EXTERNAL_EDIT_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return {
    directory,
    original: new File(directory, `${snapshotId}.original`),
    snapshot: new File(directory, `${snapshotId}.snapshot`),
    File,
  };
}

export async function createExternalEditSnapshot(input: {
  readonly snapshotId: string;
  readonly contents: string;
}): Promise<{ readonly snapshotUri: string; readonly contentUri: string }> {
  const files = await getSnapshotFiles(input.snapshotId);
  try {
    files.original.write(input.contents);
    files.snapshot.write(input.contents);
  } catch (cause) {
    try {
      if (files.original.exists) files.original.delete();
      if (files.snapshot.exists) files.snapshot.delete();
    } catch {
      // Preserve the original failure. A later conservative cleanup can remove
      // an incomplete preparing snapshot once it is no longer active.
    }
    throw cause;
  }
  return { snapshotUri: files.snapshot.uri, contentUri: files.snapshot.contentUri };
}

export async function readExternalEditSnapshot(snapshotId: string): Promise<{
  readonly originalContents: string;
  readonly snapshotContents: string;
  readonly snapshotUri: string;
}> {
  const files = await getSnapshotFiles(snapshotId);
  if (!files.original.exists || !files.snapshot.exists) {
    throw new Error("The Acode snapshot is missing or incomplete; the external edit was kept.");
  }
  return {
    originalContents: await files.original.text(),
    snapshotContents: await files.snapshot.text(),
    snapshotUri: files.snapshot.uri,
  };
}

export async function removeExternalEditSnapshot(snapshotId: string): Promise<void> {
  const files = await getSnapshotFiles(snapshotId);
  if (files.original.exists) files.original.delete();
  if (files.snapshot.exists) files.snapshot.delete();
}

export async function cleanupExternalEditSnapshots(
  activeSnapshotIds: ReadonlySet<string>,
  now = Date.now(),
): Promise<void> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, EXTERNAL_EDIT_DIRECTORY);
  if (!directory.exists) return;
  for (const entry of directory.list()) {
    if (!(entry instanceof File)) continue;
    const match = /^(.*)\.(?:original|snapshot)$/.exec(entry.name);
    const snapshotId = match?.[1];
    if (snapshotId === undefined || !SNAPSHOT_ID_PATTERN.test(snapshotId)) continue;
    if (activeSnapshotIds.has(snapshotId)) continue;
    const lastModified = entry.lastModified;
    if (lastModified === null || now - lastModified < ORPHAN_SNAPSHOT_RETENTION_MS) continue;
    entry.delete();
  }
}
