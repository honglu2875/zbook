import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CodexPanel } from "./components/CodexPanel";
import { CommandPalette, type PaletteCommand, type PaletteFile } from "./components/CommandPalette";
import { EnvironmentPanel } from "./components/EnvironmentPanel";
import { FileTree } from "./components/FileTree";
import { BranchIcon, CloseIcon, PanelIcon, PlayIcon, PlusIcon, SearchIcon, StopIcon } from "./components/icons";
import {
  Notebook,
  type CellViewOption,
  type CellViewState,
  type SaveState,
} from "./components/Notebook";
import {
  cellsFromNotebook,
  newCell,
  notebookFromCells,
  type CellKind,
  type NotebookCell,
  type RawNotebook,
} from "./model/notebook";
import {
  applyProposalOperation,
  proposalForRead,
  reconcileCellProposal,
  ProposalInputError,
  type CellProposal,
} from "./model/cellProposals";
import {
  applyNotebookOperations,
  NOTEBOOK_APPLY_TOOL,
  NOTEBOOK_LOCK_TOOL,
  NOTEBOOK_PROPOSE_TOOL,
  NOTEBOOK_READ_TOOL,
  NotebookToolInputError,
  parseNotebookToolArguments,
  type NotebookToolContext,
  type NotebookToolResponse,
} from "./model/notebookTools";
import {
  createDirectory,
  createNotebook,
  deleteEntry,
  listDirectory,
  readNotebook,
  renameEntry,
  saveNotebook,
  uploadFile,
  type ContentEntry,
} from "./services/contents";
import { appUrl, requestJson } from "./services/http";
import { selectEnvironment } from "./services/environment";
import {
  loadCellProposals,
  removeCellProposal,
  storeCellProposal,
} from "./services/proposalStore";
import {
  KernelClient,
  type ExecutionResult,
  type KernelState,
} from "./services/kernel";

interface ServerStatus {
  ok: boolean;
  config: {
    workspace: string;
    venv: string;
    python: string;
    environment_mode: string;
  };
  tools: { uv: string | null; codex: string | null };
  kernel: {
    name: string;
    ready: boolean;
    version: string | null;
    python_version: string | null;
    error: string | null;
  };
}

interface WorkspaceSession {
  openTabs: string[];
  activePath: string | null;
  selectedByNotebook: Record<string, string>;
  treeDirectory: string;
  leftOpen: boolean;
  rightOpen: boolean;
  // Kept only long enough to migrate workspace-scoped preferences from v0.1.0.
  vimEnabled?: boolean;
  cellViewsByNotebook: Record<string, Record<string, CellViewState>>;
}

interface CodexEditReview {
  notebookPath: string;
  affectedCellIds: string[];
  beforeCells: NotebookCell[];
  beforeMetadata: Record<string, unknown>;
  beforeSelectedId: string;
  afterRevision: number;
}

interface CellStructureSnapshot {
  cells: NotebookCell[];
  selectedId: string;
  cellViews: Record<string, CellViewState>;
  label: string;
}

interface CellStructureHistory {
  undo: CellStructureSnapshot[];
  redo: CellStructureSnapshot[];
  expectedCellIds: string[];
}

interface PendingCellDelete {
  cellId: string;
  timer: number;
}

type PaneSide = "left" | "right";
type CellProposalsByNotebook = Record<string, Record<string, CellProposal>>;

const LEFT_PANE_DEFAULT = 226;
const RIGHT_PANE_DEFAULT = 348;
const LEFT_PANE_MIN = 170;
const RIGHT_PANE_MIN = 270;
const LEFT_PANE_MAX = 520;
const RIGHT_PANE_MAX = 620;
const MIN_NOTEBOOK_WIDTH = 360;
const LEFT_PANE_STORAGE = "zbook.layout.leftWidth";
const RIGHT_PANE_STORAGE = "zbook.layout.rightWidth";
const USER_PREFERENCES_STORAGE = "zbook.preferences.v1";
const WORKSPACE_SESSION_VERSION = 1;
const CELL_STRUCTURE_HISTORY_LIMIT = 100;
const VIM_KEY_SEQUENCE_TIMEOUT_MS = 500;
const NOTEBOOK_AVAILABLE_ACTIONS = [
  { capability: "read_cells", tool: NOTEBOOK_READ_TOOL },
  {
    action: "lock",
    tool: NOTEBOOK_LOCK_TOOL,
    note: "Lock relevant existing cells before further reasoning or editing.",
  },
  { action: "unlock", tool: NOTEBOOK_LOCK_TOOL },
  {
    action: "stage_hunk",
    tool: NOTEBOOK_PROPOSE_TOOL,
    note: "One coherent source hunk per call; the user reviews proposals before saving.",
  },
  { action: "replace_proposal", tool: NOTEBOOK_PROPOSE_TOOL },
  { action: "discard_proposal", tool: NOTEBOOK_PROPOSE_TOOL },
  {
    capability: "structural_operations",
    tool: NOTEBOOK_APPLY_TOOL,
    operations: ["set_kind", "insert_after", "delete", "move_after", "swap"],
  },
] as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function cellIds(cells: NotebookCell[]): string[] {
  return cells.map((cell) => cell.id);
}

function sameCellIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function storedPaneWidth(key: string, fallback: number, minimum: number, maximum: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? clamp(value, minimum, maximum) : fallback;
  } catch {
    return fallback;
  }
}

function storePaneWidth(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // Layout persistence is optional when browser storage is unavailable.
  }
}

function storedUserPreferences(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(USER_PREFERENCES_STORAGE) ?? "null") as Record<string, unknown> | null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function storedVimPreference(): boolean | null {
  const value = storedUserPreferences().vimEnabled;
  return typeof value === "boolean" ? value : null;
}

function storeVimPreference(vimEnabled: boolean) {
  try {
    const preferences = storedUserPreferences();
    window.localStorage.setItem(USER_PREFERENCES_STORAGE, JSON.stringify({ ...preferences, vimEnabled }));
  } catch {
    // Preference persistence is optional when browser storage is unavailable.
  }
}

function parentPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function isSameOrChild(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function workspaceSessionKey(workspace: string): string {
  return `zbook.workspace.session.v${WORKSPACE_SESSION_VERSION}:${workspace}`;
}

function storedCellViews(value: unknown): Record<string, Record<string, CellViewState>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const notebooks: Record<string, Record<string, CellViewState>> = {};
  for (const [notebookPath, cellValue] of Object.entries(value)) {
    if (!cellValue || typeof cellValue !== "object" || Array.isArray(cellValue)) continue;
    const cells: Record<string, CellViewState> = {};
    for (const [cellId, viewValue] of Object.entries(cellValue)) {
      if (!viewValue || typeof viewValue !== "object" || Array.isArray(viewValue)) continue;
      const record = viewValue as Record<string, unknown>;
      const view: CellViewState = {};
      if (
        record.outputLimited === true
        || record.scrollLimited === true
        || record.outputCollapsed === true
      ) view.outputLimited = true;
      if (record.cellCollapsed === true) view.cellCollapsed = true;
      if (Object.keys(view).length) cells[cellId] = view;
    }
    if (Object.keys(cells).length) notebooks[notebookPath] = cells;
  }
  return notebooks;
}

function loadWorkspaceSession(workspace: string): WorkspaceSession {
  const fallback: WorkspaceSession = {
    openTabs: [],
    activePath: null,
    selectedByNotebook: {},
    treeDirectory: "",
    leftOpen: true,
    rightOpen: true,
    cellViewsByNotebook: {},
  };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(workspaceSessionKey(workspace)) ?? "null") as Record<string, unknown> | null;
    if (!parsed) return fallback;
    const openTabs = Array.isArray(parsed.openTabs)
      ? [...new Set(parsed.openTabs.filter((path): path is string => (
        typeof path === "string" && path.toLowerCase().endsWith(".ipynb")
      )))]
      : [];
    const selectedByNotebook = parsed.selectedByNotebook && typeof parsed.selectedByNotebook === "object"
      ? Object.fromEntries(Object.entries(parsed.selectedByNotebook as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    const activePath = typeof parsed.activePath === "string" && openTabs.includes(parsed.activePath)
      ? parsed.activePath
      : openTabs[0] ?? null;
    return {
      openTabs,
      activePath,
      selectedByNotebook,
      treeDirectory: typeof parsed.treeDirectory === "string" ? parsed.treeDirectory : "",
      leftOpen: typeof parsed.leftOpen === "boolean" ? parsed.leftOpen : true,
      rightOpen: typeof parsed.rightOpen === "boolean" ? parsed.rightOpen : true,
      vimEnabled: typeof parsed.vimEnabled === "boolean" ? parsed.vimEnabled : undefined,
      cellViewsByNotebook: storedCellViews(parsed.cellViewsByNotebook),
    };
  } catch {
    return fallback;
  }
}

function cloneDocumentValue<T>(value: T): T {
  return structuredClone(value);
}

