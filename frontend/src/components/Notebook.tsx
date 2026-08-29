import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { CellProposal } from "../model/cellProposals";
import type { CellKind, NotebookCell } from "../model/notebook";
import {
  selectionLineLabel,
  type CellTextSelection,
} from "../model/selectionContext";
import { primaryShortcut } from "../services/shortcuts";
import { CellEditor, type CellSelectionAction } from "./CellEditor";
import {
  ChevronIcon,
  CloseIcon,
  DownloadIcon,
  HeightIcon,
  LockIcon,
  PlayIcon,
  PlusIcon,
  PromptIcon,
  RefreshIcon,
  SaveIcon,
  TrashIcon,
} from "./icons";

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
export interface CellViewState {
  outputLimited?: boolean;
  cellCollapsed?: boolean;
}
export type CellViewOption = keyof CellViewState;

interface NotebookSelectionAction extends CellSelectionAction {
  cellId: string;
}

interface NotebookProps {
  path: string;
  cells: NotebookCell[];
  selectedId: string;
  editingId: string | null;
  vimEnabled: boolean;
  lineWrapping: boolean;
  tabSize: number;
  saveState: SaveState;
  canRun: boolean;
  locked: boolean;
  lockedCellIds: string[];
  proposalActionsDisabled: boolean;
  cellProposals: Record<string, CellProposal>;
  codexChangedCellIds: string[];
  codexUndoAvailable: boolean;
  cellViews: Record<string, CellViewState>;
  queuePositions: Record<string, number>;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onChange: (id: string, source: string) => void;
  onChangeKind: (id: string, kind: CellKind) => void;
  onDelete: (id: string) => void;
  onRun: (id: string, advance: boolean, insert: boolean) => void;
  onCancelQueuedFrom: (id: string) => void;
  onAddAfter: (id: string, kind: CellKind) => void;
  onReviewNextProposal: () => void;
  onApplyProposal: (id: string, runAfter: boolean) => void;
  onRejectProposal: (id: string) => void;
  onReviewCodexChange: () => void;
  onUndoCodexChange: () => void;
  onToggleCellView: (id: string, option: CellViewOption) => void;
  onSave: () => void;
  onExport: () => void;
  onReload: () => void;
  onRenderWidget: (modelId: string, element: HTMLElement) => Promise<() => void>;
  onModeChange: (mode: string) => void;
  onStopEdit: (id: string) => void;
  onQuoteSelection: (id: string, kind: CellKind, selection: CellTextSelection) => void;
}

const HTML_OUTPUT_THEME = `
:root{color-scheme:dark}
html,body{background:transparent}
body{margin:0;color:#aeb3b7;font:13px/1.45 system-ui,sans-serif}
pre{white-space:pre-wrap}
:where(table.dataframe){border-collapse:collapse;border:1px solid #34383c;background:#1a1d1f;color:#c4c8cc;font-variant-numeric:tabular-nums}
:where(table.dataframe) thead{background:#222528;color:#d8dade}
:where(table.dataframe) tbody tr:nth-child(even){background:#1e2124}
:where(table.dataframe) th,:where(table.dataframe) td{padding:5px 9px;border:1px solid #34383c}
:where(table.dataframe) th{font-weight:600}
:where(table.dataframe) tbody th{color:#9ca1a6;font-weight:500}
`;

export function htmlOutputDocument(data: string): string {
  return `<!doctype html><meta name="color-scheme" content="dark"><style>${HTML_OUTPUT_THEME}</style>${data}`;
}

