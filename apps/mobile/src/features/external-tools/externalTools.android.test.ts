import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  isPackageInstalled: vi.fn(),
  openExternalFile: vi.fn(),
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: () => native }));
vi.mock("expo-file-system", () => ({
  File: class {
    readonly contentUri: string;
    constructor(uri: string) {
      this.contentUri = `content://t3/${encodeURIComponent(uri)}`;
    }
  },
}));

import { isExternalPackageInstalled, openExternalFile } from "./externalTools.android";

describe("Android external file handoff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes a content URI and explicit editable grant request to the native intent", async () => {
    await openExternalFile({
      uri: "file:///cache/src.ts",
      mimeType: "text/typescript",
      packageName: "com.foxdebug.acodefree",
      editable: true,
      forceChooser: false,
      chooserTitle: "Open code file",
    });

    expect(native.openExternalFile).toHaveBeenCalledWith(
      "content://t3/file%3A%2F%2F%2Fcache%2Fsrc.ts",
      "text/typescript",
      "com.foxdebug.acodefree",
      true,
      false,
      "Open code file",
    );
  });

  it("reports package visibility failures without throwing", () => {
    native.isPackageInstalled.mockImplementation(() => {
      throw new Error("not visible");
    });
    expect(isExternalPackageInstalled("pl.solidexplorer2")).toBe(false);
  });
});
