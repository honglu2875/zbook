export type CellKind = "code" | "markdown" | "raw";
export type CellState = "idle" | "queued" | "running" | "error";

export interface RawNotebookOutput {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  name?: "stdout" | "stderr";
  text?: string | string[];
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface RawNotebookCell {
  id?: string;
  cell_type: CellKind;
  source: string | string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: RawNotebookOutput[];
}

export interface RawNotebook {
  cells: RawNotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

export interface NotebookOutput {
  type: "text" | "error" | "html" | "image" | "widget";
  text: string;
  data?: string;
  raw: RawNotebookOutput;
}

export interface NotebookCell {
  id: string;
  kind: CellKind;
  source: string;
  metadata: Record<string, unknown>;
  executionCount: number | null;
  state: CellState;
  outputs: NotebookOutput[];
}

export function richOutputFromKernel(
  outputType: "execute_result" | "display_data",
  data: Record<string, unknown>,
  metadata: Record<string, unknown>,
  executionCount: number | null,
): RawNotebookOutput {
  const output: RawNotebookOutput = {
    output_type: outputType,
    data,
    metadata,
  };
  if (outputType === "execute_result") output.execution_count = executionCount;
  return output;
}

function rawOutputForSave(output: NotebookOutput): RawNotebookOutput {
  if (output.raw.output_type !== "display_data" || !("execution_count" in output.raw)) {
    return output.raw;
  }
  // Older Zbook builds attached the cell count to display_data. nbformat permits
  // that field only on execute_result, so repair affected notebooks as they save.
  const { execution_count: _invalidExecutionCount, ...valid } = output.raw;
  return valid;
}

function asText(value: unknown): string {
  if (Array.isArray(value)) return value.join("");
  return typeof value === "string" ? value : "";
}

export function outputFromRaw(output: RawNotebookOutput): NotebookOutput {
  if (output.output_type === "error") {
    const traceback = output.traceback?.join("\n");
    const fallback = [output.ename, output.evalue].filter(Boolean).join(": ");
    return { type: "error", text: traceback || fallback || "Unknown kernel error", raw: output };
  }
  if (output.output_type === "stream") {
    return { type: "text", text: asText(output.text), raw: output };
  }

  const data = output.data ?? {};
  const plain = asText(data["text/plain"]);
  const widget = data["application/vnd.jupyter.widget-view+json"];
  const html = asText(data["text/html"]);
  const png = asText(data["image/png"]);
  if (
    widget
    && typeof widget === "object"
    && !Array.isArray(widget)
    && typeof (widget as Record<string, unknown>).model_id === "string"
  ) {
    return {
      type: "widget",
      text: plain || "Interactive widget",
      data: (widget as Record<string, unknown>).model_id as string,
      raw: output,
    };
  }
  if (html) return { type: "html", text: plain, data: html, raw: output };
  if (png) return { type: "image", text: plain, data: png, raw: output };
  return { type: "text", text: plain || "[rich output]", raw: output };
}

export function cellFromRaw(cell: RawNotebookCell): NotebookCell {
  return {
    id: cell.id ?? crypto.randomUUID(),
    kind: cell.cell_type,
    source: asText(cell.source),
    metadata: cell.metadata ?? {},
    executionCount: cell.cell_type === "code" ? cell.execution_count ?? null : null,
    state: "idle",
    outputs: cell.cell_type === "code" ? (cell.outputs ?? []).map(outputFromRaw) : [],
  };
}

export function newCell(kind: CellKind, source = ""): NotebookCell {
  return {
    id: crypto.randomUUID(),
    kind,
    source,
    metadata: {},
    executionCount: null,
    state: "idle",
    outputs: [],
  };
}

export function cellsFromNotebook(notebook: RawNotebook): NotebookCell[] {
  const cells = notebook.cells.map(cellFromRaw);
  return cells.length ? cells : [newCell("code")];
}

export function notebookFromCells(
  cells: NotebookCell[],
  metadata: Record<string, unknown>,
): RawNotebook {
  return {
    cells: cells.map((cell) => {
      const common = {
        id: cell.id,
        cell_type: cell.kind,
        source: cell.source,
        metadata: cell.metadata,
      };
      if (cell.kind === "code") {
        return {
          ...common,
          execution_count: cell.executionCount,
          outputs: cell.outputs.map(rawOutputForSave),
        };
      }
      return common;
    }),
    metadata,
    nbformat: 4,
    nbformat_minor: 5,
  };
}

export function emptyNotebook(): RawNotebook {
  return {
    cells: [],
    metadata: {
      kernelspec: {
        display_name: "Python (Zbook)",
        language: "python",
        name: "zbook",
      },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}
