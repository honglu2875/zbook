export type CellKind = "code" | "markdown";
export type CellState = "idle" | "queued" | "running" | "error";

export interface NotebookOutput {
  type: "text" | "error";
  text: string;
}

export interface NotebookCell {
  id: string;
  kind: CellKind;
  source: string;
  executionCount: number | null;
  state: CellState;
  outputs: NotebookOutput[];
}

export const initialCells: NotebookCell[] = [
  {
    id: "intro",
    kind: "markdown",
    source:
      "# A smaller notebook\n\nCode, notes, files, and an AI collaborator—without a wall of chrome.",
    executionCount: null,
    state: "idle",
    outputs: [],
  },
  {
    id: "imports",
    kind: "code",
    source:
      "from pathlib import Path\n\nworkspace = Path.cwd()\nnotebooks = sorted(workspace.glob(\"*.ipynb\"))\nnotebooks",
    executionCount: 1,
    state: "idle",
    outputs: [{ type: "text", text: "[PosixPath('analysis.ipynb')]" }],
  },
  {
    id: "plot",
    kind: "code",
    source:
      "values = [3, 8, 5, 13, 9]\nmean = sum(values) / len(values)\nprint(f\"mean = {mean:.1f}\")",
    executionCount: 2,
    state: "idle",
    outputs: [{ type: "text", text: "mean = 7.6" }],
  },
];

export function newCell(kind: CellKind, source = ""): NotebookCell {
  return {
    id: crypto.randomUUID(),
    kind,
    source,
    executionCount: null,
    state: "idle",
    outputs: [],
  };
}
