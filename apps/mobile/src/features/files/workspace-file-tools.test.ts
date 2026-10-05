import { describe, expect, it } from "vite-plus/test";

import {
  hostWorkspaceFilePath,
  recordRecentWorkspaceFile,
  workspaceFileMimeType,
} from "./workspace-file-tools";

describe("workspace file tools", () => {
  it("keeps recent files scoped by environment and workspace", () => {
    const path = { environmentId: "host-a", cwd: "F:\\one", path: "src/a.ts" };
    const otherWorkspace = { environmentId: "host-a", cwd: "F:\\two", path: "src/a.ts" };
    expect(recordRecentWorkspaceFile([path, otherWorkspace], path)).toEqual([path, otherWorkspace]);
  });

  it("uses useful text MIME types with a safe fallback", () => {
    expect(workspaceFileMimeType("src/file.tsx")).toBe("text/typescript");
    expect(workspaceFileMimeType("Dockerfile")).toBe("text/plain");
  });

  it("copies a host path without pretending it is an Android path", () => {
    expect(hostWorkspaceFilePath("F:\\CRM\\service_crm", "src/app.ts")).toBe(
      "F:\\CRM\\service_crm\\src\\app.ts",
    );
  });
});
