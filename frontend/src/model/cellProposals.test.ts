import { describe, expect, it } from "vitest";
import type { NotebookCell } from "./notebook";
import {
  applyProposalOperation,
  proposalDiff,
  ProposalInputError,
  reconcileCellProposal,
  type CellProposal,
} from "./cellProposals";

function cell(source = "alpha\nbeta\ngamma"): NotebookCell {
  return {
    id: "cell-1",
    kind: "code",
    source,
    metadata: {},
    executionCount: null,
    state: "idle",
    outputs: [],
  };
}

const owner = { threadId: "thread-1", turnId: "turn-1" };

function stage(current: CellProposal | null, overrides: Record<string, unknown> = {}) {
  return applyProposalOperation(
    cell(),
    current,
    {
      action: "stage_hunk",
      expectedProposalRevision: current?.proposalRevision ?? 0,
      startLine: 2,
      oldLines: ["beta"],
      newLines: ["BETA"],
      ...overrides,
    },
    "analysis.ipynb",
    7,
    owner,
  );
}

describe("cell proposals", () => {
  it("stages exact hunks without changing the accepted cell", () => {
    const accepted = cell();
    const result = applyProposalOperation(
      accepted,
      null,
      {
        action: "stage_hunk",
        expectedProposalRevision: 0,
        startLine: 2,
        oldLines: ["beta"],
        newLines: ["BETA", "inserted"],
      },
      "analysis.ipynb",
      7,
      owner,
    );

    expect(accepted.source).toBe("alpha\nbeta\ngamma");
    expect(result.proposal?.baseSource).toBe(accepted.source);
    expect(result.proposal?.draftSource).toBe("alpha\nBETA\ninserted\ngamma");
    expect(result.proposal?.proposalRevision).toBe(1);
    expect(result.proposal?.state).toBe("streaming");
  });

  it("applies sequential hunks against the latest proposal revision", () => {
    const first = stage(null).proposal;
    expect(first).not.toBeNull();

    const second = stage(first, {
      expectedProposalRevision: 1,
      startLine: 3,
      oldLines: [],
      newLines: ["between"],
    });

    expect(second.proposal?.draftSource).toBe("alpha\nBETA\nbetween\ngamma");
    expect(second.proposal?.proposalRevision).toBe(2);
  });

  it("rejects stale revisions and mismatched line context", () => {
    const first = stage(null).proposal;
    expect(() => stage(first, { expectedProposalRevision: 0 })).toThrow(ProposalInputError);

    try {
      stage(first, { oldLines: ["not beta"] });
      throw new Error("Expected context mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(ProposalInputError);
      expect((error as ProposalInputError).code).toBe("hunk_context_mismatch");
    }
  });

  it("requires whole-proposal resolution after a prior turn", () => {
    const prior = { ...stage(null).proposal!, state: "review" as const };
    expect(() => stage(prior)).toThrowError(/earlier turn/);

    const replaced = applyProposalOperation(
      cell(),
      prior,
      {
        action: "replace_proposal",
        expectedProposalRevision: 1,
        source: "entire replacement",
      },
      "analysis.ipynb",
      8,
      { threadId: "thread-1", turnId: "turn-2" },
    );
    expect(replaced.proposal?.draftSource).toBe("entire replacement");
    expect(replaced.proposal?.proposalRevision).toBe(2);
    expect(replaced.proposal?.ownerTurnId).toBe("turn-2");
  });

  it("discards a complete proposal and computes review chunks", () => {
    const proposal = stage(null).proposal!;
    const diff = proposalDiff(proposal);
    expect(diff.chunks.length).toBeGreaterThan(0);
    expect(diff.chunks.some((chunk) => chunk.originalText.includes("beta"))).toBe(true);
    expect(diff.chunks.some((chunk) => chunk.proposedText.includes("BETA"))).toBe(true);

    const discarded = applyProposalOperation(
      cell(),
      proposal,
      { action: "discard_proposal", expectedProposalRevision: 1 },
      "analysis.ipynb",
      7,
      owner,
    );
    expect(discarded.proposal).toBeNull();
  });

  it("marks recovered proposals as reviewable or conflicted", () => {
    const proposal = stage(null).proposal!;
    expect(reconcileCellProposal(proposal, cell())?.state).toBe("review");
    expect(reconcileCellProposal(proposal, cell("changed externally"))?.state).toBe("conflict");
    expect(reconcileCellProposal(proposal, undefined)).toBeNull();
  });
});
