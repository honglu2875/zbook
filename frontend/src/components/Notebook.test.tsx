import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CellProposal, CellProposalState } from "../model/cellProposals";
import type { NotebookCell } from "../model/notebook";
import { Notebook } from "./Notebook";

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

function proposal(state: CellProposalState): CellProposal {
  return {
    notebookPath: "analysis.ipynb",
    cellId: cell.id,
    baseSource: cell.source,
    draftSource: "answer = 42",
    baseDocumentRevision: 3,
    proposalRevision: 1,
    ownerThreadId: "thread-1",
    ownerTurnId: "turn-1",
    state,
    updatedAt: 1,
  };
}

function renderProposal(state: CellProposalState): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <Notebook
      path="analysis.ipynb"
      cells={[cell]}
      selectedId={cell.id}
      editingId={null}
      vimEnabled={false}
      saveState="saved"
      canRun
      locked={false}
      lockedCellIds={state === "streaming" ? [cell.id] : []}
      proposalActionsDisabled={state === "streaming"}
      cellProposals={{ [cell.id]: proposal(state) }}
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
    expect(markup).toContain("proposed cell edit");
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
});