export default function App() {
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [metadata, setMetadata] = useState<Record<string, unknown>>({});
  const [notebookPath, setNotebookPath] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mode, setMode] = useState("NAV");
  const [vimEnabled, setVimEnabled] = useState(() => storedVimPreference() ?? false);
  const [vimKeymapOpen, setVimKeymapOpen] = useState(false);
  const [pendingCellDeleteId, setPendingCellDeleteId] = useState<string | null>(null);
  const [userPreferencesReady, setUserPreferencesReady] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftPaneWidth, setLeftPaneWidth] = useState(() => storedPaneWidth(
    LEFT_PANE_STORAGE,
    LEFT_PANE_DEFAULT,
    LEFT_PANE_MIN,
    LEFT_PANE_MAX,
  ));
  const [rightPaneWidth, setRightPaneWidth] = useState(() => storedPaneWidth(
    RIGHT_PANE_STORAGE,
    RIGHT_PANE_DEFAULT,
    RIGHT_PANE_MIN,
    RIGHT_PANE_MAX,
  ));
  const [renamingTabPath, setRenamingTabPath] = useState<string | null>(null);
  const [renamingTabName, setRenamingTabName] = useState("");
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [directories, setDirectories] = useState<Record<string, ContentEntry[]>>({});
  const [treeDirectory, setTreeDirectory] = useState("");
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set([""]));
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [kernelState, setKernelState] = useState<KernelState>("disconnected");
  const [busy, setBusy] = useState(false);
  const [notebookToolLocked, setNotebookToolLocked] = useState(false);
  const [codexTurnActive, setCodexTurnActive] = useState(false);
  const [codexCellLocks, setCodexCellLocks] = useState<Record<string, string[]>>({});
  const [cellProposalsByNotebook, setCellProposalsByNotebook] = useState<CellProposalsByNotebook>({});
  const [codexEditReview, setCodexEditReview] = useState<CodexEditReview | null>(null);
  const [workspaceSessionReady, setWorkspaceSessionReady] = useState(false);
  const [paletteMode, setPaletteMode] = useState<"files" | "commands" | null>(null);
  const [paletteFiles, setPaletteFiles] = useState<PaletteFile[]>([]);
  const [paletteLoading, setPaletteLoading] = useState(false);
  const [cellViewsByNotebook, setCellViewsByNotebook] = useState<Record<string, Record<string, CellViewState>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const notebookToolLockedRef = useRef(false);
  const codexTurnActiveRef = useRef(false);
  const codexCellLocksRef = useRef<Record<string, string[]>>({});
  const cellProposalsRef = useRef<CellProposalsByNotebook>({});
  const directoriesRef = useRef(directories);
  const openTabsRef = useRef(openTabs);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const directoryRequestVersions = useRef<Record<string, number>>({});
  const selectedByNotebook = useRef<Record<string, string>>({});
  const selectedIdRef = useRef(selectedId);
  const cellViewsByNotebookRef = useRef(cellViewsByNotebook);
  const cellStructureHistories = useRef(new Map<string, CellStructureHistory>());
  const pendingCellDeleteRef = useRef<PendingCellDelete | null>(null);
  const vimKeymapRef = useRef<HTMLDivElement | null>(null);
  const restoredWorkspace = useRef<string | null>(null);
  const kernelClient = useRef<KernelClient | null>(null);
  if (kernelClient.current === null) kernelClient.current = new KernelClient(setKernelState);
  const documentRef = useRef({ cells, metadata, notebookPath, saveState });
  documentRef.current = { cells, metadata, notebookPath, saveState };
  directoriesRef.current = directories;
  openTabsRef.current = openTabs;
  selectedIdRef.current = selectedId;
  cellViewsByNotebookRef.current = cellViewsByNotebook;

  useEffect(() => {
    void refreshStatus();
    void loadDirectory("", true);
  }, []);

  useEffect(() => {
    const workspace = status?.config.workspace;
    if (!workspace || restoredWorkspace.current === workspace) return;
    restoredWorkspace.current = workspace;
    setWorkspaceSessionReady(false);
    replaceCellProposals({});
    const session = loadWorkspaceSession(workspace);
    selectedByNotebook.current = session.selectedByNotebook;
    openTabsRef.current = session.openTabs;
    setOpenTabs(session.openTabs);
    setTreeDirectory(session.treeDirectory);
    setLeftOpen(session.leftOpen);
    setRightOpen(session.rightOpen);
    const storedVimEnabled = storedVimPreference();
    const restoredVimEnabled = storedVimEnabled ?? session.vimEnabled ?? false;
    setVimEnabled(restoredVimEnabled);
    if (storedVimEnabled === null) storeVimPreference(restoredVimEnabled);
    setUserPreferencesReady(true);
    setCellViewsByNotebook(session.cellViewsByNotebook);
    let cancelled = false;
    void (async () => {
      try {
        const storedProposals = await loadCellProposals(workspace);
        if (cancelled) return;
        const restoredProposals: CellProposalsByNotebook = {};
        for (const proposal of storedProposals) {
          const notebookProposals = restoredProposals[proposal.notebookPath] ?? {};
          notebookProposals[proposal.cellId] = proposal;
          restoredProposals[proposal.notebookPath] = notebookProposals;
        }
        replaceCellProposals(restoredProposals);
      } catch {
        if (cancelled) return;
        replaceCellProposals({});
      }
      const candidates = [session.activePath, ...session.openTabs]
        .filter((path, index, values): path is string => Boolean(path) && values.indexOf(path) === index);
      let restored = false;
      const unavailable = new Set<string>();
      for (const path of candidates) {
        if (await loadNotebookDocument(path, false, session.selectedByNotebook[path])) {
          restored = true;
          break;
        }
        unavailable.add(path);
      }
      const remainingTabs = session.openTabs.filter((path) => !unavailable.has(path));
      openTabsRef.current = remainingTabs;
      setOpenTabs(remainingTabs);
      if (!restored) resetNotebookDocument();
      if (!cancelled) setWorkspaceSessionReady(true);
    })();
    return () => { cancelled = true; };
  }, [status?.config.workspace]);

  useEffect(() => {
    const workspace = status?.config.workspace;
    if (!workspace || !workspaceSessionReady || restoredWorkspace.current !== workspace) return;
    const selections = { ...selectedByNotebook.current };
    if (notebookPath && selectedId) selections[notebookPath] = selectedId;
    selectedByNotebook.current = selections;
    const session: WorkspaceSession = {
      openTabs,
      activePath: notebookPath,
      selectedByNotebook: selections,
      treeDirectory,
      leftOpen,
      rightOpen,
      cellViewsByNotebook,
    };
    try {
      window.localStorage.setItem(workspaceSessionKey(workspace), JSON.stringify(session));
    } catch {
      // Session restoration is optional when browser storage is unavailable.
    }
  }, [cellViewsByNotebook, leftOpen, notebookPath, openTabs, rightOpen, selectedId, status?.config.workspace, treeDirectory, workspaceSessionReady]);

  useEffect(() => {
    if (userPreferencesReady) storeVimPreference(vimEnabled);
  }, [userPreferencesReady, vimEnabled]);

  useEffect(() => {
    if (!vimKeymapOpen) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!vimKeymapRef.current?.contains(event.target as Node)) setVimKeymapOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setVimKeymapOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [vimKeymapOpen]);

  useEffect(() => () => {
    void kernelClient.current?.shutdown();
    if (pendingCellDeleteRef.current) window.clearTimeout(pendingCellDeleteRef.current.timer);
    document.body.classList.remove("is-resizing-pane");
  }, []);

  useEffect(() => {
    if (saveState !== "dirty" || !notebookPath) return;
    const timer = window.setTimeout(() => void persistNotebook(), 900);
    return () => window.clearTimeout(timer);
  }, [cells, metadata, notebookPath, saveState]);

  useEffect(() => {
    function handleGlobalKeys(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        openCommandPalette(event.shiftKey ? "commands" : "files");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void persistNotebook();
        return;
      }
      if (mode !== "NAV" || cells.length === 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("textarea, input, select, .cm-editor")) return;
      const currentId = selectedIdRef.current;
      const index = Math.max(0, cells.findIndex((cell) => cell.id === currentId));
      const plainDeleteKey = !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
        && event.key === "d";
      if (!plainDeleteKey) clearPendingCellDelete();
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        applyCellStructureHistory("redo");
      } else if (
        !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
        && event.key === "u"
      ) {
        event.preventDefault();
        applyCellStructureHistory("undo");
      } else if (plainDeleteKey) {
        event.preventDefault();
        if (!event.repeat) handleCellDeleteKey(currentId);
      } else if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        enterCellNavigation(cells[Math.min(index + 1, cells.length - 1)].id);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        enterCellNavigation(cells[Math.max(index - 1, 0)].id);
      } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === "Enter") {
        event.preventDefault();
        void runCell(currentId, false, false);
      } else if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "Enter") {
        event.preventDefault();
        void runCell(currentId, true, false);
      } else if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.key === "Enter") {
        event.preventDefault();
        void runCell(currentId, true, true);
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === "Enter" || event.key === "i")) {
        event.preventDefault();
        beginCellEditing(currentId);
      } else if (
        !event.shiftKey
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && event.key === "c"
      ) {
        event.preventDefault();
        focusCodexPrompt();
      } else if (
        event.shiftKey
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        insertBefore(currentId, "code");
      } else if (
        !event.shiftKey
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && (event.key === "o" || event.key === "a")
      ) {
        event.preventDefault();
        insertAfter(currentId, "code");
      }
    }
    window.addEventListener("keydown", handleGlobalKeys);
    return () => window.removeEventListener("keydown", handleGlobalKeys);
  }, [cells, mode, vimEnabled]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [notebookPath, openTabs.length]);

  async function loadDirectory(path: string, refresh = false): Promise<boolean> {
    if (!refresh && directoriesRef.current[path] !== undefined) return true;
    const requestVersion = (directoryRequestVersions.current[path] ?? 0) + 1;
    directoryRequestVersions.current[path] = requestVersion;
    setLoadingPaths((current) => new Set(current).add(path));
    try {
      const entries = await listDirectory(path, refresh);
      if (directoryRequestVersions.current[path] === requestVersion) {
        setDirectories((current) => ({ ...current, [path]: entries }));
      }
      return true;
    } catch (error) {
      if (directoryRequestVersions.current[path] === requestVersion) {
        setNotice(`Could not load ${path || "workspace"}: ${String(error)}`);
        return false;
      }
      return true;
    } finally {
      if (directoryRequestVersions.current[path] === requestVersion) {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    }
  }

  async function refreshTree(showNotice = true): Promise<boolean> {
    const paths = new Set(["", treeDirectory, ...Object.keys(directoriesRef.current)]);
    const results = await Promise.all([...paths].map((path) => loadDirectory(path, true)));
    const refreshed = results.every(Boolean);
    if (showNotice && refreshed) setNotice("File tree refreshed.");
    return refreshed;
  }

  async function refreshWorkspace() {
    const treeRefreshed = await refreshTree(false);
    if (documentRef.current.notebookPath) {
      await reloadNotebook();
    } else if (treeRefreshed) {
      setNotice("Workspace refreshed.");
    }
  }

  async function collectWorkspaceFiles() {
    setPaletteLoading(true);
    const files = new Map<string, PaletteFile>();
    const queue = [""];
    const visited = new Set<string>();
    const skippedDirectories = new Set([".git", ".venv", "node_modules", ".ipynb_checkpoints"]);
    try {
      while (queue.length && visited.size < 240 && files.size < 1_000) {
        const batch = queue.splice(0, 6).filter((path) => !visited.has(path));
        batch.forEach((path) => visited.add(path));
        const listings = await Promise.all(batch.map(async (path) => {
          const cached = directoriesRef.current[path];
          if (cached) return [path, cached] as const;
          try {
            const entries = await listDirectory(path);
            setDirectories((current) => ({ ...current, [path]: entries }));
            return [path, entries] as const;
          } catch {
            return [path, []] as const;
          }
        }));
        for (const [, entries] of listings) {
          for (const entry of entries) {
            if (entry.type === "directory") {
              if (!skippedDirectories.has(entry.name)) queue.push(entry.path);
            } else {
              files.set(entry.path, { path: entry.path, type: entry.type });
            }
          }
        }
        setPaletteFiles([...files.values()]);
      }
    } finally {
      setPaletteFiles([...files.values()].sort((left, right) => left.path.localeCompare(right.path)));
      setPaletteLoading(false);
    }
  }

  function openCommandPalette(nextMode: "files" | "commands") {
    setPaletteMode(nextMode);
    if (nextMode !== "files") return;
    const known = new Map<string, PaletteFile>();
    Object.values(directoriesRef.current).flat().forEach((entry) => {
      if (entry.type !== "directory") known.set(entry.path, { path: entry.path, type: entry.type });
    });
    setPaletteFiles([...known.values()]);
    void collectWorkspaceFiles();
  }

  function openPaletteFile(file: PaletteFile) {
    if (file.type === "notebook" || file.path.toLowerCase().endsWith(".ipynb")) {
      void openNotebook(file.path);
    } else {
      setNotice(`${basename(file.path)} is indexed, but text-file editing is not implemented yet.`);
    }
  }

  function markDirty() {
    revision.current += 1;
    setSaveState("dirty");
  }

  async function refreshStatus() {
    try {
      setStatus(await requestJson<ServerStatus>(appUrl("api/status")));
    } catch (error) {
      setNotice(`Server status failed: ${String(error)}`);
    }
  }

  async function changeEnvironment(path: string) {
    await kernelClient.current?.shutdown();
    await selectEnvironment(path);
    await refreshStatus();
  }

  function updateCells(updater: (current: NotebookCell[]) => NotebookCell[]) {
    if (notebookToolLockedRef.current) return;
    markDirty();
    setCells(updater);
  }

  function clearPendingCellDelete() {
    const pending = pendingCellDeleteRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingCellDeleteRef.current = null;
    setPendingCellDeleteId(null);
  }

  function handleCellDeleteKey(id: string) {
    const pending = pendingCellDeleteRef.current;
    if (pending?.cellId === id) {
      clearPendingCellDelete();
      deleteCell(id);
      return;
    }
    clearPendingCellDelete();
    const timer = window.setTimeout(() => {
      if (pendingCellDeleteRef.current?.timer !== timer) return;
      pendingCellDeleteRef.current = null;
      setPendingCellDeleteId(null);
    }, VIM_KEY_SEQUENCE_TIMEOUT_MS);
    pendingCellDeleteRef.current = { cellId: id, timer };
    setPendingCellDeleteId(id);
  }

  function freshCellStructureHistory(expectedCellIds: string[]): CellStructureHistory {
    return { undo: [], redo: [], expectedCellIds };
  }

  function cellStructureHistoryFor(path: string, currentCells: NotebookCell[]): CellStructureHistory {
    const currentIds = cellIds(currentCells);
    let history = cellStructureHistories.current.get(path);
    if (!history || !sameCellIds(history.expectedCellIds, currentIds)) {
      history = freshCellStructureHistory(currentIds);
      cellStructureHistories.current.set(path, history);
    }
    return history;
  }

  function cellStructureSnapshot(path: string, cellsValue: NotebookCell[], label: string): CellStructureSnapshot {
    return {
      cells: [...cellsValue],
      selectedId: selectedIdRef.current,
      cellViews: { ...(cellViewsByNotebookRef.current[path] ?? {}) },
      label,
    };
  }

  function commitCellStructureChange(
    nextCells: NotebookCell[],
    nextSelectedId: string,
    label: string,
    editSelected: boolean,
  ) {
    const current = documentRef.current;
    const path = current.notebookPath;
    if (!path) return;
    const history = cellStructureHistoryFor(path, current.cells);
    history.undo.push(cellStructureSnapshot(path, current.cells, label));
    if (history.undo.length > CELL_STRUCTURE_HISTORY_LIMIT) history.undo.shift();
    history.redo = [];
    history.expectedCellIds = cellIds(nextCells);

    markDirty();
    documentRef.current = { ...current, cells: nextCells, saveState: "dirty" };
    setCells(nextCells);
    selectCell(nextSelectedId);
    setEditingId(editSelected ? nextSelectedId : null);
    setMode(editSelected ? (vimEnabled ? "NORMAL" : "INSERT") : "NAV");
    if (!editSelected) focusNavigationCell(nextSelectedId);
  }

  function restoreCellStructureViews(
    path: string,
    currentCells: NotebookCell[],
    nextCells: NotebookCell[],
    snapshot: CellStructureSnapshot,
  ) {
    const currentIds = new Set(cellIds(currentCells));
    const nextIds = new Set(cellIds(nextCells));
    const notebookViews = { ...(cellViewsByNotebookRef.current[path] ?? {}) };
    for (const id of currentIds) {
      if (!nextIds.has(id)) delete notebookViews[id];
    }
    for (const id of nextIds) {
      if (currentIds.has(id)) continue;
      const restoredView = snapshot.cellViews[id];
      if (restoredView) notebookViews[id] = { ...restoredView };
      else delete notebookViews[id];
    }
    const allViews = { ...cellViewsByNotebookRef.current };
    if (Object.keys(notebookViews).length) allViews[path] = notebookViews;
    else delete allViews[path];
    cellViewsByNotebookRef.current = allViews;
    setCellViewsByNotebook(allViews);
  }

  function applyCellStructureHistory(direction: "undo" | "redo") {
    const current = documentRef.current;
    const path = current.notebookPath;
    if (!path) return;
    if (notebookToolLockedRef.current || codexLockedCellIds(path).length) {
      setNotice("Wait for Codex to finish before changing cell structure history.");
      return;
    }
    const history = cellStructureHistories.current.get(path);
    if (!history || !sameCellIds(history.expectedCellIds, cellIds(current.cells))) {
      if (history) cellStructureHistories.current.delete(path);
      setNotice(`No cell structure change to ${direction}.`);
      return;
    }
    const source = direction === "undo" ? history.undo : history.redo;
    const destination = direction === "undo" ? history.redo : history.undo;
    const snapshot = source.pop();
    if (!snapshot) {
      setNotice(`No cell structure change to ${direction}.`);
      return;
    }
    destination.push(cellStructureSnapshot(path, current.cells, snapshot.label));
    if (destination.length > CELL_STRUCTURE_HISTORY_LIMIT) destination.shift();

    const currentById = new Map(current.cells.map((cell) => [cell.id, cell]));
    const nextCells = snapshot.cells.map((cell) => currentById.get(cell.id) ?? cell);
    history.expectedCellIds = cellIds(nextCells);
    restoreCellStructureViews(path, current.cells, nextCells, snapshot);
    markDirty();
    documentRef.current = { ...current, cells: nextCells, saveState: "dirty" };
    setCells(nextCells);
    const nextSelectedId = nextCells.some((cell) => cell.id === snapshot.selectedId)
      ? snapshot.selectedId
      : nextCells[0].id;
    selectCell(nextSelectedId);
    setEditingId(null);
    setMode("NAV");
    setCodexEditReview(null);
    focusNavigationCell(nextSelectedId);
    setNotice(`${direction === "undo" ? "Undid" : "Redid"} ${snapshot.label}.`);
  }

  function replaceCodexCellLocks(next: Record<string, string[]>) {
    codexCellLocksRef.current = next;
    setCodexCellLocks(next);
  }

  function replaceCellProposals(next: CellProposalsByNotebook) {
    cellProposalsRef.current = next;
    setCellProposalsByNotebook(next);
  }

  function cellProposal(id: string, path = documentRef.current.notebookPath): CellProposal | null {
    return path ? cellProposalsRef.current[path]?.[id] ?? null : null;
  }

  function persistProposalChange(path: string, id: string, proposal: CellProposal | null) {
    const workspace = restoredWorkspace.current;
    if (!workspace) return;
    const operation = proposal
      ? storeCellProposal(workspace, proposal)
      : removeCellProposal(workspace, path, id);
    void operation.catch(() => {
      // Proposal recovery is best-effort; the live review state remains authoritative.
    });
  }

  function updateCellProposal(path: string, id: string, proposal: CellProposal | null) {
    const notebookProposals = { ...(cellProposalsRef.current[path] ?? {}) };
    if (proposal) notebookProposals[id] = proposal;
    else delete notebookProposals[id];
    const next = { ...cellProposalsRef.current };
    if (Object.keys(notebookProposals).length) next[path] = notebookProposals;
    else delete next[path];
    replaceCellProposals(next);
    persistProposalChange(path, id, proposal);
  }

  function remapCellProposals(entryPath: string, nextEntryPath: string) {
    const next: CellProposalsByNotebook = {};
    let changed = false;
    for (const [path, proposals] of Object.entries(cellProposalsRef.current)) {
      const nextPath = isSameOrChild(path, entryPath)
        ? `${nextEntryPath}${path.slice(entryPath.length)}`
        : path;
      const notebookProposals: Record<string, CellProposal> = {};
      for (const [id, proposal] of Object.entries(proposals)) {
        const nextProposal = nextPath === path ? proposal : { ...proposal, notebookPath: nextPath };
        notebookProposals[id] = nextProposal;
        if (nextPath !== path) {
          changed = true;
          persistProposalChange(path, id, null);
          persistProposalChange(nextPath, id, nextProposal);
        }
      }
      next[nextPath] = notebookProposals;
    }
    if (changed) replaceCellProposals(next);
  }

  function removeCellProposalsUnder(entryPath: string) {
    const next: CellProposalsByNotebook = {};
    let changed = false;
    for (const [path, proposals] of Object.entries(cellProposalsRef.current)) {
      if (!isSameOrChild(path, entryPath)) {
        next[path] = proposals;
        continue;
      }
      changed = true;
      Object.keys(proposals).forEach((id) => persistProposalChange(path, id, null));
    }
    if (changed) replaceCellProposals(next);
  }

  function reconcileNotebookProposals(path: string, loadedCells: NotebookCell[]) {
    const stored = cellProposalsRef.current[path];
    if (!stored) return;
    const cellsById = new Map(loadedCells.map((cell) => [cell.id, cell]));
    const reconciled: Record<string, CellProposal> = {};
    let changed = false;
    for (const [id, proposal] of Object.entries(stored)) {
      const nextProposal = reconcileCellProposal(proposal, cellsById.get(id));
      if (!nextProposal) {
        persistProposalChange(path, id, null);
        changed = true;
        continue;
      }
      reconciled[id] = nextProposal;
      if (nextProposal.state !== proposal.state) {
        persistProposalChange(path, id, nextProposal);
        changed = true;
      }
    }
    if (!changed) return;
    const next = { ...cellProposalsRef.current };
    if (Object.keys(reconciled).length) next[path] = reconciled;
    else delete next[path];
    replaceCellProposals(next);
  }

  function finishCodexTurn() {
    codexTurnActiveRef.current = false;
    setCodexTurnActive(false);
    releaseCodexCellLocks();
    let changed = false;
    const next: CellProposalsByNotebook = {};
    for (const [path, proposals] of Object.entries(cellProposalsRef.current)) {
      const notebookProposals: Record<string, CellProposal> = {};
      for (const [id, proposal] of Object.entries(proposals)) {
        const nextProposal = proposal.state === "streaming"
          ? { ...proposal, state: "review" as const, updatedAt: Date.now() }
          : proposal;
        notebookProposals[id] = nextProposal;
        if (nextProposal !== proposal) {
          changed = true;
          persistProposalChange(path, id, nextProposal);
        }
      }
      if (Object.keys(notebookProposals).length) next[path] = notebookProposals;
    }
    if (changed) replaceCellProposals(next);
  }

  function startCodexTurn() {
    codexTurnActiveRef.current = true;
    setCodexTurnActive(true);
  }

  function releaseCodexCellLocks() {
    if (Object.keys(codexCellLocksRef.current).length === 0) return;
    replaceCodexCellLocks({});
  }

  function codexLockedCellIds(path = documentRef.current.notebookPath): string[] {
    return path ? codexCellLocksRef.current[path] ?? [] : [];
  }

  function isCodexCellLocked(id: string, path = documentRef.current.notebookPath): boolean {
    return codexLockedCellIds(path).includes(id);
  }

  function cellMutationBlocked(id: string): boolean {
    if (isCodexCellLocked(id)) {
      setNotice("That cell is locked while Codex works on this turn.");
      return true;
    }
    if (cellProposal(id)) {
      setNotice("Apply or reject the pending Codex proposal before editing or running that cell.");
      return true;
    }
    return false;
  }

  function retainCodexCellLocks(path: string, validCells: NotebookCell[]) {
    const current = codexCellLocksRef.current[path];
    if (!current?.length) return;
    const validIds = new Set(validCells.map((cell) => cell.id));
    const retained = current.filter((id) => validIds.has(id));
    if (retained.length === current.length) return;
    const next = { ...codexCellLocksRef.current };
    if (retained.length) next[path] = retained;
    else delete next[path];
    replaceCodexCellLocks(next);
  }

  async function persistNotebook(): Promise<boolean> {
    if (notebookToolLockedRef.current) return false;
    if (savePromise.current) return savePromise.current;
    const current = documentRef.current;
    if (!current.notebookPath) return true;
    const savingRevision = revision.current;
    setSaveState("saving");
    const task = (async () => {
      try {
        await saveNotebook(
          current.notebookPath!,
          notebookFromCells(current.cells, current.metadata),
        );
        savedRevision.current = Math.max(savedRevision.current, savingRevision);
        setSaveState(revision.current === savingRevision ? "saved" : "dirty");
        return true;
      } catch (error) {
        setSaveState("error");
        setNotice(`Save failed: ${String(error)}`);
        return false;
      }
    })();
    savePromise.current = task;
    try {
      return await task;
    } finally {
      if (savePromise.current === task) savePromise.current = null;
    }
  }

  async function ensureDocumentSaved(): Promise<boolean> {
    const path = documentRef.current.notebookPath;
    if (!path) return true;

    while (documentRef.current.notebookPath === path) {
      if (savePromise.current) {
        if (!(await savePromise.current)) return false;
        continue;
      }
      const current = documentRef.current;
      if (current.saveState === "saved" && savedRevision.current >= revision.current) return true;
      if (!(await persistNotebook())) return false;
      if (savedRevision.current >= revision.current) return true;
    }
    return true;
  }

  async function reloadNotebook(fromExternalChange = false) {
    if (notebookToolLockedRef.current) {
      setNotice("The notebook is temporarily locked while Codex applies a cell change.");
      return;
    }
    const path = documentRef.current.notebookPath;
    if (!path) return;
    if (codexLockedCellIds(path).length) {
      setNotice("Codex has cells locked in this notebook until the turn finishes.");
      return;
    }
    if (!fromExternalChange && documentRef.current.saveState !== "saved") {
      if (!window.confirm("Discard unsaved changes and reload this notebook?")) return;
    }
    setBusy(true);
    try {
      const model = await readNotebook(path);
      const notebook = model.content as RawNotebook;
      const loadedCells = cellsFromNotebook(notebook);
      reconcileNotebookProposals(path, loadedCells);
      revision.current += 1;
      savedRevision.current = revision.current;
      setCells(loadedCells);
      setMetadata(notebook.metadata ?? {});
      setSelectedId(loadedCells[0].id);
      setEditingId(null);
      setMode("NAV");
      setSaveState(notebook.cells.length === 0 ? "dirty" : "saved");
      setCodexEditReview(null);
      setNotice(fromExternalChange ? "Reloaded workspace changes from Codex." : "Reloaded from disk.");
    } catch (error) {
      setNotice(`Could not reload ${path}: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshAfterCodexChange() {
    await refreshTree(false);
    if (documentRef.current.notebookPath && documentRef.current.saveState === "saved") {
      await reloadNotebook(true);
    } else {
      setNotice("Codex changed the workspace; the tree was refreshed. Local unsaved cells were preserved.");
    }
  }

  async function handleNotebookToolCall(
    tool: string,
    argumentsValue: unknown,
    context: NotebookToolContext,
  ): Promise<NotebookToolResponse> {
    let args: Record<string, unknown>;
    try {
      args = parseNotebookToolArguments(argumentsValue);
    } catch (error) {
      return { success: false, result: { error: String(error) } };
    }

    const current = documentRef.current;
    if (tool === NOTEBOOK_READ_TOOL) {
      if (!current.notebookPath) {
        return { success: false, result: { error: "No notebook is open in Zbook." } };
      }
      if (args.includeSource !== undefined && typeof args.includeSource !== "boolean") {
        return { success: false, result: { error: "includeSource must be a boolean." } };
      }
      const includeSource = args.includeSource !== false;
      const notebookProposals = cellProposalsRef.current[current.notebookPath] ?? {};
      return {
        success: true,
        result: {
          notebookPath: current.notebookPath,
          documentRevision: revision.current,
          selectedCellId: selectedId || null,
          saveState: current.saveState,
          sourceIncluded: includeSource,
          lockedCellIds: codexLockedCellIds(current.notebookPath),
          pendingCellIds: Object.keys(notebookProposals),
          availableActions: NOTEBOOK_AVAILABLE_ACTIONS,
          cells: current.cells.map((cell, index) => {
            const proposal = notebookProposals[cell.id];
            return {
              index,
              id: cell.id,
              cellType: cell.kind,
              executionCount: cell.executionCount,
              ...(includeSource ? { source: proposal?.draftSource ?? cell.source } : {}),
              ...(proposal ? {
                pendingChange: proposalForRead(proposal, cell.source, includeSource),
                ...(proposal.state === "conflict" && includeSource
                  ? { acceptedSource: cell.source }
                  : {}),
              } : {}),
            };
          }),
        },
      };
    }
    if (tool !== NOTEBOOK_APPLY_TOOL && tool !== NOTEBOOK_LOCK_TOOL && tool !== NOTEBOOK_PROPOSE_TOOL) {
      return { success: false, result: { error: `Unknown notebook tool: ${tool}` } };
    }
    if (!current.notebookPath) {
      return { success: false, result: { error: "No notebook is open in Zbook." } };
    }
    if (notebookToolLockedRef.current) {
      return { success: false, result: { error: "Another notebook tool call is still running." } };
    }
    if (kernelClient.current?.currentState === "busy" || kernelClient.current?.currentState === "starting") {
      return { success: false, result: { error: "Wait for the running cell to finish before locking or editing it." } };
    }
    if (typeof args.notebookPath !== "string" || args.notebookPath !== current.notebookPath) {
      return {
        success: false,
        result: {
          error: "notebook_not_active",
          message: "The notebook tab changed. Read the active notebook again before editing.",
          activeNotebookPath: current.notebookPath,
        },
      };
    }
    if (!Number.isInteger(args.expectedRevision) || args.expectedRevision !== revision.current) {
      return {
        success: false,
        result: {
          error: "revision_conflict",
          message: "The notebook changed after it was read. Read it again before retrying.",
          currentRevision: revision.current,
        },
      };
    }

    if (tool === NOTEBOOK_LOCK_TOOL) {
      const action = args.action;
      if (action !== "lock" && action !== "unlock") {
        return {
          success: false,
          result: { error: "invalid_lock_request", message: "action must be lock or unlock." },
        };
      }
      if (!Array.isArray(args.cellIds) || args.cellIds.length === 0 || args.cellIds.length > 100) {
        return {
          success: false,
          result: { error: "invalid_lock_request", message: "cellIds must contain 1 to 100 cell IDs." },
        };
      }
      const currentLocks = new Set(codexLockedCellIds(current.notebookPath));
      const currentIds = new Set(current.cells.map((cell) => cell.id));
      const requestedIds: string[] = [];
      const seen = new Set<string>();
      for (const value of args.cellIds) {
        if (typeof value !== "string" || value.length === 0 || value.length > 200) {
          return {
            success: false,
            result: { error: "invalid_lock_request", message: "Every cellIds entry must be a valid cell ID." },
          };
        }
        if (seen.has(value)) {
          return {
            success: false,
            result: { error: "invalid_lock_request", message: `cellIds contains a duplicate: ${value}` },
          };
        }
        if (!currentIds.has(value) && !(action === "unlock" && currentLocks.has(value))) {
          return {
            success: false,
            result: { error: "invalid_lock_request", message: `cellIds does not identify a current cell: ${value}` },
          };
        }
        seen.add(value);
        requestedIds.push(value);
      }
      requestedIds.forEach((id) => {
        if (action === "lock") currentLocks.add(id);
        else currentLocks.delete(id);
      });
      const orderedLocks = current.cells
        .map((cell) => cell.id)
        .filter((id) => currentLocks.has(id));
      const nextLocks = { ...codexCellLocksRef.current };
      if (orderedLocks.length) nextLocks[current.notebookPath] = orderedLocks;
      else delete nextLocks[current.notebookPath];
      replaceCodexCellLocks(nextLocks);
      if (action === "lock" && requestedIds.includes(editingId ?? "")) {
        setEditingId(null);
        setMode("NAV");
      }
      setNotice(action === "lock"
        ? `Codex locked ${requestedIds.length} cell${requestedIds.length === 1 ? "" : "s"} for this turn.`
        : `Codex unlocked ${requestedIds.length} cell${requestedIds.length === 1 ? "" : "s"}.`);
      return {
        success: true,
        result: {
          notebookPath: current.notebookPath,
          documentRevision: revision.current,
          action,
          affectedCellIds: requestedIds,
          lockedCellIds: orderedLocks,
          automaticRelease: "turn_end",
          availableActions: NOTEBOOK_AVAILABLE_ACTIONS,
        },
      };
    }

    if (tool === NOTEBOOK_PROPOSE_TOOL) {
      if (typeof args.cellId !== "string" || args.cellId.length === 0 || args.cellId.length > 200) {
        return {
          success: false,
          result: { error: "invalid_proposal", message: "cellId must identify one current cell." },
        };
      }
      const cell = current.cells.find((item) => item.id === args.cellId);
      if (!cell) {
        return {
          success: false,
          result: { error: "cell_not_found", message: `No current cell has id ${args.cellId}.` },
        };
      }
      const heldLocks = new Set(codexLockedCellIds(current.notebookPath));
      if (!heldLocks.has(cell.id)) {
        return {
          success: false,
          result: {
            error: "cells_not_locked",
            message: "Lock the existing cell before staging or changing its proposal.",
            missingCellIds: [cell.id],
            lockedCellIds: [...heldLocks],
            nextAction: {
              tool: NOTEBOOK_LOCK_TOOL,
              arguments: {
                notebookPath: current.notebookPath,
                expectedRevision: revision.current,
                action: "lock",
                cellIds: [cell.id],
              },
            },
            instruction: "Call nextAction.tool with nextAction.arguments, then retry the proposal action.",
            availableActions: NOTEBOOK_AVAILABLE_ACTIONS,
          },
        };
      }
      const existing = cellProposal(cell.id, current.notebookPath);
      try {
        const operation = applyProposalOperation(
          cell,
          existing,
          args,
          current.notebookPath,
          revision.current,
          { threadId: context.threadId, turnId: context.turnId },
        );
        updateCellProposal(current.notebookPath, cell.id, operation.proposal);
        if (editingId === cell.id) {
          setEditingId(null);
          setMode("NAV");
        }
        if (!existing && operation.proposal) {
          setNotice("Codex is drafting a reviewable change in the locked cell.");
        } else if (!operation.proposal) {
          setNotice(operation.action === "discard_proposal"
            ? "Codex discarded the pending cell proposal."
            : "The proposed source now matches the accepted cell.");
        }
        return {
          success: true,
          result: {
            notebookPath: current.notebookPath,
            documentRevision: revision.current,
            cellId: cell.id,
            action: operation.action,
            proposalRevision: operation.proposal?.proposalRevision ?? 0,
            pendingReview: Boolean(operation.proposal),
            saved: false,
            ...(operation.proposal
              ? { pendingChange: proposalForRead(operation.proposal, cell.source) }
              : {}),
            lockedCellIds: codexLockedCellIds(current.notebookPath),
            availableActions: NOTEBOOK_AVAILABLE_ACTIONS,
          },
        };
      } catch (error) {
        if (error instanceof ProposalInputError) {
          return {
            success: false,
            result: {
              error: error.code,
              message: error.message,
              ...error.details,
              availableActions: NOTEBOOK_AVAILABLE_ACTIONS,
            },
          };
        }
        return { success: false, result: { error: "proposal_failed", message: String(error) } };
      }
    }

    if (Array.isArray(args.operations) && args.operations.some((operation) => (
      operation && typeof operation === "object" && (operation as Record<string, unknown>).op === "replace_source"
    ))) {
      return {
        success: false,
        result: {
          error: "source_edits_require_proposal",
          message: "Existing-cell source edits must be streamed through zbook_notebook_propose for user review.",
          nextAction: {
            tool: NOTEBOOK_READ_TOOL,
            arguments: { includeSource: true },
          },
          instruction: "Read the current cells, keep the relevant locks, then call zbook_notebook_propose once per coherent hunk.",
          availableActions: NOTEBOOK_AVAILABLE_ACTIONS,
        },
      };
    }

    let applied;
    try {
      applied = applyNotebookOperations(current.cells, args.operations);
    } catch (error) {
      const message = error instanceof NotebookToolInputError ? error.message : String(error);
      return { success: false, result: { error: "invalid_operations", message } };
    }
    const currentCellIds = new Set(current.cells.map((cell) => cell.id));
    const heldLocks = new Set(codexLockedCellIds(current.notebookPath));
    const missingLocks = applied.affectedCellIds.filter((id) => (
      currentCellIds.has(id) && !heldLocks.has(id)
    ));
    if (missingLocks.length) {
      return {
        success: false,
        result: {
          error: "cells_not_locked",
          message: "Lock every existing cell affected by the operation before applying changes.",
          missingCellIds: missingLocks,
          lockedCellIds: [...heldLocks],
          nextAction: {
            tool: NOTEBOOK_LOCK_TOOL,
            arguments: {
              notebookPath: current.notebookPath,
              expectedRevision: revision.current,
              action: "lock",
              cellIds: missingLocks,
            },
          },
          instruction: "Call nextAction.tool with nextAction.arguments; do not ask the user to lock cells in the UI.",
          availableActions: NOTEBOOK_AVAILABLE_ACTIONS,
        },
      };
    }
    const proposalConflicts = applied.affectedCellIds.filter((id) => Boolean(cellProposal(id, current.notebookPath)));
    if (proposalConflicts.length) {
      return {
        success: false,
        result: {
          error: "pending_proposal_conflict",
          message: "Apply or discard each pending cell proposal before structurally changing those cells.",
          affectedCellIds: proposalConflicts,
          availableActions: NOTEBOOK_AVAILABLE_ACTIONS,
        },
      };
    }

    notebookToolLockedRef.current = true;
    setNotebookToolLocked(true);
    setEditingId(null);
    setMode("NAV");
    try {
      if (savePromise.current && !(await savePromise.current)) {
        return { success: false, result: { error: "Could not finish saving the current notebook." } };
      }
      setSaveState("saving");
      await saveNotebook(
        current.notebookPath,
        notebookFromCells(applied.cells, current.metadata),
      );
      const nextRevision = revision.current + 1;
      revision.current = nextRevision;
      savedRevision.current = nextRevision;
      documentRef.current = {
        cells: applied.cells,
        metadata: current.metadata,
        notebookPath: current.notebookPath,
        saveState: "saved",
      };
      retainCodexCellLocks(current.notebookPath, applied.cells);
      setCells(applied.cells);
      setSaveState("saved");
      const nextSelected = applied.insertedCellIds.at(-1)
        ?? applied.affectedCellIds.find((id) => applied.cells.some((cell) => cell.id === id))
        ?? (applied.cells.some((cell) => cell.id === selectedId) ? selectedId : applied.cells[0].id);
      setSelectedId(nextSelected);
      setCodexEditReview({
        notebookPath: current.notebookPath,
        affectedCellIds: applied.affectedCellIds,
        beforeCells: cloneDocumentValue(current.cells),
        beforeMetadata: cloneDocumentValue(current.metadata),
        beforeSelectedId: selectedId,
        afterRevision: nextRevision,
      });
      setNotice(`Codex updated ${applied.affectedCellIds.length} notebook cell${applied.affectedCellIds.length === 1 ? "" : "s"}.`);
      return {
        success: true,
        result: {
          notebookPath: current.notebookPath,
          documentRevision: nextRevision,
          affectedCellIds: applied.affectedCellIds,
          insertedCellIds: applied.insertedCellIds,
          lockedCellIds: codexLockedCellIds(current.notebookPath),
          availableActions: NOTEBOOK_AVAILABLE_ACTIONS,
          cellCount: applied.cells.length,
          saved: true,
          undoAvailable: true,
        },
      };
    } catch (error) {
      setSaveState(current.saveState);
      setNotice(`Codex notebook edit could not be saved: ${String(error)}`);
      return { success: false, result: { error: "save_failed", message: String(error) } };
    } finally {
      notebookToolLockedRef.current = false;
      setNotebookToolLocked(false);
    }
  }

  function rememberOpenTab(path: string) {
    setOpenTabs((current) => current.includes(path) ? current : [...current, path]);
  }

  function resetNotebookDocument() {
    setNotebookPath(null);
    setCells([]);
    setMetadata({});
    setSelectedId("");
    setEditingId(null);
    setMode("NAV");
    setSaveState("saved");
    setCodexEditReview(null);
    revision.current += 1;
    savedRevision.current = revision.current;
  }

  function notebookTransitionBlocked(): boolean {
    if (notebookToolLockedRef.current) {
      setNotice("Wait for the Codex cell change to finish before switching notebooks.");
      return true;
    }
    const state = kernelClient.current?.currentState;
    if (state !== "busy" && state !== "starting") return false;
    setNotice("Interrupt the running cell before switching notebooks.");
    return true;
  }

  async function loadNotebookDocument(
    path: string,
    rememberTab: boolean,
    preferredSelectedId?: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      const model = await readNotebook(path);
      const notebook = model.content as RawNotebook;
      const loadedCells = cellsFromNotebook(notebook);
      reconcileNotebookProposals(path, loadedCells);
      revision.current += 1;
      savedRevision.current = revision.current;
      setNotebookPath(path);
      setTreeDirectory(parentPath(path));
      setCells(loadedCells);
      setMetadata(notebook.metadata ?? {});
      const requestedSelection = preferredSelectedId ?? selectedByNotebook.current[path];
      const restoredSelection = requestedSelection
        && loadedCells.some((cell) => cell.id === requestedSelection)
        ? requestedSelection
        : loadedCells[0].id;
      selectedByNotebook.current[path] = restoredSelection;
      setSelectedId(restoredSelection);
      setEditingId(null);
      setMode("NAV");
      setSaveState(notebook.cells.length === 0 ? "dirty" : "saved");
      setCodexEditReview(null);
      if (rememberTab) rememberOpenTab(path);
      return true;
    } catch (error) {
      setNotice(`Could not open ${path}: ${String(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function openNotebook(path: string): Promise<boolean> {
    if (path === documentRef.current.notebookPath) {
      rememberOpenTab(path);
      return true;
    }
    if (notebookTransitionBlocked()) return false;
    if (!(await ensureDocumentSaved())) return false;
    return loadNotebookDocument(path, true);
  }

  async function closeNotebookTab(path: string) {
    const tabs = openTabsRef.current;
    if (!tabs.includes(path)) return;
    if (path !== documentRef.current.notebookPath) {
      setOpenTabs(tabs.filter((tab) => tab !== path));
      return;
    }
    if (notebookTransitionBlocked()) return;
    if (!(await ensureDocumentSaved())) return;

    const index = tabs.indexOf(path);
    const remaining = tabs.filter((tab) => tab !== path);
    const nextPath = remaining[Math.min(index, remaining.length - 1)] ?? null;
    if (nextPath && !(await loadNotebookDocument(nextPath, false))) return;
    if (!nextPath) resetNotebookDocument();
    setOpenTabs(remaining);
  }

  async function newNotebook() {
    const directory = treeDirectory;
    if (notebookTransitionBlocked()) return;
    if (!(await ensureDocumentSaved())) return;
    setBusy(true);
    try {
      const created = await createNotebook(directory);
      await loadDirectory(directory, true);
      await openNotebook(created.path);
    } catch (error) {
      setNotice(`Could not create notebook: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function newFolder() {
    const name = window.prompt("New folder name", "untitled")?.trim();
    if (!name) return;
    if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      setNotice("A folder name cannot contain path separators.");
      return;
    }
    const path = treeDirectory ? `${treeDirectory}/${name}` : name;
    setBusy(true);
    try {
      await createDirectory(path);
      await loadDirectory(treeDirectory, true);
      setTreeDirectory(path);
      setNotice(`Created ${path}`);
    } catch (error) {
      setNotice(`Could not create folder: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles(fileList: FileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    const existing = new Set((directories[treeDirectory] ?? []).map((entry) => entry.name));
    setBusy(true);
    let uploaded = 0;
    let onlyEntry: ContentEntry | null = null;
    try {
      for (const file of files) {
        if (existing.has(file.name) && !window.confirm(`Replace ${file.name}?`)) continue;
        onlyEntry = await uploadFile(treeDirectory, file);
        uploaded += 1;
      }
      await loadDirectory(treeDirectory, true);
      setNotice(`Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}`);
      if (uploaded === 1 && onlyEntry?.type === "notebook") await openNotebook(onlyEntry.path);
    } catch (error) {
      setNotice(`Upload failed after ${uploaded} file${uploaded === 1 ? "" : "s"}: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function openEntry(entry: ContentEntry) {
    if (entry.type === "notebook" || entry.name.endsWith(".ipynb")) {
      void openNotebook(entry.path);
    } else {
      setNotice(`${entry.name} is visible for file management; text-file editing is not implemented yet.`);
    }
  }

  async function renamePath(entryPath: string, entryName: string, requestedName?: string) {
    const requested = (requestedName ?? window.prompt(`Rename ${entryName}`, entryName))?.trim();
    if (!requested || requested === entryName) return;
    if (requested.includes("/") || requested.includes("\\")) {
      setNotice("A file name cannot contain path separators.");
      return;
    }
    const parent = parentPath(entryPath);
    const newPath = parent ? `${parent}/${requested}` : requested;
    const activePath = documentRef.current.notebookPath;
    const containsActive = Boolean(activePath && isSameOrChild(activePath, entryPath));
    if (containsActive && notebookTransitionBlocked()) return;
    setBusy(true);
    try {
      if (containsActive && !(await ensureDocumentSaved())) return;
      await renameEntry(entryPath, newPath);
      remapCellProposals(entryPath, newPath);
      if (activePath && containsActive) {
        const nextActivePath = `${newPath}${activePath.slice(entryPath.length)}`;
        documentRef.current = { ...documentRef.current, notebookPath: nextActivePath };
        setNotebookPath(nextActivePath);
      }
      setOpenTabs((current) => {
        const next = [
          ...new Set(current.map((path) => (
            isSameOrChild(path, entryPath) ? `${newPath}${path.slice(entryPath.length)}` : path
          ))),
        ];
        openTabsRef.current = next;
        return next;
      });
      selectedByNotebook.current = Object.fromEntries(
        Object.entries(selectedByNotebook.current).map(([path, cellId]) => [
          isSameOrChild(path, entryPath) ? `${newPath}${path.slice(entryPath.length)}` : path,
          cellId,
        ]),
      );
      setCellViewsByNotebook((current) => Object.fromEntries(
        Object.entries(current).map(([path, views]) => [
          isSameOrChild(path, entryPath) ? `${newPath}${path.slice(entryPath.length)}` : path,
          views,
        ]),
      ));
      replaceCodexCellLocks(Object.fromEntries(
        Object.entries(codexCellLocksRef.current).map(([path, cellIds]) => [
          isSameOrChild(path, entryPath) ? `${newPath}${path.slice(entryPath.length)}` : path,
          cellIds,
        ]),
      ));
      if (treeDirectory === entryPath || treeDirectory.startsWith(`${entryPath}/`)) {
        setTreeDirectory(`${newPath}${treeDirectory.slice(entryPath.length)}`);
      }
      await loadDirectory(parent, true);
      setNotice(`Renamed to ${requested}`);
    } catch (error) {
      setNotice(`Rename failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function renameContent(entry: ContentEntry) {
    await renamePath(entry.path, entry.name);
  }

  function beginTabRename(path: string) {
    if (busy || notebookToolLockedRef.current) return;
    const state = kernelClient.current?.currentState;
    if (state === "busy" || state === "starting") {
      setNotice("Interrupt the running cell before renaming a notebook.");
      return;
    }
    setRenamingTabPath(path);
    setRenamingTabName(basename(path));
  }

  async function commitTabRename(path: string, value: string) {
    setRenamingTabPath(null);
    setRenamingTabName("");
    const trimmed = value.trim();
    if (!trimmed) return;
    const requested = trimmed.toLowerCase().endsWith(".ipynb")
      ? trimmed
      : `${trimmed}.ipynb`;
    if (requested.toLowerCase() === ".ipynb") {
      setNotice("A notebook name is required.");
      return;
    }
    await renamePath(path, basename(path), requested);
  }

  async function deleteContent(entry: ContentEntry) {
    if (Object.entries(codexCellLocksRef.current).some(([path, cellIds]) => (
      cellIds.length > 0 && isSameOrChild(path, entry.path)
    ))) {
      setNotice("Codex has cells locked there until the turn finishes.");
      return;
    }
    if (!window.confirm(`Delete ${entry.path}?`)) return;
    const activePath = documentRef.current.notebookPath;
    const containsActive = Boolean(activePath && isSameOrChild(activePath, entry.path));
    if (containsActive && notebookTransitionBlocked()) return;
    const tabs = openTabsRef.current;
    const activeIndex = activePath ? tabs.indexOf(activePath) : -1;
    const remainingTabs = tabs.filter((path) => !isSameOrChild(path, entry.path));
    const nextPath = containsActive
      ? remainingTabs[Math.min(Math.max(activeIndex, 0), remainingTabs.length - 1)] ?? null
      : null;
    try {
      if (containsActive && !(await ensureDocumentSaved())) return;
      await deleteEntry(entry.path);
      removeCellProposalsUnder(entry.path);
      selectedByNotebook.current = Object.fromEntries(
        Object.entries(selectedByNotebook.current)
          .filter(([path]) => !isSameOrChild(path, entry.path)),
      );
      setCellViewsByNotebook((current) => Object.fromEntries(
        Object.entries(current).filter(([path]) => !isSameOrChild(path, entry.path)),
      ));
      replaceCodexCellLocks(Object.fromEntries(
        Object.entries(codexCellLocksRef.current)
          .filter(([path]) => !isSameOrChild(path, entry.path)),
      ));
      setOpenTabs(remainingTabs);
      if (containsActive) {
        resetNotebookDocument();
        if (nextPath) await loadNotebookDocument(nextPath, false);
      }
      if (treeDirectory === entry.path || treeDirectory.startsWith(`${entry.path}/`)) {
        setTreeDirectory(parentPath(entry.path));
      }
      await loadDirectory(parentPath(entry.path), true);
      setNotice(`Deleted ${entry.name}`);
    } catch (error) {
      setNotice(`Delete failed: ${String(error)}`);
    }
  }

  function updateCell(id: string, source: string) {
    if (cellMutationBlocked(id)) return;
    updateCells((current) => current.map((cell) => cell.id === id ? { ...cell, source } : cell));
  }

  function selectCell(id: string) {
    if (id !== selectedIdRef.current) {
      setEditingId(null);
      setMode("NAV");
    }
    selectedIdRef.current = id;
    if (notebookPath) selectedByNotebook.current[notebookPath] = id;
    setSelectedId(id);
  }

  function focusNavigationCell(id: string) {
    window.requestAnimationFrame(() => {
      const element = Array.from(document.querySelectorAll<HTMLElement>(".notebook-cell[data-cell-id]"))
        .find((candidate) => candidate.dataset.cellId === id);
      if (!element) return;
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function enterCellNavigation(id: string) {
    if (!id) return;
    selectCell(id);
    setEditingId(null);
    setMode("NAV");
    focusNavigationCell(id);
  }

  function beginCellEditing(id: string) {
    if (!id || notebookToolLockedRef.current || cellMutationBlocked(id)) return;
    selectCell(id);
    setEditingId(id);
    setMode(vimEnabled ? "NORMAL" : "INSERT");
  }

  function focusCodexPrompt() {
    setRightOpen(true);
    window.requestAnimationFrame(() => {
      const prompt = document.querySelector<HTMLTextAreaElement>(".prompt-box textarea:not(:disabled)");
      if (prompt) prompt.focus();
      else setNotice("Codex is not ready yet");
    });
  }

  function toggleCellView(id: string, option: CellViewOption) {
    if (!notebookPath) return;
    const path = notebookPath;
    const isEnabled = Boolean(cellViewsByNotebook[path]?.[id]?.[option]);
    if (option === "cellCollapsed" && !isEnabled) {
      setEditingId(null);
      setMode("NAV");
    }
    selectCell(id);
    setCellViewsByNotebook((current) => {
      const notebookViews = { ...(current[path] ?? {}) };
      const nextView = { ...(notebookViews[id] ?? {}) };
      if (nextView[option]) delete nextView[option];
      else nextView[option] = true;
      if (Object.keys(nextView).length) notebookViews[id] = nextView;
      else delete notebookViews[id];
      const next = { ...current };
      if (Object.keys(notebookViews).length) next[path] = notebookViews;
      else delete next[path];
      return next;
    });
  }

  function changeCellKind(id: string, kind: CellKind) {
    if (notebookToolLockedRef.current || cellMutationBlocked(id)) return;
    updateCells((current) => current.map((cell) => cell.id === id ? {
      ...cell,
      kind,
      outputs: kind === "code" ? cell.outputs : [],
      executionCount: kind === "code" ? cell.executionCount : null,
    } : cell));
    setEditingId(kind === "markdown" ? null : id);
  }

  function deleteCell(id: string) {
    if (notebookToolLockedRef.current || cellMutationBlocked(id)) return;
    const current = documentRef.current;
    const index = current.cells.findIndex((cell) => cell.id === id);
    if (index < 0) return;
    const remaining = current.cells.filter((cell) => cell.id !== id);
    const nextCells = remaining.length ? remaining : [newCell("code")];
    const nextSelectedId = nextCells[Math.min(index, nextCells.length - 1)].id;
    commitCellStructureChange(nextCells, nextSelectedId, "cell deletion", false);
    if (!current.notebookPath) return;
    const path = current.notebookPath;
    const notebookViews = { ...(cellViewsByNotebookRef.current[path] ?? {}) };
    delete notebookViews[id];
    const allViews = { ...cellViewsByNotebookRef.current };
    if (Object.keys(notebookViews).length) allViews[path] = notebookViews;
    else delete allViews[path];
    cellViewsByNotebookRef.current = allViews;
    setCellViewsByNotebook(allViews);
  }

  function insertAfter(id: string, kind: CellKind) {
    if (notebookToolLockedRef.current || cellMutationBlocked(id)) return;
    const current = documentRef.current.cells;
    const cell = newCell(kind);
    const index = current.findIndex((item) => item.id === id);
    const next = [...current];
    next.splice(index < 0 ? next.length : index + 1, 0, cell);
    commitCellStructureChange(next, cell.id, "cell insertion", true);
  }

  function insertBefore(id: string, kind: CellKind) {
    if (notebookToolLockedRef.current || cellMutationBlocked(id)) return;
    const current = documentRef.current.cells;
    const cell = newCell(kind);
    const index = current.findIndex((item) => item.id === id);
    const next = [...current];
    next.splice(index < 0 ? 0 : index, 0, cell);
    commitCellStructureChange(next, cell.id, "cell insertion", true);
  }

  function revealProposalCell(id: string) {
    selectCell(id);
    setEditingId(null);
    setMode("NAV");
    if (notebookPath) {
      const path = notebookPath;
      setCellViewsByNotebook((current) => {
        const notebookViews = { ...(current[path] ?? {}) };
        const view = { ...(notebookViews[id] ?? {}) };
        if (!view.cellCollapsed) return current;
        delete view.cellCollapsed;
        if (Object.keys(view).length) notebookViews[id] = view;
        else delete notebookViews[id];
        const next = { ...current };
        if (Object.keys(notebookViews).length) next[path] = notebookViews;
        else delete next[path];
        return next;
      });
    }
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-cell-id="${id}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function reviewNextProposal() {
    const path = documentRef.current.notebookPath;
    if (!path) return;
    const proposals = cellProposalsRef.current[path] ?? {};
    const reviewableIds = documentRef.current.cells
      .filter((cell) => proposals[cell.id] && proposals[cell.id].state !== "streaming")
      .map((cell) => cell.id);
    if (!reviewableIds.length) {
      setNotice("Codex is still preparing the current cell proposals.");
      return;
    }
    const selectedIndex = documentRef.current.cells.findIndex((cell) => cell.id === selectedIdRef.current);
    const nextId = documentRef.current.cells
      .slice(selectedIndex + 1)
      .find((cell) => reviewableIds.includes(cell.id))?.id
      ?? reviewableIds[0];
    revealProposalCell(nextId);
  }

  async function applyCellProposal(id: string, runAfter: boolean) {
    const current = documentRef.current;
    const path = current.notebookPath;
    if (!path) return;
    const proposal = cellProposal(id, path);
    const cellIndex = current.cells.findIndex((cell) => cell.id === id);
    const cell = current.cells[cellIndex];
    if (!proposal || !cell) return;
    if (codexTurnActiveRef.current || proposal.state === "streaming" || isCodexCellLocked(id)) {
      setNotice("Wait for the Codex turn to finish before reviewing that proposal.");
      return;
    }
    if (proposal.state === "conflict" || proposal.baseSource !== cell.source) {
      const conflicted = { ...proposal, state: "conflict" as const, updatedAt: Date.now() };
      updateCellProposal(path, id, conflicted);
      setNotice("The accepted cell changed after this proposal was created. Reject it or ask Codex to replace it.");
      return;
    }
    if (notebookToolLockedRef.current) return;
    const kernel = kernelClient.current?.currentState;
    if (runAfter && (kernel === "busy" || kernel === "starting")) {
      setNotice("Wait for the running cell to finish before applying and running this proposal.");
      return;
    }

    notebookToolLockedRef.current = true;
    setNotebookToolLocked(true);
    setEditingId(null);
    setMode("NAV");
    let applied = false;
    try {
      if (savePromise.current && !(await savePromise.current)) return;
      const latest = documentRef.current;
      if (latest.notebookPath !== path) return;
      const latestIndex = latest.cells.findIndex((item) => item.id === id);
      if (latestIndex < 0 || latest.cells[latestIndex].source !== proposal.baseSource) {
        const conflicted = { ...proposal, state: "conflict" as const, updatedAt: Date.now() };
        updateCellProposal(path, id, conflicted);
        setNotice("The accepted cell changed before the proposal could be applied.");
        return;
      }
      const nextCells = [...latest.cells];
      nextCells[latestIndex] = { ...nextCells[latestIndex], source: proposal.draftSource };
      setSaveState("saving");
      await saveNotebook(path, notebookFromCells(nextCells, latest.metadata));
      const nextRevision = revision.current + 1;
      revision.current = nextRevision;
      savedRevision.current = nextRevision;
      documentRef.current = {
        cells: nextCells,
        metadata: latest.metadata,
        notebookPath: path,
        saveState: "saved",
      };
      setCells(nextCells);
      setSaveState("saved");
      updateCellProposal(path, id, null);
      applied = true;
      setNotice(runAfter ? "Applied the Codex proposal; running the cell…" : "Applied and saved the Codex proposal.");
    } catch (error) {
      setSaveState("error");
      setNotice(`Could not apply the Codex proposal: ${String(error)}`);
    } finally {
      notebookToolLockedRef.current = false;
      setNotebookToolLocked(false);
    }
    if (applied && runAfter) await runCell(id, false, false);
  }

  function rejectCellProposal(id: string) {
    const path = documentRef.current.notebookPath;
    if (!path) return;
    const proposal = cellProposal(id, path);
    if (!proposal) return;
    if (codexTurnActiveRef.current || proposal.state === "streaming" || isCodexCellLocked(id)) {
      setNotice("Wait for the Codex turn to finish before rejecting that proposal.");
      return;
    }
    updateCellProposal(path, id, null);
    selectCell(id);
    setEditingId(null);
    setMode("NAV");
    setNotice("Rejected the Codex proposal; the accepted cell was unchanged.");
  }

  function reviewCodexEdit() {
    if (!codexEditReview || codexEditReview.notebookPath !== notebookPath) return;
    const cellId = codexEditReview.affectedCellIds.find((id) => cells.some((cell) => cell.id === id))
      ?? cells[0]?.id;
    if (!cellId) return;
    selectCell(cellId);
    setEditingId(null);
    setMode("NAV");
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-cell-id="${cellId}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  async function undoCodexEdit() {
    const review = codexEditReview;
    if (!review || review.notebookPath !== documentRef.current.notebookPath) return;
    if (codexLockedCellIds(review.notebookPath).length) {
      setNotice("Wait for Codex to finish or unlock the cells before undoing its prior change.");
      return;
    }
    if (review.afterRevision !== revision.current) {
      setNotice("The notebook changed after the Codex edit, so its one-step undo is no longer safe.");
      return;
    }
    notebookToolLockedRef.current = true;
    setNotebookToolLocked(true);
    setSaveState("saving");
    try {
      const restoredCells = cloneDocumentValue(review.beforeCells);
      const restoredMetadata = cloneDocumentValue(review.beforeMetadata);
      await saveNotebook(review.notebookPath, notebookFromCells(restoredCells, restoredMetadata));
      const nextRevision = revision.current + 1;
      revision.current = nextRevision;
      savedRevision.current = nextRevision;
      documentRef.current = {
        cells: restoredCells,
        metadata: restoredMetadata,
        notebookPath: review.notebookPath,
        saveState: "saved",
      };
      setCells(restoredCells);
      setMetadata(restoredMetadata);
      const nextSelected = restoredCells.some((cell) => cell.id === review.beforeSelectedId)
        ? review.beforeSelectedId
        : restoredCells[0].id;
      setSelectedId(nextSelected);
      setSaveState("saved");
      setCodexEditReview(null);
      setNotice("Undid the latest Codex notebook change.");
    } catch (error) {
      setSaveState("error");
      setNotice(`Could not undo the Codex change: ${String(error)}`);
    } finally {
      notebookToolLockedRef.current = false;
      setNotebookToolLocked(false);
    }
  }

  function applyExecution(id: string, result: ExecutionResult, state: "running" | "idle" | "error") {
    setCells((current) => current.map((cell) => cell.id === id ? {
      ...cell,
      outputs: result.outputs,
      executionCount: result.executionCount,
      state,
    } : cell));
  }

  function advanceAfterRun(id: string, insert: boolean, editNext = true) {
    const current = documentRef.current.cells;
    const index = current.findIndex((cell) => cell.id === id);
    if (index < 0) return;
    if (insert || index === current.length - 1) {
      insertAfter(id, "code");
      if (!editNext) {
        setEditingId(null);
        setMode("NAV");
      }
      return;
    }
    const next = current[index + 1];
    const shouldEdit = editNext && next.kind !== "markdown" && !isCodexCellLocked(next.id);
    setSelectedId(next.id);
    setEditingId(shouldEdit ? next.id : null);
    if (!shouldEdit) setMode("NAV");
  }

  async function runCell(id: string, advance: boolean, insert: boolean): Promise<boolean> {
    if (notebookToolLockedRef.current) {
      setNotice("Wait for the Codex cell change to finish before running a cell.");
      return false;
    }
    if (cellMutationBlocked(id)) return false;
    const client = kernelClient.current;
    const cell = documentRef.current.cells.find((item) => item.id === id);
    if (!cell) return false;
    if (cell.kind !== "code") {
      setEditingId(null);
      setMode("NAV");
      if (advance) advanceAfterRun(id, insert, insert);
      return true;
    }
    if (!notebookPath || !client) return false;
    if (!status?.kernel.ready) {
      setNotice(status?.kernel.error
        ? `The selected environment is not ready: ${status.kernel.error}`
        : "Prepare ipykernel in the selected environment first.");
      return false;
    }
    if (client.currentState === "busy" || client.currentState === "starting") {
      setNotice("The Python kernel is already running a cell.");
      return false;
    }

    markDirty();
    setCells((current) => current.map((item) => item.id === id ? {
      ...item,
      outputs: [],
      executionCount: null,
      state: "running",
    } : item));

    try {
      await client.start(notebookPath);
      const result = await client.execute(cell.source, (next) => applyExecution(id, next, "running"));
      const failed = result.outputs.some((output) => output.type === "error");
      applyExecution(id, result, failed ? "error" : "idle");
      markDirty();
      if (advance) advanceAfterRun(id, insert);
      return !failed;
    } catch (error) {
      setCells((current) => current.map((item) => item.id === id ? { ...item, state: "error" } : item));
      markDirty();
      setNotice(`Kernel execution failed: ${String(error)}`);
      return false;
    }
  }

  async function runAll() {
    const codeCellIds = documentRef.current.cells
      .filter((cell) => cell.kind === "code")
      .map((cell) => cell.id);
    for (const id of codeCellIds) {
      if (!(await runCell(id, false, false))) break;
    }
  }

  async function interruptKernel() {
    try {
      await kernelClient.current?.interrupt();
    } catch (error) {
      setNotice(`Could not interrupt the kernel: ${String(error)}`);
    }
  }

  function exportNotebook() {
    if (!notebookPath) return;
    const content = notebookFromCells(cells, metadata);
    const blob = new Blob([JSON.stringify(content, null, 2)], { type: "application/x-ipynb+json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = basename(notebookPath);
    anchor.click();
    URL.revokeObjectURL(href);
  }

  function paneMaximum(side: PaneSide): number {
    const otherSelector = side === "left" ? ".codex-panel" : ".file-panel";
    const otherIsOpen = side === "left" ? rightOpen : leftOpen;
    const otherWidth = otherIsOpen
      ? document.querySelector<HTMLElement>(otherSelector)?.getBoundingClientRect().width ?? 0
      : 0;
    const hardMaximum = side === "left" ? LEFT_PANE_MAX : RIGHT_PANE_MAX;
    const minimum = side === "left" ? LEFT_PANE_MIN : RIGHT_PANE_MIN;
    return Math.max(
      minimum,
      Math.min(hardMaximum, window.innerWidth - otherWidth - MIN_NOTEBOOK_WIDTH),
    );
  }

  function applyPaneWidth(side: PaneSide, value: number, persist: boolean): number {
    const minimum = side === "left" ? LEFT_PANE_MIN : RIGHT_PANE_MIN;
    const next = Math.round(clamp(value, minimum, paneMaximum(side)));
    if (side === "left") {
      setLeftPaneWidth(next);
      if (persist) storePaneWidth(LEFT_PANE_STORAGE, next);
    } else {
      setRightPaneWidth(next);
      if (persist) storePaneWidth(RIGHT_PANE_STORAGE, next);
    }
    return next;
  }

  function startPaneResize(side: PaneSide, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const panelSelector = side === "left" ? ".file-panel" : ".codex-panel";
    const renderedWidth = document.querySelector<HTMLElement>(panelSelector)
      ?.getBoundingClientRect().width;
    const startWidth = renderedWidth ?? (side === "left" ? leftPaneWidth : rightPaneWidth);
    let latestWidth = startWidth;
    document.body.classList.add("is-resizing-pane");

    function move(pointerEvent: PointerEvent) {
      const delta = side === "left"
        ? pointerEvent.clientX - startX
        : startX - pointerEvent.clientX;
      latestWidth = applyPaneWidth(side, startWidth + delta, false);
    }

    function finish() {
      document.body.classList.remove("is-resizing-pane");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      storePaneWidth(side === "left" ? LEFT_PANE_STORAGE : RIGHT_PANE_STORAGE, latestWidth);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function resizePaneWithKeyboard(side: PaneSide, event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const panelSelector = side === "left" ? ".file-panel" : ".codex-panel";
    const renderedWidth = document.querySelector<HTMLElement>(panelSelector)
      ?.getBoundingClientRect().width;
    const current = renderedWidth ?? (side === "left" ? leftPaneWidth : rightPaneWidth);
    const physicalDelta = event.key === "ArrowRight" ? 16 : -16;
    applyPaneWidth(side, current + (side === "left" ? physicalDelta : -physicalDelta), true);
  }

  function resetPaneWidth(side: PaneSide) {
    applyPaneWidth(side, side === "left" ? LEFT_PANE_DEFAULT : RIGHT_PANE_DEFAULT, true);
  }

  const workspaceName = status ? basename(status.config.workspace) : "workspace";
  const environmentName = status ? basename(status.config.venv) : ".venv";
  const activeLockedCellIds = notebookPath ? codexCellLocks[notebookPath] ?? [] : [];
  const activeCellProposals = notebookPath ? cellProposalsByNotebook[notebookPath] ?? {} : {};
  const acceptedSelectedCell = cells.find((cell) => cell.id === selectedId) ?? null;
  const selectedCellForCodex = acceptedSelectedCell && activeCellProposals[acceptedSelectedCell.id]
    ? { ...acceptedSelectedCell, source: activeCellProposals[acceptedSelectedCell.id].draftSource }
    : acceptedSelectedCell;
  const vimLayer = mode === "NAV" ? "NAV" : mode === "INSERT" || mode === "REPLACE" ? "INSERT" : "NORMAL";
  const appShellStyle = {
    "--left-pane-width": `${leftPaneWidth}px`,
    "--right-pane-width": `${rightPaneWidth}px`,
  } as CSSProperties;
  const paletteCommands: PaletteCommand[] = [
    {
      id: "notebook.new",
      label: "New notebook",
      detail: `Create in ${treeDirectory || "workspace root"}`,
      shortcut: "",
      run: () => void newNotebook(),
    },
    {
      id: "notebook.save",
      label: "Save notebook",
      detail: notebookPath ?? "No notebook open",
      shortcut: "⌘S",
      disabled: !notebookPath || saveState === "saving",
      run: () => void persistNotebook(),
    },
    {
      id: "notebook.runAll",
      label: "Run all cells",
      detail: "Execute code cells from top to bottom",
      disabled: !notebookPath || !status?.kernel.ready || kernelState === "busy",
      run: () => void runAll(),
    },
    {
      id: "workspace.refresh",
      label: "Refresh workspace",
      detail: "Reload the file tree and active notebook",
      run: () => void refreshWorkspace(),
    },
    {
      id: "environment.select",
      label: "Select Python environment",
      detail: status?.config.venv ?? "Choose a uv environment",
      disabled: !status,
      run: () => setEnvironmentOpen(true),
    },
    {
      id: "panel.workspace",
      label: `${leftOpen ? "Hide" : "Show"} workspace panel`,
      detail: "Toggle the file tree",
      run: () => setLeftOpen((value) => !value),
    },
    {
      id: "panel.codex",
      label: `${rightOpen ? "Hide" : "Show"} Codex panel`,
      detail: "Toggle the assistant",
      run: () => setRightOpen((value) => !value),
    },
    {
      id: "codex.focus",
      label: "Focus Codex prompt",
      detail: "Open Codex and move focus to its prompt",
      shortcut: "C",
      run: focusCodexPrompt,
    },
    {
      id: "editor.vim",
      label: `${vimEnabled ? "Disable" : "Enable"} Vim bindings`,
      detail: "Code and raw cell editor keybindings",
      run: () => setVimEnabled((value) => !value),
    },
    {
      id: "help.keys",
      label: "Show keyboard shortcuts",
      detail: "Notebook navigation and app commands",
      run: () => setNotice("Keys: ⌘/Ctrl-P quick open · ⇧⌘/Ctrl-P commands · J/K select · A/O insert after · ⇧O insert before · C focus Codex · Escape step back · ⌘/Ctrl-S save"),
    },
  ];
  return (
    <div
      className={`app-shell ${leftOpen ? "has-left" : ""} ${rightOpen ? "has-right" : ""}`}
      style={appShellStyle}
    >
      <header className="titlebar">
        <div className="brand"><i><span>Z</span></i><span>zbook</span></div>
        <div className="title-actions">
          <button className={leftOpen ? "is-active" : ""} onClick={() => setLeftOpen((value) => !value)} aria-label="Toggle files"><PanelIcon /></button>
          <button className="quick-open-button" onClick={() => openCommandPalette("files")} aria-label="Quick open" title="Quick open (Ctrl/Cmd-P)"><SearchIcon /></button>
          {kernelState === "busy" ? (
            <button className="run-all" onClick={() => void interruptKernel()}><StopIcon />Interrupt</button>
          ) : (
            <button className="run-all" disabled={!notebookPath || notebookToolLocked || !status?.kernel.ready} onClick={() => void runAll()}><PlayIcon />Run all</button>
          )}
          <button className={rightOpen ? "is-active" : ""} onClick={() => setRightOpen((value) => !value)} aria-label="Toggle Codex"><PanelIcon /></button>
        </div>
      </header>
      {leftOpen && (
        <FileTree
          workspaceName={workspaceName}
          environmentName={environmentName}
          pythonVersion={status?.kernel.python_version ? `Python ${status.kernel.python_version}` : "Python"}
          activePath={notebookPath}
          activeDirectory={treeDirectory}
          directories={directories}
          loadingPaths={loadingPaths}
          onLoadDirectory={(path, refresh) => void loadDirectory(path, refresh)}
          onRefresh={() => void refreshWorkspace()}
          onOpen={openEntry}
          onNewNotebook={() => void newNotebook()}
          onNewFolder={() => void newFolder()}
          onUpload={(files) => void uploadFiles(files)}
          onSelectDirectory={setTreeDirectory}
          onRename={(entry) => void renameContent(entry)}
          onDelete={(entry) => void deleteContent(entry)}
          onEnvironment={() => setEnvironmentOpen(true)}
        />
      )}
      {leftOpen && (
        <div
          className="pane-resizer pane-resizer-left"
          role="separator"
          aria-label="Resize workspace pane"
          aria-orientation="vertical"
          aria-valuemin={LEFT_PANE_MIN}
          aria-valuemax={LEFT_PANE_MAX}
          aria-valuenow={leftPaneWidth}
          tabIndex={0}
          title="Drag to resize workspace · double-click to reset"
          onPointerDown={(event) => startPaneResize("left", event)}
          onKeyDown={(event) => resizePaneWithKeyboard("left", event)}
          onDoubleClick={() => resetPaneWidth("left")}
        />
      )}
      <section className="notebook-area">
        <div className="tabbar" role="tablist" aria-label="Open notebooks">
          <div className="tab-strip">
            {openTabs.length ? openTabs.map((path) => {
              const active = path === notebookPath;
              return (
                <div
                  className={`notebook-tab ${active ? "is-active" : ""}`}
                  key={path}
                  ref={active ? activeTabRef : undefined}
                  onDoubleClick={(event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest(".tab-close, .tab-rename-input")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    beginTabRename(path);
                  }}
                >
                  {renamingTabPath === path ? (
                    <div className="tab-rename-editor" role="tab" aria-selected={active}>
                      <span className="notebook-icon">▦</span>
                      <input
                        className="tab-rename-input"
                        value={renamingTabName}
                        autoFocus
                        aria-label={`Rename ${basename(path)}`}
                        title="Enter to rename · Escape to cancel"
                        onFocus={(event) => {
                          const extensionStart = event.currentTarget.value.toLowerCase().endsWith(".ipynb")
                            ? event.currentTarget.value.length - 6
                            : event.currentTarget.value.length;
                          event.currentTarget.setSelectionRange(0, extensionStart);
                        }}
                        onChange={(event) => setRenamingTabName(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onBlur={() => setRenamingTabPath((current) => current === path ? null : current)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.stopPropagation();
                            void commitTabRename(path, event.currentTarget.value);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            setRenamingTabPath(null);
                            setRenamingTabName("");
                          }
                        }}
                      />
                      <i className={active && saveState !== "saved" ? "is-dirty" : ""} />
                    </div>
                  ) : (
                    <button
                      className="tab-select"
                      type="button"
                      role="tab"
                      aria-selected={active}
                      title={`${path} · double-click to rename`}
                      disabled={busy || notebookToolLocked || kernelState === "busy" || kernelState === "starting"}
                      onClick={() => void openNotebook(path)}
                    >
                      <span className="notebook-icon">▦</span>
                      <span className="tab-label">{basename(path)}</span>
                      <i className={active && saveState !== "saved" ? "is-dirty" : ""} />
                    </button>
                  )}
                  <button
                    className="tab-close"
                    type="button"
                    aria-label={`Close ${basename(path)}`}
                    title={`Close ${path}`}
                    disabled={busy || notebookToolLocked || kernelState === "busy" || kernelState === "starting"}
                    onClick={() => void closeNotebookTab(path)}
                  ><CloseIcon /></button>
                </div>
              );
            }) : <div className="empty-tab">No notebook open</div>}
          </div>
          <button
            className="tab-add"
            type="button"
            disabled={busy || notebookToolLocked || kernelState === "busy" || kernelState === "starting"}
            onClick={() => void newNotebook()}
            aria-label="New notebook"
            title="New notebook"
          ><PlusIcon /></button>
        </div>
        {notebookPath ? (
          <Notebook
            path={notebookPath}
            cells={cells}
            selectedId={selectedId}
            editingId={editingId}
            vimEnabled={vimEnabled}
            saveState={saveState}
            canRun={Boolean(status?.kernel.ready) && !notebookToolLocked && kernelState !== "busy" && kernelState !== "starting"}
            locked={notebookToolLocked}
            lockedCellIds={activeLockedCellIds}
            proposalActionsDisabled={codexTurnActive}
            cellProposals={activeCellProposals}
            codexChangedCellIds={codexEditReview?.notebookPath === notebookPath ? codexEditReview.affectedCellIds : []}
            codexUndoAvailable={Boolean(
              codexEditReview
              && codexEditReview.notebookPath === notebookPath
              && codexEditReview.afterRevision === revision.current
              && !notebookToolLocked
              && activeLockedCellIds.length === 0
            )}
            cellViews={cellViewsByNotebook[notebookPath] ?? {}}
            onSelect={selectCell}
            onEdit={beginCellEditing}
            onChange={updateCell}
            onChangeKind={changeCellKind}
            onDelete={deleteCell}
            onRun={runCell}
            onAddAfter={insertAfter}
            onReviewNextProposal={reviewNextProposal}
            onApplyProposal={(id, runAfter) => void applyCellProposal(id, runAfter)}
            onRejectProposal={rejectCellProposal}
            onReviewCodexChange={reviewCodexEdit}
            onUndoCodexChange={() => void undoCodexEdit()}
            onToggleCellView={toggleCellView}
            onSave={() => void persistNotebook()}
            onExport={exportNotebook}
            onReload={() => void reloadNotebook()}
            onModeChange={setMode}
            onStopEdit={enterCellNavigation}
          />
        ) : (
          <main className="empty-workspace">
            <div><span>▦</span><h1>Open a notebook</h1><p>Choose an `.ipynb` file from the workspace or create a new one.</p><button onClick={() => void newNotebook()}><PlusIcon />New notebook</button></div>
          </main>
        )}
      </section>
      {rightOpen && (
        <div
          className="pane-resizer pane-resizer-right"
          role="separator"
          aria-label="Resize Codex pane"
          aria-orientation="vertical"
          aria-valuemin={RIGHT_PANE_MIN}
          aria-valuemax={RIGHT_PANE_MAX}
          aria-valuenow={rightPaneWidth}
          tabIndex={0}
          title="Drag to resize Codex · double-click to reset"
          onPointerDown={(event) => startPaneResize("right", event)}
          onKeyDown={(event) => resizePaneWithKeyboard("right", event)}
          onDoubleClick={() => resetPaneWidth("right")}
        />
      )}
      {rightOpen && (
        <CodexPanel
          available={status ? Boolean(status.tools.codex) : null}
          workspace={status?.config.workspace ?? null}
          notebookPath={notebookPath}
          selectedCell={selectedCellForCodex}
          onBeforePrompt={ensureDocumentSaved}
          onWorkspaceChanged={() => void refreshAfterCodexChange()}
          onTurnStarted={startCodexTurn}
          onTurnFinished={finishCodexTurn}
          onNotebookToolCall={handleNotebookToolCall}
          onReturnToNotebook={() => enterCellNavigation(selectedIdRef.current)}
        />
      )}
      {environmentOpen && status && (
        <EnvironmentPanel
          venv={status.config.venv}
          python={status.config.python}
          mode={status.config.environment_mode}
          kernel={status.kernel}
          onClose={() => setEnvironmentOpen(false)}
          onChanged={() => void refreshStatus()}
          onSelect={changeEnvironment}
        />
      )}
      {paletteMode && (
        <CommandPalette
          mode={paletteMode}
          files={paletteFiles}
          commands={paletteCommands}
          loading={paletteLoading}
          onOpenFile={openPaletteFile}
          onClose={() => setPaletteMode(null)}
        />
      )}
      <footer className="statusbar">
        <div><BranchIcon />main</div>
        <div className="status-vim-controls" ref={vimKeymapRef}>
          <button
            onClick={() => {
              setVimEnabled((value) => !value);
              setVimKeymapOpen(false);
            }}
            className={vimEnabled ? "status-enabled" : ""}
            title={vimEnabled ? "Disable Vim bindings" : "Enable Vim bindings"}
          >
            {`${vimEnabled ? "VIM · " : ""}${mode}${pendingCellDeleteId ? " · D…" : ""}`}
          </button>
          {vimEnabled && (
            <>
              <button
                type="button"
                className={`vim-keymap-chip ${vimKeymapOpen ? "is-open" : ""}`}
                aria-label="Show Vim notebook keybindings"
                aria-expanded={vimKeymapOpen}
                aria-controls="vim-keymap-popover"
                title="Vim notebook keybindings"
                onClick={() => setVimKeymapOpen((value) => !value)}
              >
                <span className={vimLayer === "NAV" ? "is-current" : ""}>NAV</span>
                <i>›</i>
                <span className={vimLayer === "NORMAL" ? "is-current" : ""}>NORMAL</span>
                <i>›</i>
                <span className={vimLayer === "INSERT" ? "is-current" : ""}>INSERT</span>
              </button>
              {vimKeymapOpen && (
                <div id="vim-keymap-popover" className="vim-keymap-popover" role="dialog" aria-label="Vim notebook keybindings">
                  <header>
                    <strong>Vim notebook layers</strong>
                    <span><kbd>Esc</kbd> moves left one layer</span>
                  </header>
                  <div className={`vim-keymap-row ${vimLayer === "NAV" ? "is-current" : ""}`}>
                    <div><b>Cell navigation</b><em>Notebook</em></div>
                    <p><span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>Enter</kbd>/<kbd>I</kbd> enter editor</span></p>
                    <p><span><kbd>A</kbd>/<kbd>O</kbd> insert after</span><span><kbd>⇧ O</kbd> insert before</span></p>
                    <p><span><kbd>D D</kbd> delete · 500 ms</span><span><kbd>U</kbd> undo</span></p>
                    <p><span><kbd>Ctrl R</kbd> redo</span><span><kbd>C</kbd> focus Codex</span></p>
                  </div>
                  <div className={`vim-keymap-row ${vimLayer === "NORMAL" ? "is-current" : ""}`}>
                    <div><b>Vim normal</b><em>Editor commands</em></div>
                    <p><span><kbd>I</kbd>/<kbd>A</kbd>/<kbd>O</kbd> insert mode</span><span><kbd>Esc</kbd> cell navigation</span></p>
                  </div>
                  <div className={`vim-keymap-row ${vimLayer === "INSERT" ? "is-current" : ""}`}>
                    <div><b>Vim insert</b><em>Text editing</em></div>
                    <p><span>Type to edit</span><span><kbd>Esc</kbd> Vim normal</span></p>
                  </div>
                  <div className="vim-keymap-footer"><kbd>Ctrl ↵</kbd> run <kbd>Shift ↵</kbd> run + next <kbd>Alt ↵</kbd> run + insert</div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="status-spacer" />
        <span>{status?.config.environment_mode === "project" ? "uv project" : "uv environment"}</span>
        <span>{environmentName}</span>
        <span>kernel: {kernelState}</span>
        <span>{notebookPath ?? "No notebook"}</span>
      </footer>
      {busy && <div className="busy-indicator" role="status" aria-live="polite"><i />Working…</div>}
      {notice && <button className="notice" role="status" aria-live="polite" onClick={() => setNotice(null)}>{notice}</button>}
    </div>
  );
}
