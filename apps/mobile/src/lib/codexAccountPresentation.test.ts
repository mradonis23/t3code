import { describe, expect, it } from "vite-plus/test";

import { codexAccountPresentation } from "./codexAccountPresentation";

describe("codexAccountPresentation", () => {
  it.each([
    ["codex", "Dad's Codex", "#0A84FF"],
    ["codex_mom", "Mom's Codex", "#FF9F0A"],
    ["codex_nena", "Nana's Codex", "#30D158"],
  ])("maps %s to stable label and identity color", (instanceId, label, color) => {
    expect(codexAccountPresentation(instanceId)).toEqual({ label, color });
  });
});
