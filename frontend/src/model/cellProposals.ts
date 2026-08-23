import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import type { CellKind, NotebookCell } from "./notebook";

export type CellProposalState = "streaming" | "review" | "conflict";
export type CellProposalKind = "source" | "insert";

export interface CellProposal {
  notebookPath: string;
  cellId: string;
  proposalKind: CellProposalKind;
  cellKind: CellKind;
  afterCellId: string | null;
  beforeCellId: string | null;
  baseSource: string;
  draftSource: string;
  baseDocumentRevision: number;
  proposalRevision: number;
  ownerThreadId: string | null;
  ownerTurnId: string | null;
  state: CellProposalState;
  createdAt: number;
  updatedAt: number;
}

export interface ProposalOwner {
  threadId: string | null;
  turnId: string | null;
}

export interface ProposalDiffChunk {
  originalStartLine: number;
  originalText: string;
  proposedStartLine: number;
  proposedText: string;
  precise: boolean;
}

export interface ProposalDiff {
  chunks: ProposalDiffChunk[];
  truncated: boolean;
}

export interface ProposalOperationResult {
  proposal: CellProposal | null;
  action: "insert_cell" | "stage_hunk" | "replace_proposal" | "discard_proposal";
  previousProposalRevision: number;
}

export class ProposalInputError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const MAX_SOURCE_LENGTH = 2_000_000;
const MAX_HUNK_LINES = 400;
const MAX_DIFF_CHUNKS = 100;

function requiredInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new ProposalInputError("invalid_proposal", `${label} must be an integer of at least ${minimum}.`);
  }
  return value as number;
}

function requiredSource(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ProposalInputError("invalid_proposal", `${label} must be a string.`);
  }
  if (value.length > MAX_SOURCE_LENGTH) {
    throw new ProposalInputError("invalid_proposal", `${label} is too large.`);
  }
  return value;
}

function requiredCellKind(value: unknown): CellKind {
  if (value === "code" || value === "markdown" || value === "raw") return value;
  throw new ProposalInputError("invalid_proposal", "cellType must be code, markdown, or raw.");
}

function requiredLines(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_HUNK_LINES) {
    throw new ProposalInputError(
      "invalid_proposal",
      `${label} must be an array containing at most ${MAX_HUNK_LINES} lines.`,
    );
  }
  return value.map((line, index) => {
    if (typeof line !== "string" || line.includes("\n") || line.includes("\r")) {
      throw new ProposalInputError(
        "invalid_proposal",
        `${label}[${index}] must be a string without newline characters.`,
      );
    }
    return line;
  });
}

