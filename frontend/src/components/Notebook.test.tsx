import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  CellProposal,
  CellProposalKind,
  CellProposalState,
} from "../model/cellProposals";
import type { NotebookCell } from "../model/notebook";
import { htmlOutputDocument, Notebook, type SaveState } from "./Notebook";

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

function renderCell(
  visibleCell: NotebookCell,
  {
    saveState = "saved",
    lockedCellIds = [],
    proposalActionsDisabled = false,
    cellProposals = {},
    queuePositions = {},
  }: {
    saveState?: SaveState;
    lockedCellIds?: string[];
    proposalActionsDisabled?: boolean;
    cellProposals?: Record<string, CellProposal>;
    queuePositions?: Record<string, number>;
  } = {},
): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <Notebook
      path="analysis.ipynb"
      cells={[visibleCell]}
      selectedId={cell.id}
      editingId={null}
      vimEnabled={false}
      lineWrapping
      tabSize={4}
      saveState={saveState}
      canRun
      locked={false}
      lockedCellIds={lockedCellIds}
      proposalActionsDisabled={proposalActionsDisabled}
      cellProposals={cellProposals}
      codexChangedCellIds={[]}
      codexUndoAvailable={false}
      cellViews={{}}
      queuePositions={queuePositions}
      onSelect={noop}
      onEdit={noop}
      onChange={noop}
      onChangeKind={noop}
      onDelete={noop}
      onRun={noop}
      onCancelQueuedFrom={noop}
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
      onRenderWidget={async () => noop}
      onModeChange={noop}
      onStopEdit={noop}
      onQuoteSelection={noop}
    />,
  );
}

function renderProposal(
  state: CellProposalState,
  proposalKind: CellProposalKind = "source",
  saveState: SaveState = "saved",
): string {
  const visibleCell = proposalKind === "insert" ? { ...cell, source: "" } : cell;
  return renderCell(visibleCell, {
    saveState,
    lockedCellIds: state === "streaming" ? [cell.id] : [],
    proposalActionsDisabled: state === "streaming",
    cellProposals: { [cell.id]: proposal(state, proposalKind) },
  });
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

describe("Notebook execution state", () => {
  it("keeps the active cell visually and accessibly prominent", () => {
    const markup = renderCell({ ...cell, state: "running" });

    expect(markup).toContain("is-running");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("cell-run-spinner");
    expect(markup).toContain("[…]");
  });

  it("shows queue position and suffix cancellation on pending cells", () => {
    const markup = renderCell(
      { ...cell, state: "queued" },
      { queuePositions: { [cell.id]: 2 } },
    );

    expect(markup).toContain("is-queued");
    expect(markup).toContain("Q2");
    expect(markup).toContain("Cancel queued cell Q2 and all later queued cells");
  });
});

describe("HTML notebook output", () => {
  it("gives pandas dataframes low-specificity dark-theme defaults", () => {
    const data = '<table class="dataframe"><thead><tr><th>value</th></tr></thead></table>';
    const document = htmlOutputDocument(data);

    expect(document).toContain('<meta name="color-scheme" content="dark">');
    expect(document).toContain(":where(table.dataframe)");
    expect(document).toContain("background:#1a1d1f");
    expect(document).toContain("tbody tr:nth-child(even)");
    expect(document).toContain(data);
    expect(document.indexOf("</style>")).toBeLessThan(document.indexOf(data));
  });
});

describe("terminal-style notebook output", () => {
  it("renders ANSI traceback styles without exposing controls or interpreting HTML", () => {
    const traceback = "\x1b[0;31mValueError\x1b[0m: <script>alert('no')</script>";
    const markup = renderCell({
      ...cell,
      outputs: [{
        type: "error",
        text: traceback,
        raw: {
          output_type: "error",
          ename: "ValueError",
          evalue: "unsafe text",
          traceback: [traceback],
        },
      }],
    });

    expect(markup).toContain('class="is-error has-ansi"');
    expect(markup).toContain('class="ansi-text-run"');
    expect(markup).toContain("color:#d4777a");
    expect(markup).toContain("&lt;script&gt;alert(&#x27;no&#x27;)&lt;/script&gt;");
    expect(markup).not.toContain("\x1b");
    expect(markup).not.toContain("<script>");
  });

  it("keeps plain errors on the existing non-ANSI rendering path", () => {
    const markup = renderCell({
      ...cell,
      outputs: [{
        type: "error",
        text: "ValueError: plain failure",
        raw: { output_type: "error", ename: "ValueError", evalue: "plain failure" },
      }],
    });

    expect(markup).toContain('class="is-error"');
    expect(markup).not.toContain("has-ansi");
    expect(markup).toContain("ValueError: plain failure");
  });
});
