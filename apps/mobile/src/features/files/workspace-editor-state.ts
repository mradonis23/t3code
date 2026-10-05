const MAX_EDITOR_HISTORY = 50;

export interface WorkspaceEditorState {
  readonly value: string;
  readonly undo: ReadonlyArray<string>;
  readonly redo: ReadonlyArray<string>;
}

export function createWorkspaceEditorState(value: string): WorkspaceEditorState {
  return { value, undo: [], redo: [] };
}

export function editWorkspaceText(
  state: WorkspaceEditorState,
  value: string,
): WorkspaceEditorState {
  if (value === state.value) return state;
  return {
    value,
    undo: [...state.undo.slice(-(MAX_EDITOR_HISTORY - 1)), state.value],
    redo: [],
  };
}

export function undoWorkspaceText(state: WorkspaceEditorState): WorkspaceEditorState {
  const value = state.undo.at(-1);
  if (value === undefined) return state;
  return {
    value,
    undo: state.undo.slice(0, -1),
    redo: [state.value, ...state.redo].slice(0, MAX_EDITOR_HISTORY),
  };
}

export function redoWorkspaceText(state: WorkspaceEditorState): WorkspaceEditorState {
  const value = state.redo[0];
  if (value === undefined) return state;
  return {
    value,
    undo: [...state.undo.slice(-(MAX_EDITOR_HISTORY - 1)), state.value],
    redo: state.redo.slice(1),
  };
}

export function offsetForLine(contents: string, requestedLine: number): number {
  const line = Math.max(1, Math.floor(requestedLine));
  let offset = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const newline = contents.indexOf("\n", offset);
    if (newline === -1) return contents.length;
    offset = newline + 1;
  }
  return offset;
}

export function findWorkspaceText(
  contents: string,
  query: string,
  afterOffset: number,
): { readonly start: number; readonly end: number } | null {
  if (!query) return null;
  const normalizedContents = contents.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const startAt = Math.min(Math.max(0, afterOffset), contents.length);
  let start = normalizedContents.indexOf(normalizedQuery, startAt);
  if (start === -1 && startAt > 0) start = normalizedContents.indexOf(normalizedQuery);
  return start === -1 ? null : { start, end: start + query.length };
}