function proposalRevision(value: unknown, current: CellProposal | null): number {
  const expected = requiredInteger(value, "expectedProposalRevision", 0);
  const actual = current?.proposalRevision ?? 0;
  if (expected !== actual) {
    throw new ProposalInputError(
      "proposal_revision_conflict",
      "The proposal changed after the previous action. Read the notebook again before retrying.",
      { expectedProposalRevision: expected, currentProposalRevision: actual },
    );
  }
  return actual;
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function matchingStartLines(lines: string[], oldLines: string[]): number[] {
  if (!oldLines.length || oldLines.length > lines.length) return [];
  const matches: number[] = [];
  const startedAt = Date.now();
  for (let index = 0; index <= lines.length - oldLines.length; index += 1) {
    if (index % 2_048 === 0 && Date.now() - startedAt > 25) break;
    let matchesHere = true;
    for (let offset = 0; offset < oldLines.length; offset += 1) {
      if (lines[index + offset] !== oldLines[offset]) {
        matchesHere = false;
        break;
      }
    }
    if (matchesHere) {
      matches.push(index + 1);
      if (matches.length === 12) break;
    }
  }
  return matches;
}

function changedProposal(
  cell: NotebookCell,
  current: CellProposal | null,
  draftSource: string,
  notebookPath: string,
  documentRevision: number,
  owner: ProposalOwner,
  nextRevision: number,
): CellProposal | null {
  const currentBaseIsValid = Boolean(current && current.baseSource === cell.source);
  const baseSource = currentBaseIsValid ? current!.baseSource : cell.source;
  if (draftSource === baseSource && current?.proposalKind !== "insert") return null;
  const now = Date.now();
  return {
    notebookPath,
    cellId: cell.id,
    proposalKind: current?.proposalKind ?? "source",
    cellKind: current?.cellKind ?? cell.kind,
    afterCellId: current?.afterCellId ?? null,
    beforeCellId: current?.beforeCellId ?? null,
    baseSource,
    draftSource,
    baseDocumentRevision: currentBaseIsValid ? current!.baseDocumentRevision : documentRevision,
    proposalRevision: nextRevision,
    ownerThreadId: owner.threadId,
    ownerTurnId: owner.turnId,
    state: "streaming",
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
}

export function createInsertionProposal(
  argumentsValue: Record<string, unknown>,
  notebookPath: string,
  documentRevision: number,
  owner: ProposalOwner,
  beforeCellId: string | null,
): ProposalOperationResult {
  if (argumentsValue.action !== "insert_cell") {
    throw new ProposalInputError("invalid_proposal", "action must be insert_cell.");
  }
  proposalRevision(argumentsValue.expectedProposalRevision, null);
  const afterCellId = argumentsValue.afterCellId;
  if (afterCellId !== null && (typeof afterCellId !== "string" || !afterCellId || afterCellId.length > 200)) {
    throw new ProposalInputError(
      "invalid_proposal",
      "afterCellId must be null or identify one current accepted cell.",
    );
  }
  const now = Date.now();
  return {
    proposal: {
      notebookPath,
      cellId: crypto.randomUUID(),
      proposalKind: "insert",
      cellKind: requiredCellKind(argumentsValue.cellType),
      afterCellId,
      beforeCellId,
      baseSource: "",
      draftSource: requiredSource(argumentsValue.source, "source"),
      baseDocumentRevision: documentRevision,
      proposalRevision: 1,
      ownerThreadId: owner.threadId,
      ownerTurnId: owner.turnId,
      state: "streaming",
      createdAt: now,
      updatedAt: now,
    },
    action: "insert_cell",
    previousProposalRevision: 0,
  };
}

export function applyProposalOperation(
  cell: NotebookCell,
  current: CellProposal | null,
  argumentsValue: Record<string, unknown>,
  notebookPath: string,
  documentRevision: number,
  owner: ProposalOwner,
): ProposalOperationResult {
  const action = argumentsValue.action;
  if (action !== "stage_hunk" && action !== "replace_proposal" && action !== "discard_proposal") {
    throw new ProposalInputError(
      "invalid_proposal",
      "action must be stage_hunk, replace_proposal, or discard_proposal.",
    );
  }
  const previousProposalRevision = proposalRevision(argumentsValue.expectedProposalRevision, current);

  if (action === "discard_proposal") {
    if (!current) {
      throw new ProposalInputError("proposal_not_found", "That cell has no uncommitted proposal to discard.");
    }
    return { proposal: null, action, previousProposalRevision };
  }

  if (action === "replace_proposal") {
    if (!current) {
      throw new ProposalInputError(
        "proposal_not_found",
        "That cell has no uncommitted proposal. Start with one or more stage_hunk actions.",
      );
    }
    const source = requiredSource(argumentsValue.source, "source");
    return {
      proposal: changedProposal(
        cell,
        current,
        source,
        notebookPath,
        documentRevision,
        owner,
        previousProposalRevision + 1,
      ),
      action,
      previousProposalRevision,
    };
  }

  if (current && (
    current.state !== "streaming"
    || (current.ownerTurnId !== null && owner.turnId !== current.ownerTurnId)
  )) {
    throw new ProposalInputError(
      "pending_proposal_requires_resolution",
      "This cell already has a proposal from an earlier turn. Replace the complete proposal or discard it.",
      {
        currentProposalRevision: current.proposalRevision,
        allowedActions: ["replace_proposal", "discard_proposal"],
      },
    );
  }

  const startLine = requiredInteger(argumentsValue.startLine, "startLine", 1);
  const oldLines = requiredLines(argumentsValue.oldLines, "oldLines");
  const newLines = requiredLines(argumentsValue.newLines, "newLines");
  if (oldLines.length === 0 && newLines.length === 0) {
    throw new ProposalInputError("invalid_proposal", "A staged hunk cannot leave both oldLines and newLines empty.");
  }
  const source = current?.draftSource ?? cell.source;
  const lines = source.split("\n");
  const startIndex = startLine - 1;
  if (startIndex > lines.length || startIndex + oldLines.length > lines.length) {
    throw new ProposalInputError(
      "hunk_context_mismatch",
      "The requested line range is outside the current proposed source. Read the notebook again.",
      {
        currentProposalRevision: previousProposalRevision,
        lineCount: lines.length,
        suggestedStartLines: matchingStartLines(lines, oldLines),
      },
    );
  }
  const actualLines = lines.slice(startIndex, startIndex + oldLines.length);
  if (!sameLines(actualLines, oldLines)) {
    throw new ProposalInputError(
      "hunk_context_mismatch",
      "oldLines no longer match the current proposed source. Read the notebook again before retrying.",
      {
        currentProposalRevision: previousProposalRevision,
        startLine,
        actualLines,
        suggestedStartLines: matchingStartLines(lines, oldLines),
      },
    );
  }
  const nextLines = [...lines];
  nextLines.splice(startIndex, oldLines.length, ...newLines);
  const draftSource = nextLines.join("\n");
  if (draftSource.length > MAX_SOURCE_LENGTH) {
    throw new ProposalInputError("invalid_proposal", "The resulting proposed source is too large.");
  }
  return {
    proposal: changedProposal(
      cell,
      current,
      draftSource,
      notebookPath,
      documentRevision,
      owner,
      previousProposalRevision + 1,
    ),
    action,
    previousProposalRevision,
  };
}

function lineNumber(text: Text, position: number): number {
  return text.lineAt(Math.min(Math.max(position, 0), text.length)).number;
}

export function proposalDiff(proposal: CellProposal): ProposalDiff {
  const original = Text.of(proposal.baseSource.split("\n"));
  const proposed = Text.of(proposal.draftSource.split("\n"));
  const chunks = Chunk.build(original, proposed, { scanLimit: 2_000, timeout: 100 });
  return {
    chunks: chunks.slice(0, MAX_DIFF_CHUNKS).map((chunk) => ({
      originalStartLine: lineNumber(original, chunk.fromA),
      originalText: original.sliceString(chunk.fromA, chunk.endA),
      proposedStartLine: lineNumber(proposed, chunk.fromB),
      proposedText: proposed.sliceString(chunk.fromB, chunk.endB),
      precise: chunk.precise,
    })),
    truncated: chunks.length > MAX_DIFF_CHUNKS,
  };
}

export function proposalForRead(
  proposal: CellProposal,
  acceptedSource: string | null,
  includeDiff = true,
): Record<string, unknown> {
  return {
    changeKind: proposal.proposalKind,
    cellType: proposal.cellKind,
    ...(proposal.proposalKind === "insert"
      ? { afterCellId: proposal.afterCellId, beforeCellId: proposal.beforeCellId }
      : {}),
    state: proposal.state,
    proposalRevision: proposal.proposalRevision,
    ownerTurnId: proposal.ownerTurnId,
    acceptedSourceChanged: proposal.proposalKind === "source" && proposal.baseSource !== acceptedSource,
    ...(includeDiff ? { diff: proposalDiff(proposal) } : {}),
  };
}

export function reconcileCellProposal(
  proposal: CellProposal,
  acceptedCells: NotebookCell[],
): CellProposal | null {
  const cell = acceptedCells.find((item) => item.id === proposal.cellId);
  if (proposal.proposalKind === "insert") {
    if (cell) return null;
    const afterIndex = proposal.afterCellId === null
      ? -1
      : acceptedCells.findIndex((item) => item.id === proposal.afterCellId);
    const beforeIndex = proposal.beforeCellId === null
      ? acceptedCells.length
      : acceptedCells.findIndex((item) => item.id === proposal.beforeCellId);
    const positionIsValid = (proposal.afterCellId === null || afterIndex >= 0)
      && (proposal.beforeCellId === null || beforeIndex >= 0)
      && beforeIndex === afterIndex + 1;
    return {
      ...proposal,
      state: positionIsValid ? "review" : "conflict",
    };
  }
  if (!cell) return null;
  return {
    ...proposal,
    cellKind: cell.kind,
    state: proposal.baseSource === cell.source ? "review" : "conflict",
  };
}

export function cellFromInsertionProposal(proposal: CellProposal): NotebookCell {
  return {
    id: proposal.cellId,
    kind: proposal.cellKind,
    source: proposal.baseSource,
    metadata: {},
    executionCount: null,
    state: "idle",
    outputs: [],
  };
}

export function cellsWithInsertionProposals(
  acceptedCells: NotebookCell[],
  proposals: Record<string, CellProposal>,
): NotebookCell[] {
  const insertions = Object.values(proposals)
    .filter((proposal) => proposal.proposalKind === "insert")
    .sort((left, right) => left.createdAt - right.createdAt || left.cellId.localeCompare(right.cellId));
  if (!insertions.length) return acceptedCells;

  const result: NotebookCell[] = [];
  const rendered = new Set<string>();
  function appendMatching(predicate: (proposal: CellProposal) => boolean) {
    for (const proposal of insertions) {
      if (rendered.has(proposal.cellId) || !predicate(proposal)) continue;
      result.push(cellFromInsertionProposal(proposal));
      rendered.add(proposal.cellId);
    }
  }

  for (const cell of acceptedCells) {
    appendMatching((proposal) => proposal.beforeCellId === cell.id);
    result.push(cell);
    appendMatching((proposal) => (
      proposal.beforeCellId === null && proposal.afterCellId === cell.id
    ));
  }
  appendMatching((proposal) => proposal.afterCellId === null && proposal.beforeCellId === null);
  appendMatching(() => true);
  return result;
}

export function applyReviewedCellProposal(
  acceptedCells: NotebookCell[],
  proposal: CellProposal,
): NotebookCell[] {
  if (reconcileCellProposal(proposal, acceptedCells)?.state !== "review") {
    throw new ProposalInputError(
      "proposal_conflict",
      proposal.proposalKind === "insert"
        ? "The insertion position changed after this cell was proposed."
        : "The accepted cell source changed after this edit was proposed.",
    );
  }

  const nextCells = [...acceptedCells];
  if (proposal.proposalKind === "insert") {
    const beforeIndex = proposal.beforeCellId === null
      ? -1
      : acceptedCells.findIndex((cell) => cell.id === proposal.beforeCellId);
    const afterIndex = proposal.afterCellId === null
      ? -1
      : acceptedCells.findIndex((cell) => cell.id === proposal.afterCellId);
    const insertionIndex = beforeIndex >= 0 ? beforeIndex : afterIndex + 1;
    nextCells.splice(insertionIndex, 0, {
      ...cellFromInsertionProposal(proposal),
      source: proposal.draftSource,
    });
    return nextCells;
  }

  const cellIndex = acceptedCells.findIndex((cell) => cell.id === proposal.cellId);
  nextCells[cellIndex] = { ...nextCells[cellIndex], source: proposal.draftSource };
  return nextCells;
}