function ImageOutput({ text, data }: { text: string; data: string }) {
  const image = useRef<HTMLImageElement>(null);
  const [scaled, setScaled] = useState(false);
  const [nativeSize, setNativeSize] = useState(false);
  const [dimensions, setDimensions] = useState("");

  useEffect(() => {
    setNativeSize(false);
  }, [data]);

  useEffect(() => {
    const element = image.current;
    if (!element) return;
    const measure = () => {
      if (!element.complete || element.naturalWidth === 0) return;
      setDimensions(`${element.naturalWidth} × ${element.naturalHeight}`);
      setScaled(
        element.naturalWidth > element.clientWidth + 1
        || element.naturalHeight > element.clientHeight + 1,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [data, nativeSize]);

  const canToggle = scaled || nativeSize;
  const toggleSize = () => {
    if (canToggle) setNativeSize((value) => !value);
  };
  const sizeAction = nativeSize
    ? "Click to fit the image to the output"
    : `Click to view the image at ${dimensions || "its original resolution"}`;

  return (
    <div
      className={`output-image-frame ${nativeSize ? "is-native-size" : ""} ${scaled ? "is-scaled" : ""}`}
      role={canToggle ? "button" : undefined}
      tabIndex={canToggle ? 0 : undefined}
      aria-label={canToggle ? sizeAction : undefined}
      aria-pressed={canToggle ? nativeSize : undefined}
      title={canToggle ? sizeAction : undefined}
      onClick={(event) => {
        if (!canToggle) return;
        event.preventDefault();
        event.stopPropagation();
        toggleSize();
      }}
      onKeyDown={(event) => {
        if (!canToggle || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
        toggleSize();
      }}
    >
      <img
        ref={image}
        className="output-image"
        src={`data:image/png;base64,${data}`}
        alt={text || "Cell output"}
        onLoad={() => {
          const element = image.current;
          if (!element) return;
          setDimensions(`${element.naturalWidth} × ${element.naturalHeight}`);
          setScaled(
            element.naturalWidth > element.clientWidth + 1
            || element.naturalHeight > element.clientHeight + 1,
          );
        }}
      />
    </div>
  );
}

function WidgetOutput({
  modelId,
  onRender,
}: {
  modelId: string;
  onRender: (modelId: string, element: HTMLElement) => Promise<() => void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let active = true;
    let dispose: (() => void) | null = null;
    setState("loading");
    setError("");
    void onRender(modelId, element).then((cleanup) => {
      if (!active) {
        cleanup();
        return;
      }
      dispose = cleanup;
      setState("ready");
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setState("error");
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, [modelId, onRender]);

  return (
    <div className="zbook-widget-output">
      <div ref={host} className="widget-output-host" />
      {state === "loading" && <div className="widget-output-state">Connecting interactive output…</div>}
      {state === "error" && <div className="widget-output-state is-error">{error}</div>}
    </div>
  );
}

function RichOutput({ cellId, index, type, text, data, onRenderWidget }: {
  cellId: string;
  index: number;
  type: "text" | "error" | "html" | "image" | "widget";
  text: string;
  data?: string;
  onRenderWidget: (modelId: string, element: HTMLElement) => Promise<() => void>;
}) {
  if (type === "widget" && data) {
    return <WidgetOutput modelId={data} onRender={onRenderWidget} />;
  }
  if (type === "image" && data) {
    return <ImageOutput text={text} data={data} />;
  }
  if (type === "html" && data) {
    return (
      <iframe
        className="output-html"
        key={`${cellId}-${index}`}
        sandbox=""
        srcDoc={htmlOutputDocument(data)}
        title={`Rich output ${index + 1}`}
      />
    );
  }
  return <pre className={type === "error" ? "is-error" : ""}>{text}</pre>;
}

function titleFromSource(cell: NotebookCell): string | null {
  if (cell.kind !== "code") return null;
  for (const line of cell.source.split("\n")) {
    const match = line.match(/^\s*#\s*@title(?:\s+(.*?))?\s*$/);
    const title = match?.[1]?.trim();
    if (title) return title;
  }
  return null;
}

export function Notebook({
  path,
  cells,
  selectedId,
  editingId,
  vimEnabled,
  lineWrapping,
  tabSize,
  saveState,
  canRun,
  locked,
  lockedCellIds,
  proposalActionsDisabled,
  cellProposals,
  codexChangedCellIds,
  codexUndoAvailable,
  cellViews,
  queuePositions,
  onSelect,
  onEdit,
  onChange,
  onChangeKind,
  onDelete,
  onRun,
  onCancelQueuedFrom,
  onAddAfter,
  onReviewNextProposal,
  onApplyProposal,
  onRejectProposal,
  onReviewCodexChange,
  onUndoCodexChange,
  onToggleCellView,
  onSave,
  onExport,
  onReload,
  onRenderWidget,
  onModeChange,
  onStopEdit,
  onQuoteSelection,
}: NotebookProps) {
  const [selectionAction, setSelectionAction] = useState<NotebookSelectionAction | null>(null);
  const filename = path.split("/").at(-1) ?? path;
  const title = filename.endsWith(".ipynb") ? filename.slice(0, -6) : filename;
  const saveLabel = {
    saved: "Saved",
    dirty: "Unsaved changes",
    saving: "Saving…",
    error: "Save failed",
    conflict: "Changed on disk",
  }[saveState];
  const proposals = Object.values(cellProposals);
  const reviewableProposals = proposals.filter((proposal) => proposal.state !== "streaming");
  const conflictCount = reviewableProposals.filter((proposal) => proposal.state === "conflict").length;
  const saveShortcut = primaryShortcut("S");

  return (
    <main className="notebook-scroll" aria-busy={locked}>
      <div className="notebook-canvas">
        <div className="notebook-title-row">
          <div className="notebook-title"><h1>{title}</h1><span>.ipynb</span></div>
          <div className="notebook-document-actions">
            <span className={`save-state save-${saveState}`}>{saveLabel}</span>
            <button onClick={onSave} disabled={saveState === "saving" || locked} title={saveState === "conflict" ? "Resolve external changes" : `Save notebook (${saveShortcut})`}><SaveIcon />{saveState === "conflict" ? "Resolve" : "Save"}</button>
            <button onClick={onReload} disabled={saveState === "saving" || locked || lockedCellIds.length > 0} title="Reload notebook from disk"><RefreshIcon />Reload</button>
            <button onClick={onExport} title="Export .ipynb"><DownloadIcon />Export</button>
          </div>
        </div>
        {proposals.length > 0 ? (
          <section className="codex-edit-review is-proposal-review" aria-live="polite">
            <div>
              <span>✦</span>
              <strong>{reviewableProposals.length > 0
                ? `${reviewableProposals.length} proposed cell change${reviewableProposals.length === 1 ? "" : "s"} await review`
                : `Codex is drafting ${proposals.length} cell${proposals.length === 1 ? "" : "s"}`}</strong>
              {conflictCount > 0 && <em>{conflictCount} conflicted</em>}
            </div>
            <div>
              <button type="button" onClick={onReviewNextProposal} disabled={reviewableProposals.length === 0}>Review next</button>
            </div>
          </section>
        ) : codexChangedCellIds.length > 0 && (
          <section className="codex-edit-review" aria-live="polite">
            <div><span>✦</span><strong>Codex changed {codexChangedCellIds.length} cell{codexChangedCellIds.length === 1 ? "" : "s"}</strong></div>
            <div>
              <button type="button" onClick={onReviewCodexChange}>Review</button>
              <button type="button" onClick={onUndoCodexChange} disabled={!codexUndoAvailable}>Undo</button>
            </div>
          </section>
        )}
        {cells.map((cell) => {
          const selected = selectedId === cell.id;
          const proposal = cellProposals[cell.id];
          const displaySource = proposal?.draftSource ?? cell.source;
          const editing = editingId === cell.id && !proposal;
          const changedByCodex = codexChangedCellIds.includes(cell.id);
          const queuePosition = queuePositions[cell.id] ?? null;
          const running = cell.state === "running";
          const queued = cell.state === "queued";
          const codexLocked = lockedCellIds.includes(cell.id);
          const cellLocked = locked || codexLocked || Boolean(proposal);
          const view = cellViews[cell.id] ?? {};
          const cellTitle = titleFromSource({ ...cell, source: displaySource });
          const titleCollapsed = Boolean(cellTitle && view.cellCollapsed && !proposal);
          const canLimitOutput = cell.outputs.length > 0 && !titleCollapsed;
          const activeSelection = selectionAction?.cellId === cell.id ? selectionAction : null;
          return (
            <div className="notebook-cell-group" key={cell.id}>
              <article
                data-cell-id={cell.id}
                className={`notebook-cell ${cellTitle ? "has-cell-title" : ""} ${selected ? "is-selected" : ""} ${editing ? "is-editing" : ""} ${cellLocked ? "is-locked" : ""} ${running ? "is-running" : ""} ${queued ? "is-queued" : ""} ${codexLocked ? "is-codex-locked" : ""} ${changedByCodex ? "is-codex-changed" : ""} ${proposal ? "has-codex-proposal" : ""} ${proposal?.proposalKind === "insert" ? "is-proposal-insert" : ""} ${proposal?.state === "streaming" ? "is-proposal-streaming" : ""} ${proposal?.state === "review" ? "is-proposal-review" : ""} ${proposal?.state === "conflict" ? "is-proposal-conflict" : ""} ${view.outputLimited ? "has-limited-output" : ""} ${titleCollapsed ? "is-title-collapsed" : ""}`}
                tabIndex={0}
                aria-busy={running || undefined}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) onSelect(cell.id);
                }}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest(".cell-editor")) return;
                  onSelect(cell.id);
                  event.currentTarget.focus({ preventScroll: true });
                }}
                onDoubleClick={(event) => {
                  if ((event.target as HTMLElement).closest(".cell-editor")) return;
                  if (!cellLocked) onEdit(cell.id);
                }}
                aria-label={`${proposal?.proposalKind === "insert" ? "proposed new " : ""}${cell.kind} cell${running ? ", running" : queued ? `, queued at position ${queuePosition ?? "unknown"}` : ""}${codexLocked ? ", locked by Codex" : ""}${proposal ? ", with a Codex proposal" : ""}`}
              >
                <div
                  className="cell-rail"
                  onDoubleClick={(event) => {
                    if (!canLimitOutput) return;
                    event.preventDefault();
                    event.stopPropagation();
                    onToggleCellView(cell.id, "outputLimited");
                  }}
                />
                {!titleCollapsed && (
                  <div className="cell-actions" onDoubleClick={(event) => event.stopPropagation()}>
                    {cell.outputs.length > 0 && (
                      <button
                        className={view.outputLimited ? "is-active" : ""}
                        disabled={locked}
                        onClick={(event) => { event.stopPropagation(); onToggleCellView(cell.id, "outputLimited"); }}
                        aria-label={view.outputLimited ? "Show full output height" : "Limit output height"}
                        aria-pressed={Boolean(view.outputLimited)}
                        title={view.outputLimited ? "Show full output height" : "Limit output height"}
                      ><HeightIcon /></button>
                    )}
                    <select
                      value={cell.kind}
                      disabled={cellLocked || running || queued}
                      onChange={(event) => onChangeKind(cell.id, event.target.value as CellKind)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label="Cell type"
                    >
                      <option value="code">Code</option>
                      <option value="markdown">Markdown</option>
                      <option value="raw">Raw</option>
                    </select>
                    <button className="cell-delete" disabled={cellLocked || running || queued} onClick={(event) => { event.stopPropagation(); onDelete(cell.id); }} aria-label="Delete cell" title="Delete cell"><TrashIcon /></button>
                  </div>
                )}
                {cellTitle && (
                  <header className="cell-title-bar" onDoubleClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      className="cell-title-toggle"
                      onClick={(event) => { event.stopPropagation(); onToggleCellView(cell.id, "cellCollapsed"); }}
                      disabled={locked}
                      aria-label={titleCollapsed ? `Expand ${cellTitle}` : `Collapse ${cellTitle}`}
                      aria-expanded={!titleCollapsed}
                      title={titleCollapsed ? "Expand titled cell" : "Collapse titled cell"}
                    ><ChevronIcon /></button>
                    <h2>{cellTitle}</h2>
                    {titleCollapsed && codexLocked && <span className="cell-title-lock" title="Locked by Codex for this turn"><LockIcon /></span>}
                  </header>
                )}
                <div
                  className="cell-gutter"
                  title={canLimitOutput
                    ? view.outputLimited
                      ? "Double-click to show the full output"
                      : "Double-click to limit output height"
                    : undefined}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    if (!canLimitOutput || (event.target as HTMLElement).closest("button")) return;
                    event.preventDefault();
                    onToggleCellView(cell.id, "outputLimited");
                  }}
                >
                  {!titleCollapsed && (cell.kind === "code" ? (
                    <>
                      {running ? (
                        <span className="cell-run-spinner" aria-hidden="true" />
                      ) : queued ? (
                        <button
                          type="button"
                          className="run-button queue-cancel"
                          onClick={(event) => { event.stopPropagation(); onCancelQueuedFrom(cell.id); }}
                          aria-label={`Cancel queued cell Q${queuePosition ?? ""} and all later queued cells`}
                          title="Cancel this and later queued runs"
                        ><CloseIcon /></button>
                      ) : (
                        <button
                          type="button"
                          className="run-button"
                          disabled={cellLocked || !canRun}
                          onClick={(event) => { event.stopPropagation(); onRun(cell.id, false, false); }}
                          aria-label="Run cell"
                          title={canRun ? "Run cell" : "Prepare the Python kernel from the environment panel"}
                        >
                          <PlayIcon />
                        </button>
                      )}
                      <span className={`execution-count ${running ? "is-running" : queued ? "is-queued" : ""}`}>
                        {running ? "[…]" : queued ? `Q${queuePosition ?? "?"}` : cell.executionCount === null ? "[ ]" : `[${cell.executionCount}]`}
                      </span>
                    </>
                  ) : <span className="markdown-mark">{cell.kind === "markdown" ? "M" : "R"}</span>)}
                  {!titleCollapsed && codexLocked && <span className="cell-codex-lock" title="Locked by Codex for this turn"><LockIcon /></span>}
                  {!titleCollapsed && view.outputLimited && <span className="cell-scroll-state" aria-hidden="true">↕</span>}
                  {!titleCollapsed && activeSelection && (
                    <button
                      type="button"
                      className="cell-selection-action"
                      style={{ top: activeSelection.top }}
                      disabled={activeSelection.selection.tooLarge}
                      title={activeSelection.selection.tooLarge
                        ? "Select no more than 200 lines or 20,000 characters"
                        : `Quote ${selectionLineLabel(activeSelection.selection)} to Codex`}
                      aria-label={activeSelection.selection.tooLarge
                        ? "Selection is too large to quote to Codex"
                        : `Ask Codex about ${selectionLineLabel(activeSelection.selection).toLowerCase()}`}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!activeSelection.selection.tooLarge) {
                          onQuoteSelection(cell.id, cell.kind, activeSelection.selection);
                        }
                      }}
                    >
                      <PromptIcon />
                      {activeSelection.selection.tooLarge ? "Limit" : "Ask"}
                    </button>
                  )}
                </div>
                <div className="cell-body">
                  {!titleCollapsed && (
                    <>
                      <div className="cell-source">
                        {cell.kind === "markdown" && !editing && !proposal ? (
                          <div
                            className="markdown-rendered"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!cellLocked) onEdit(cell.id);
                            }}
                          >
                            <ReactMarkdown>{cell.source}</ReactMarkdown>
                          </div>
                        ) : (
                          <CellEditor
                            kind={cell.kind}
                            source={displaySource}
                            diffOriginal={proposal?.baseSource}
                            editing={editing}
                            vimEnabled={vimEnabled}
                            lineWrapping={lineWrapping}
                            tabSize={tabSize}
                            readOnly={cellLocked}
                            onChange={(source) => onChange(cell.id, source)}
                            onRun={(advance, insert) => onRun(cell.id, advance, insert)}
                            onFocus={() => {
                              if (cellLocked) onSelect(cell.id);
                              else onEdit(cell.id);
                            }}
                            onModeChange={(nextMode) => {
                              onModeChange(nextMode);
                              if (nextMode === "NAV") onStopEdit(cell.id);
                            }}
                            onSelectionActionChange={(action) => setSelectionAction((current) => (
                              action
                                ? { ...action, cellId: cell.id }
                                : current?.cellId === cell.id
                                  ? null
                                  : current
                            ))}
                          />
                        )}
                      </div>
                      {proposal && (
                        <div className="cell-proposal-actions" onClick={(event) => event.stopPropagation()}>
                          {proposal.state === "streaming" ? (
                            <span>
                              <i />
                              {proposal.proposalKind === "insert"
                                ? `Codex is drafting this new ${proposal.cellKind} cell…`
                                : "Codex is editing this cell…"}
                            </span>
                          ) : (
                            <>
                              <span className={proposal.state === "conflict" ? "is-conflict" : ""}>
                                {proposal.state === "conflict"
                                  ? proposal.proposalKind === "insert"
                                    ? "Insertion point changed; replace or reject this proposed cell"
                                    : "Accepted source changed; replace or reject this proposal"
                                  : proposal.proposalKind === "insert"
                                    ? `Review this proposed new ${proposal.cellKind} cell`
                                    : "Review this proposed change"}
                              </span>
                              <div>
                                <button
                                  type="button"
                                  className="proposal-apply"
                                  disabled={proposalActionsDisabled || locked || codexLocked || proposal.state === "conflict"}
                                  onClick={() => onApplyProposal(cell.id, false)}
                                >Apply</button>
                                {cell.kind === "code" && (
                                  <button
                                    type="button"
                                    className="proposal-apply-run"
                                    disabled={proposalActionsDisabled || locked || codexLocked || proposal.state === "conflict" || !canRun}
                                    onClick={() => onApplyProposal(cell.id, true)}
                                  >Apply &amp; Run</button>
                                )}
                                <button
                                  type="button"
                                  className="proposal-reject"
                                  disabled={proposalActionsDisabled || locked || codexLocked}
                                  onClick={() => onRejectProposal(cell.id)}
                                >Reject</button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      {cell.outputs.length > 0 && (
                        <div className={`cell-output ${proposal ? "is-proposal-stale" : ""} ${view.outputLimited ? "is-height-limited" : ""}`}>
                          {proposal && <div className="cell-output-context">Output from the accepted source</div>}
                          {cell.outputs.map((output, index) => (
                            <RichOutput
                              key={`${cell.id}-${index}`}
                              cellId={cell.id}
                              index={index}
                              onRenderWidget={onRenderWidget}
                              {...output}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </article>
              <div className="cell-insert-controls" role="group" aria-label={`Insert a cell after this ${cell.kind} cell`}>
                <button disabled={cellLocked} onClick={() => onAddAfter(cell.id, "code")}><PlusIcon />Code</button>
                <button disabled={cellLocked} onClick={() => onAddAfter(cell.id, "markdown")}><PlusIcon />Markdown</button>
              </div>
            </div>
          );
        })}
        <div className="notebook-spacer" />
      </div>
    </main>
  );
}
