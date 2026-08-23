import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  CellProposal,
  CellProposalKind,
  CellProposalState,
} from "../model/cellProposals";
import type { NotebookCell } from "../model/notebook";
import { Notebook, type SaveState } from "./Notebook";

const cell: NotebookCell = {
  id: "cell-1",
  kind: "code",
  source: "answer = 41",
  metadata: {},
  executionCount: 1,
  state: "idle",
  outputs: [{
    type: "text",
    text: "41",
    raw: { output_type: "stream", name: "stdout", text: "41" },
  }],
};

function proposal(state: CellProposalState, proposalKind: CellProposalKind = "source"): CellProposal {
  return {
    notebookPath: "analysis.ipynb",
    cellId: cell.id,
    proposalKind,
    cellKind: "code",
    afterCellId: proposalKind === "insert" ? "anchor-cell" : null,
    beforeCellId: null,
    baseSource: proposalKind === "insert" ? "" : cell.source,
    draftSource: "answer = 42",
    baseDocumentRevision: 3,
    proposalRevision: 1,
    ownerThreadId: "thread-1",
    ownerTurnId: "turn-1",
    state,
    createdAt: 1,
    updatedAt: 1,
  };
}

function renderProposal(
  state: CellProposalState,
  proposalKind: CellProposalKind = "source",
  saveState: SaveState = "saved",
): string {
  const noop = () => undefined;
  const visibleCell = proposalKind === "insert" ? { ...cell, source: "" } : cell;
  return renderToStaticMarkup(
    <Notebook
      path="analysis.ipynb"
      cells={[visibleCell]}
      selectedId={cell.id}
      editingId={null}
      vimEnabled={false}
      saveState={saveState}
      canRun
      locked={false}
      lockedCellIds={state === "streaming" ? [cell.id] : []}
      proposalActionsDisabled={state === "streaming"}
      cellProposals={{ [cell.id]: proposal(state, proposalKind) }}
      codexChangedCellIds={[]}
      codexUndoAvailable={false}
      cellViews={{}}
      onSelect={noop}
      onEdit={noop}
      onChange={noop}
      onChangeKind={noop}
      onDelete={noop}
      onRun={noop}
      onAddAfter={noop}
      onReviewNextProposal={noop}
      onApplyProposal={noop}
      onRejectProposal={noop}
      onReviewCodexChange={noop}
      onUndoCodexChange={noop}
      onToggleCellView={noop}
      onSave={noop}
      onExport={noop}
      onReload={noop}
      onModeChange={noop}
      onStopEdit={noop}
      onQuoteSelection={noop}
    />,
  );
}

describe("Notebook proposal review", () => {
  it("shows turn progress without review actions while a proposal is streaming", () => {
    const markup = renderProposal("streaming");
    expect(markup).toContain("Codex is editing this cell");
    expect(markup).not.toContain(">Apply<");
    expect(markup).not.toContain(">Reject<");
  });

  it("shows review actions and marks accepted output as stale after the turn", () => {
    const markup = renderProposal("review");
    expect(markup).toContain("proposed cell change");
    expect(markup).toContain(">Apply<");
    expect(markup).toContain("Apply &amp; Run");
    expect(markup).toContain(">Reject<");
    expect(markup).toContain("Output from the accepted source");
  });

  it("disables apply actions for a conflicted proposal", () => {
    const markup = renderProposal("conflict");
    expect(markup).toContain("Accepted source changed");
    expect(markup).toMatch(/class="proposal-apply" disabled=""/);
    expect(markup).toMatch(/class="proposal-reject"/);
  });

  it("renders a proposed insertion with the same review controls", () => {
    const markup = renderProposal("review", "insert");
    expect(markup).toContain("is-proposal-insert");
    expect(markup).toContain("Review this proposed new code cell");
    expect(markup).toContain(">Apply<");
    expect(markup).toContain("Apply &amp; Run");
    expect(markup).toContain(">Reject<");
  });

  it("turns a disk conflict into an explicit resolve action", () => {
    const markup = renderProposal("review", "source", "conflict");

    expect(markup).toContain("Changed on disk");
    expect(markup).toContain(">Resolve<");
    expect(markup).toContain("Resolve external changes");
  });
});
