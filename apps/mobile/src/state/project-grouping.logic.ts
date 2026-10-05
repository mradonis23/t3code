import type { ProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import type { SidebarProjectGroupingMode } from "@t3tools/contracts";

import type { Preferences } from "../persistence/mobile-preferences";

export const DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS: ProjectGroupingSettings = {
  sidebarProjectGroupingMode: "hierarchy",
  sidebarProjectGroupingOverrides: {},
};

export function resolveMobileProjectGroupingSettings(
  preferences: Preferences,
): ProjectGroupingSettings {
  const migrateLegacySeparate =
    preferences.projectGroupingHierarchyMigrated !== true &&
    (preferences.projectGroupingMode === "separate" ||
      (preferences.projectGroupingMode === undefined &&
        preferences.projectGroupingEnabled === false));
  return {
    sidebarProjectGroupingMode: migrateLegacySeparate
      ? "hierarchy"
      : (preferences.projectGroupingMode ?? "hierarchy"),
    sidebarProjectGroupingOverrides: {},
  };
}

/**
 * Dual-writes the legacy boolean for one release so an OTA rollback to an
 * older mobile bundle preserves the user's grouping choice.
 */
export function mobileProjectGroupingModePatch(
  mode: SidebarProjectGroupingMode,
): Partial<Preferences> {
  return {
    projectGroupingMode: mode,
    projectGroupingEnabled: mode !== "separate",
    projectGroupingHierarchyMigrated: true,
  };
}
