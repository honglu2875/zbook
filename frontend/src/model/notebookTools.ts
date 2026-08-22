import { newCell, type CellKind, type NotebookCell } from "./notebook";

export const NOTEBOOK_READ_TOOL = "zbook_notebook_read";
export const NOTEBOOK_APPLY_TOOL = "zbook_notebook_apply";

export interface NotebookToolResponse {
  success: boolean;
  result: unknown;
}

export interface AppliedNotebookOperations {
  cells: NotebookCell[];
  affectedCellIds: string[];
  insertedCellIds: string[];
}

export class NotebookToolInputError extends Error {}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotebookToolInputError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function argumentsRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value), "Tool arguments");
    } catch (error) {
      if (error instanceof NotebookToolInputError) throw error;
      throw new NotebookToolInputError(`Tool arguments are not valid JSON: ${String(error)}`);
    }
  }
  return record(value, "Tool arguments");
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new NotebookToolInputError(`${label} must be a string.`);
  if (value.length > maxLength) throw new NotebookToolInputError(`${label} is too large.`);
  return value;
}

function cellKind(value: unknown, label: string): CellKind {
  if (value === "code" || value === "markdown" || value === "raw") return value;
  throw new NotebookToolInputError(`${label} must be code, markdown, or raw.`);
}

function cellIndex(cells: NotebookCell[], id: unknown, label: string): number {
  const cellId = requiredString(id, label, 200);
  const index = cells.findIndex((cell) => cell.id === cellId);
  if (index < 0) throw new NotebookToolInputError(`${label} does not identify a current cell: ${cellId}`);
  return index;
}

export function parseNotebookToolArguments(value: unknown): Record<string, unknown> {
  return argumentsRecord(value);
}

/** Validate and apply a batch without mutating the live React document. */
export function applyNotebookOperations(
  currentCells: NotebookCell[],
  operationsValue: unknown,
): AppliedNotebookOperations {
  if (!Array.isArray(operationsValue) || operationsValue.length === 0) {
    throw new NotebookToolInputError("operations must be a non-empty array.");
  }
  if (operationsValue.length > 100) {
    throw new NotebookToolInputError("A notebook edit is limited to 100 operations.");
  }

  const cells = [...currentCells];
  const affected = new Set<string>();
  const insertedCellIds: string[] = [];

  for (let operationIndex = 0; operationIndex < operationsValue.length; operationIndex += 1) {
    const operation = record(operationsValue[operationIndex], `operations[${operationIndex}]`);
    const op = operation.op;
    if (op === "replace_source") {
      const index = cellIndex(cells, operation.cellId, `operations[${operationIndex}].cellId`);
      const source = requiredString(operation.source, `operations[${operationIndex}].source`, 2_000_000);
      cells[index] = { ...cells[index], source };
      affected.add(cells[index].id);
      continue;
    }
    if (op === "set_kind") {
      const index = cellIndex(cells, operation.cellId, `operations[${operationIndex}].cellId`);
      const kind = cellKind(operation.cellType, `operations[${operationIndex}].cellType`);
      cells[index] = {
        ...cells[index],
        kind,
        outputs: kind === "code" ? cells[index].outputs : [],
        executionCount: kind === "code" ? cells[index].executionCount : null,
      };
      affected.add(cells[index].id);
      continue;
    }
    if (op === "insert_after") {
      const source = requiredString(operation.source, `operations[${operationIndex}].source`, 2_000_000);
      const kind = cellKind(operation.cellType, `operations[${operationIndex}].cellType`);
      let insertionIndex = 0;
      if (operation.afterCellId !== null) {
        insertionIndex = cellIndex(
          cells,
          operation.afterCellId,
          `operations[${operationIndex}].afterCellId`,
        ) + 1;
      }
      const inserted = newCell(kind, source);
      cells.splice(insertionIndex, 0, inserted);
      affected.add(inserted.id);
      insertedCellIds.push(inserted.id);
      continue;
    }
    if (op === "delete") {
      const index = cellIndex(cells, operation.cellId, `operations[${operationIndex}].cellId`);
      const [removed] = cells.splice(index, 1);
      affected.add(removed.id);
      continue;
    }
    throw new NotebookToolInputError(
      `operations[${operationIndex}].op must be replace_source, set_kind, insert_after, or delete.`,
    );
  }

  if (cells.length === 0) {
    const replacement = newCell("code");
    cells.push(replacement);
    affected.add(replacement.id);
    insertedCellIds.push(replacement.id);
  }
  return { cells, affectedCellIds: [...affected], insertedCellIds };
}
