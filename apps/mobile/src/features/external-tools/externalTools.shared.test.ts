import { describe, expect, it, vi } from "vite-plus/test";

import {
  ACODE_PACKAGE,
  resolveExternalAppPackage,
  SOLID_EXPLORER_PACKAGE,
} from "./externalTools.shared";

describe("Android external tool targets", () => {
  it("targets installed Acode and Solid Explorer packages", () => {
    const installed = vi.fn(() => true);
    expect(resolveExternalAppPackage("acode", installed)).toEqual({
      status: "available",
      packageName: ACODE_PACKAGE,
    });
    expect(resolveExternalAppPackage("solid-explorer", installed)).toEqual({
      status: "available",
      packageName: SOLID_EXPLORER_PACKAGE,
    });
  });

  it("marks a missing configured app unavailable while system stays available", () => {
    expect(resolveExternalAppPackage("acode", () => false)).toEqual({
      status: "unavailable",
      packageName: ACODE_PACKAGE,
    });
    expect(resolveExternalAppPackage("system", () => false)).toEqual({
      status: "available",
      packageName: null,
    });
  });
});
