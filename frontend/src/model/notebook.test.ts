import { describe, expect, it } from "vitest";
import {
  notebookFromCells,
  outputFromRaw,
  richOutputFromKernel,
  type NotebookCell,
  type RawNotebookOutput,
} from "./notebook";

function codeCell(outputs: RawNotebookOutput[]): NotebookCell {
  return {
    id: "cell-1",
    kind: "code",
    source: "display(figure)",
    metadata: {},
    executionCount: 11,
    state: "idle",
    outputs: outputs.map(outputFromRaw),
  };
}

describe("notebook output serialization", () => {
  it("keeps execution_count on execute_result only", () => {
    const executeResult = richOutputFromKernel(
      "execute_result",
      { "text/plain": "42" },
      {},
      11,
    );
    const displayData = richOutputFromKernel(
      "display_data",
      { "image/png": "encoded-image" },
      {},
      11,
    );

    expect(executeResult.execution_count).toBe(11);
    expect(displayData).not.toHaveProperty("execution_count");
  });

  it("repairs display_data written by older Zbook versions on save", () => {
    const invalidDisplayData: RawNotebookOutput = {
      output_type: "display_data",
      data: { "image/png": "encoded-image" },
      metadata: {},
      execution_count: 11,
    };

    const notebook = notebookFromCells(
      [codeCell([invalidDisplayData])],
      {},
    );

    expect(notebook.cells[0].outputs?.[0]).toEqual({
      output_type: "display_data",
      data: { "image/png": "encoded-image" },
      metadata: {},
    });
    expect(invalidDisplayData.execution_count).toBe(11);
  });

  it("recognizes a live Jupyter widget view without changing its saved MIME bundle", () => {
    const raw: RawNotebookOutput = {
      output_type: "display_data",
      data: {
        "application/vnd.jupyter.widget-view+json": {
          version_major: 2,
          version_minor: 0,
          model_id: "widget-model-1",
        },
        "text/plain": "IntSlider(value=4)",
      },
      metadata: {},
    };

    const output = outputFromRaw(raw);

    expect(output).toMatchObject({
      type: "widget",
      text: "IntSlider(value=4)",
      data: "widget-model-1",
    });
    expect(output.raw).toBe(raw);
  });
});
