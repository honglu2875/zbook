import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import type { NotebookCell } from "./notebook";

export type CellProposalState = "streaming" | "review" | "conflict";

export interface CellProposal {
  notebookPath: string;
  cellId: string;
  baseSource: string;
  draftSource: string;
  baseDocumentRevision: number;
  proposalRevision: number;
  ownerThreadId: string | null;
  ownerTurnId: string | null;
  state: CellProposalState;
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
  action: "stage_hunk" | "replace_proposal" | "discard_proposal";
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
  if (draftSource === baseSource) return null;
  return {
    notebookPath,
    cellId: cell.id,
    baseSource,
    draftSource,
    baseDocumentRevision: currentBaseIsValid ? current!.baseDocumentRevision : documentRevision,
    proposalRevision: nextRevision,
    ownerThreadId: owner.threadId,
    ownerTurnId: owner.turnId,
    state: "streaming",
    updatedAt: Date.now(),
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
      { currentProposalRevision: previousProposalRevision, lineCount: lines.length },
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
  acceptedSource: string,
  includeDiff = true,
): Record<string, unknown> {
  return {
    state: proposal.state,
    proposalRevision: proposal.proposalRevision,
    ownerTurnId: proposal.ownerTurnId,
    acceptedSourceChanged: proposal.baseSource !== acceptedSource,
    ...(includeDiff ? { diff: proposalDiff(proposal) } : {}),
  };
}

export function reconcileCellProposal(
  proposal: CellProposal,
  cell: NotebookCell | undefined,
): CellProposal | null {
  if (!cell) return null;
  return {
    ...proposal,
    state: proposal.baseSource === cell.source ? "review" : "conflict",
  };
}
