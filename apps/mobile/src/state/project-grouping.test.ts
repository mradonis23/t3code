import { describe, expect, it } from "vite-plus/test";

import {
  mobileProjectGroupingModePatch,
  resolveMobileProjectGroupingSettings,
} from "./project-grouping.logic";

describe("mobile project grouping preferences", () => {
  it("maps the legacy boolean while preferring the new mode", () => {
    expect(resolveMobileProjectGroupingSettings({}).sidebarProjectGroupingMode).toBe("hierarchy");
    expect(
      resolveMobileProjectGroupingSettings({ projectGroupingEnabled: false })
        .sidebarProjectGroupingMode,
    ).toBe("hierarchy");
    expect(
      resolveMobileProjectGroupingSettings({
        projectGroupingEnabled: false,
        projectGroupingMode: "separate",
      }).sidebarProjectGroupingMode,
    ).toBe("hierarchy");
    expect(
      resolveMobileProjectGroupingSettings({
        projectGroupingEnabled: false,
        projectGroupingMode: "separate",
        projectGroupingHierarchyMigrated: true,
      }).sidebarProjectGroupingMode,
    ).toBe("separate");
    expect(
      resolveMobileProjectGroupingSettings({
        projectGroupingEnabled: false,
        projectGroupingMode: "repository_path",
      }).sidebarProjectGroupingMode,
    ).toBe("repository_path");
  });

  it("dual-writes the legacy boolean for rollback compatibility", () => {
    expect(mobileProjectGroupingModePatch("separate")).toEqual({
      projectGroupingMode: "separate",
      projectGroupingEnabled: false,
      projectGroupingHierarchyMigrated: true,
    });
    expect(mobileProjectGroupingModePatch("repository_path")).toEqual({
      projectGroupingMode: "repository_path",
      projectGroupingEnabled: true,
      projectGroupingHierarchyMigrated: true,
    });
  });
});
