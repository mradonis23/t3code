import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";

describe("Android production branding", () => {
  it("keeps the checked-in launcher label aligned with T3 Unlimited", () => {
    const stringsPath = fileURLToPath(
      new URL("../../android/app/src/main/res/values/strings.xml", import.meta.url),
    );
    const strings = readFileSync(stringsPath, "utf8");

    expect(strings).toContain('<string name="app_name">T3 Unlimited</string>');
    expect(strings).not.toContain('<string name="app_name">T3 Code</string>');
  });
});
