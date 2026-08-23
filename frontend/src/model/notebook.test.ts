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
});
