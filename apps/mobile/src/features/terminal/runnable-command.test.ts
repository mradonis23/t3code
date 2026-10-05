import { describe, expect, it } from "vite-plus/test";

import { isRunnableShellBlock } from "./runnable-command";

describe("runnable shell blocks", () => {
  it("only offers terminal execution for explicit shell languages", () => {
    expect(isRunnableShellBlock("powershell", "Get-ChildItem")).toBe(true);
    expect(isRunnableShellBlock("ts", "rm('file')")).toBe(false);
    expect(isRunnableShellBlock(undefined, "echo maybe")).toBe(false);
  });
});
