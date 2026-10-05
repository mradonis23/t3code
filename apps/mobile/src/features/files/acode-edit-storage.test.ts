import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mockFileSystem = vi.hoisted(() => {
  const files = new Map<string, { contents: string; lastModified: number }>();
  const directories = new Set<string>();

  const uriFor = (part: string | { readonly uri: string }): string =>
    typeof part === "string" ? part : part.uri;
  const joinUri = (...parts: Array<string | { readonly uri: string }>): string => {
    const [first, ...rest] = parts.map(uriFor);
    return [first?.replace(/\/$/, ""), ...rest.map((part) => part.replace(/^\//, ""))]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("/");
  };

  class MockFile {
    readonly uri: string;
    constructor(...parts: Array<string | { readonly uri: string }>) {
      this.uri = joinUri(...parts);
    }
    get name(): string {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }
    get exists(): boolean {
      return files.has(this.uri);
    }
    get lastModified(): number | null {
      return files.get(this.uri)?.lastModified ?? null;
    }
    get contentUri(): string {
      return `content://t3/${encodeURIComponent(this.uri)}`;
    }
    write(contents: string): void {
      files.set(this.uri, { contents, lastModified: mockFileSystem.modifiedAt });
    }
    async text(): Promise<string> {
      const entry = files.get(this.uri);
      if (entry === undefined) throw new Error("missing file");
      return entry.contents;
    }
    delete(): void {
      files.delete(this.uri);
    }
  }

  class MockDirectory {
    readonly uri: string;
    constructor(...parts: Array<string | { readonly uri: string }>) {
      this.uri = joinUri(...parts);
    }
    get exists(): boolean {
      return directories.has(this.uri);
    }
    create(): void {
      directories.add(this.uri);
    }
    list(): Array<MockFile> {
      const prefix = `${this.uri}/`;
      return [...files.keys()]
        .filter((uri) => uri.startsWith(prefix) && !uri.slice(prefix.length).includes("/"))
        .map((uri) => new MockFile(uri));
    }
  }

  return {
    MockDirectory,
    MockFile,
    Paths: { document: "file:///documents" },
    files,
    directories,
    modifiedAt: 0,
  };
});

vi.mock("expo-file-system", () => ({
  Directory: mockFileSystem.MockDirectory,
  File: mockFileSystem.MockFile,
  Paths: mockFileSystem.Paths,
}));

import {
  cleanupExternalEditSnapshots,
  createExternalEditSnapshot,
  readExternalEditSnapshot,
  removeExternalEditSnapshot,
} from "./acode-edit-storage";

const ACTIVE_ID = "00000000-0000-4000-8000-000000000001";
const ABANDONED_ID = "00000000-0000-4000-8000-000000000002";
const OLD_NOW = 24 * 60 * 60 * 1000 + 1;

describe("Acode external edit snapshot storage", () => {
  beforeEach(() => {
    mockFileSystem.files.clear();
    mockFileSystem.directories.clear();
    mockFileSystem.modifiedAt = 0;
  });

  it("keeps the original and writable snapshot content separate", async () => {
    const created = await createExternalEditSnapshot({
      snapshotId: ACTIVE_ID,
      contents: "before\n",
    });

    expect(created.contentUri).toContain("content://");
    const snapshot = new mockFileSystem.MockFile(created.snapshotUri);
    snapshot.write("after\n");

    await expect(readExternalEditSnapshot(ACTIVE_ID)).resolves.toMatchObject({
      originalContents: "before\n",
      snapshotContents: "after\n",
    });
  });

  it("does not remove an active snapshot during conservative orphan cleanup", async () => {
    await createExternalEditSnapshot({ snapshotId: ACTIVE_ID, contents: "active" });
    mockFileSystem.modifiedAt = 0;
    await createExternalEditSnapshot({ snapshotId: ABANDONED_ID, contents: "abandoned" });

    await cleanupExternalEditSnapshots(new Set([ACTIVE_ID]), OLD_NOW);

    await expect(readExternalEditSnapshot(ACTIVE_ID)).resolves.toBeDefined();
    await expect(readExternalEditSnapshot(ABANDONED_ID)).rejects.toThrow("missing or incomplete");
  });

  it("removes only the requested snapshot pair", async () => {
    await createExternalEditSnapshot({ snapshotId: ACTIVE_ID, contents: "keep" });
    await createExternalEditSnapshot({ snapshotId: ABANDONED_ID, contents: "remove" });

    await removeExternalEditSnapshot(ABANDONED_ID);

    await expect(readExternalEditSnapshot(ACTIVE_ID)).resolves.toBeDefined();
    await expect(readExternalEditSnapshot(ABANDONED_ID)).rejects.toThrow("missing or incomplete");
  });
});
