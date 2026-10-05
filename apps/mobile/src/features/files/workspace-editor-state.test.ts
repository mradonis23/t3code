import { describe, expect, it } from "vite-plus/test";

import {
  createWorkspaceEditorState,
  editWorkspaceText,
  findWorkspaceText,
  offsetForLine,
  redoWorkspaceText,
  undoWorkspaceText,
} from "./workspace-editor-state";

describe("workspace editor state", () => {
  it("supports bounded undo and redo without changing the saved baseline", () => {
    const first = editWorkspaceText(createWorkspaceEditorState("one"), "two");
    const second = editWorkspaceText(first, "three");
    expect(undoWorkspaceText(second).value).toBe("two");
    expect(redoWorkspaceText(undoWorkspaceText(second)).value).toBe("three");
  });

  it("resolves line offsets and clamps past the end", () => {
    expect(offsetForLine("one\ntwo\nthree", 2)).toBe(4);
    expect(offsetForLine("one\ntwo", 99)).toBe(7);
  });

  it("finds case-insensitively and wraps after the cursor", () => {
    expect(findWorkspaceText("Alpha beta alpha", "ALPHA", 1)).toEqual({ start: 11, end: 16 });
    expect(findWorkspaceText("Alpha beta alpha", "alpha", 16)).toEqual({ start: 0, end: 5 });
  });
});
