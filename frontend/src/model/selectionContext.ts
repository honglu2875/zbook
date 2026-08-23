import type { CellKind } from "./notebook";

export const MAX_QUOTED_SELECTION_CHARACTERS = 20_000;
export const MAX_QUOTED_SELECTION_LINES = 200;

export interface CellTextSelection {
  text: string;
  startLine: number;
  endLine: number;
  tooLarge: boolean;
}

export interface NotebookSelectionQuote extends CellTextSelection {
  notebookPath: string;
  cellId: string;
  cellKind: CellKind;
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export function selectionFromSource(
  source: string,
  anchor: number,
  head: number,
): CellTextSelection | null {
  const from = Math.max(0, Math.min(source.length, Math.min(anchor, head)));
  const to = Math.max(0, Math.min(source.length, Math.max(anchor, head)));
  if (from === to) return null;
  const text = source.slice(from, to);
  const startLine = lineNumberAt(source, from);
  const endLine = lineNumberAt(source, Math.max(from, to - 1));
  return {
    text,
    startLine,
    endLine,
    tooLarge: (
      text.length > MAX_QUOTED_SELECTION_CHARACTERS
      || endLine - startLine + 1 > MAX_QUOTED_SELECTION_LINES
    ),
  };
}

export function selectionLineLabel(selection: Pick<CellTextSelection, "startLine" | "endLine">): string {
  return selection.startLine === selection.endLine
    ? `Line ${selection.startLine}`
    : `Lines ${selection.startLine}–${selection.endLine}`;
}

export function selectionPreview(text: string, maximumLength = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maximumLength) return compact;
  return `${compact.slice(0, Math.max(0, maximumLength - 1)).trimEnd()}…`;
}
