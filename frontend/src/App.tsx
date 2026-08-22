import { useEffect, useRef, useState } from "react";
import { CodexPanel } from "./components/CodexPanel";
import { EnvironmentPanel } from "./components/EnvironmentPanel";
import { FileTree } from "./components/FileTree";
import { BranchIcon, CloseIcon, PanelIcon, PlayIcon, PlusIcon, StopIcon } from "./components/icons";
import { Notebook, type SaveState } from "./components/Notebook";
import {
  cellsFromNotebook,
  newCell,
  notebookFromCells,
  type CellKind,
  type NotebookCell,
  type RawNotebook,
} from "./model/notebook";
import {
  applyNotebookOperations,
  NOTEBOOK_APPLY_TOOL,
  NOTEBOOK_READ_TOOL,
  NotebookToolInputError,
  parseNotebookToolArguments,
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

export default function App() {
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [metadata, setMetadata] = useState<Record<string, unknown>>({});
  const [notebookPath, setNotebookPath] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mode, setMode] = useState("NAV");
  const [vimEnabled, setVimEnabled] = useState(true);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [directories, setDirectories] = useState<Record<string, ContentEntry[]>>({});
  const [treeDirectory, setTreeDirectory] = useState("");
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set([""]));
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [kernelState, setKernelState] = useState<KernelState>("disconnected");
  const [busy, setBusy] = useState(false);
  const [notebookToolLocked, setNotebookToolLocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const notebookToolLockedRef = useRef(false);
  const directoriesRef = useRef(directories);
  const openTabsRef = useRef(openTabs);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const directoryRequestVersions = useRef<Record<string, number>>({});
  const kernelClient = useRef<KernelClient | null>(null);
  if (kernelClient.current === null) kernelClient.current = new KernelClient(setKernelState);
  const documentRef = useRef({ cells, metadata, notebookPath, saveState });
  documentRef.current = { cells, metadata, notebookPath, saveState };
  directoriesRef.current = directories;
  openTabsRef.current = openTabs;

  useEffect(() => {
    void refreshStatus();
    void loadDirectory("", true);
  }, []);

  useEffect(() => () => {
    void kernelClient.current?.shutdown();
  }, []);

  useEffect(() => {
    if (saveState !== "dirty" || !notebookPath) return;
    const timer = window.setTimeout(() => void persistNotebook(), 900);
    return () => window.clearTimeout(timer);
  }, [cells, metadata, notebookPath, saveState]);

  useEffect(() => {
    function handleGlobalKeys(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void persistNotebook();
        return;
      }
      if (mode !== "NAV" || cells.length === 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("textarea, input, select, .cm-editor")) return;
      const index = Math.max(0, cells.findIndex((cell) => cell.id === selectedId));
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedId(cells[Math.min(index + 1, cells.length - 1)].id);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedId(cells[Math.max(index - 1, 0)].id);
      } else if (event.key === "Enter" || event.key === "i") {
        event.preventDefault();
        setEditingId(selectedId);
        setMode(vimEnabled ? "NORMAL" : "INSERT");
      } else if (event.key === "o") {
        event.preventDefault();
        insertAfter(selectedId, "code");
      }
    }
    window.addEventListener("keydown", handleGlobalKeys);
    return () => window.removeEventListener("keydown", handleGlobalKeys);
  }, [cells, mode, selectedId, vimEnabled]);

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
    if (!fromExternalChange && documentRef.current.saveState !== "saved") {
      if (!window.confirm("Discard unsaved changes and reload this notebook?")) return;
    }
    setBusy(true);
    try {
      const model = await readNotebook(path);
      const notebook = model.content as RawNotebook;
      const loadedCells = cellsFromNotebook(notebook);
      revision.current += 1;
      savedRevision.current = revision.current;
      setCells(loadedCells);
      setMetadata(notebook.metadata ?? {});
      setSelectedId(loadedCells[0].id);
      setEditingId(null);
      setMode("NAV");
      setSaveState(notebook.cells.length === 0 ? "dirty" : "saved");
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
      return {
        success: true,
        result: {
          notebookPath: current.notebookPath,
          documentRevision: revision.current,
          selectedCellId: selectedId || null,
          saveState: current.saveState,
          cells: current.cells.map((cell, index) => ({
            index,
            id: cell.id,
            cellType: cell.kind,
            source: cell.source,
            executionCount: cell.executionCount,
          })),
        },
      };
    }
    if (tool !== NOTEBOOK_APPLY_TOOL) {
      return { success: false, result: { error: `Unknown notebook tool: ${tool}` } };
    }
    if (!current.notebookPath) {
      return { success: false, result: { error: "No notebook is open in Zbook." } };
    }
    if (notebookToolLockedRef.current) {
      return { success: false, result: { error: "Another notebook tool call is still running." } };
    }
    if (kernelClient.current?.currentState === "busy" || kernelClient.current?.currentState === "starting") {
      return { success: false, result: { error: "Wait for the running cell to finish before editing it." } };
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

    let applied;
    try {
      applied = applyNotebookOperations(current.cells, args.operations);
    } catch (error) {
      const message = error instanceof NotebookToolInputError ? error.message : String(error);
      return { success: false, result: { error: "invalid_operations", message } };
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
      setCells(applied.cells);
      setSaveState("saved");
      const nextSelected = applied.insertedCellIds.at(-1)
        ?? applied.affectedCellIds.find((id) => applied.cells.some((cell) => cell.id === id))
        ?? (applied.cells.some((cell) => cell.id === selectedId) ? selectedId : applied.cells[0].id);
      setSelectedId(nextSelected);
      setNotice(`Codex updated ${applied.affectedCellIds.length} notebook cell${applied.affectedCellIds.length === 1 ? "" : "s"}.`);
      return {
        success: true,
        result: {
          notebookPath: current.notebookPath,
          documentRevision: nextRevision,
          affectedCellIds: applied.affectedCellIds,
          insertedCellIds: applied.insertedCellIds,
          cellCount: applied.cells.length,
          saved: true,
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

  async function loadNotebookDocument(path: string, rememberTab: boolean): Promise<boolean> {
    setBusy(true);
    try {
      const model = await readNotebook(path);
      const notebook = model.content as RawNotebook;
      const loadedCells = cellsFromNotebook(notebook);
      revision.current += 1;
      savedRevision.current = revision.current;
      setNotebookPath(path);
      setTreeDirectory(parentPath(path));
      setCells(loadedCells);
      setMetadata(notebook.metadata ?? {});
      setSelectedId(loadedCells[0].id);
      setEditingId(loadedCells[0].kind === "markdown" ? null : loadedCells[0].id);
      setMode("NAV");
      setSaveState(notebook.cells.length === 0 ? "dirty" : "saved");
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

  async function renameContent(entry: ContentEntry) {
    const requested = window.prompt(`Rename ${entry.name}`, entry.name)?.trim();
    if (!requested || requested === entry.name) return;
    if (requested.includes("/") || requested.includes("\\")) {
      setNotice("A file name cannot contain path separators.");
      return;
    }
    const parent = parentPath(entry.path);
    const newPath = parent ? `${parent}/${requested}` : requested;
    const activePath = documentRef.current.notebookPath;
    const containsActive = Boolean(activePath && isSameOrChild(activePath, entry.path));
    if (containsActive && notebookTransitionBlocked()) return;
    try {
      if (containsActive && !(await ensureDocumentSaved())) return;
      await renameEntry(entry.path, newPath);
      if (activePath && containsActive) setNotebookPath(`${newPath}${activePath.slice(entry.path.length)}`);
      setOpenTabs((current) => [
        ...new Set(current.map((path) => (
          isSameOrChild(path, entry.path) ? `${newPath}${path.slice(entry.path.length)}` : path
        ))),
      ]);
      if (treeDirectory === entry.path || treeDirectory.startsWith(`${entry.path}/`)) {
        setTreeDirectory(`${newPath}${treeDirectory.slice(entry.path.length)}`);
      }
      await loadDirectory(parent, true);
      setNotice(`Renamed to ${requested}`);
    } catch (error) {
      setNotice(`Rename failed: ${String(error)}`);
    }
  }

  async function deleteContent(entry: ContentEntry) {
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
    updateCells((current) => current.map((cell) => cell.id === id ? { ...cell, source } : cell));
  }

  function selectCell(id: string) {
    if (id !== selectedId) {
      setEditingId(null);
      setMode("NAV");
    }
    setSelectedId(id);
  }

  function changeCellKind(id: string, kind: CellKind) {
    if (notebookToolLockedRef.current) return;
    updateCells((current) => current.map((cell) => cell.id === id ? {
      ...cell,
      kind,
      outputs: kind === "code" ? cell.outputs : [],
      executionCount: kind === "code" ? cell.executionCount : null,
    } : cell));
    setEditingId(kind === "markdown" ? null : id);
  }

  function deleteCell(id: string) {
    if (notebookToolLockedRef.current) return;
    const remaining = cells.filter((cell) => cell.id !== id);
    const replacement = remaining.length ? null : newCell("code");
    updateCells((current) => {
      const next = current.filter((cell) => cell.id !== id);
      return next.length ? next : [replacement!];
    });
    setSelectedId(remaining[0]?.id ?? replacement!.id);
    setEditingId(null);
    setMode("NAV");
  }

  function insertAfter(id: string, kind: CellKind) {
    if (notebookToolLockedRef.current) return;
    const cell = newCell(kind);
    updateCells((current) => {
      const index = current.findIndex((item) => item.id === id);
      const next = [...current];
      next.splice(index < 0 ? next.length : index + 1, 0, cell);
      return next;
    });
    setSelectedId(cell.id);
    setEditingId(cell.id);
  }

  function applyExecution(id: string, result: ExecutionResult, state: "running" | "idle" | "error") {
    setCells((current) => current.map((cell) => cell.id === id ? {
      ...cell,
      outputs: result.outputs,
      executionCount: result.executionCount,
      state,
    } : cell));
  }

  function advanceAfterRun(id: string, insert: boolean) {
    const current = documentRef.current.cells;
    const index = current.findIndex((cell) => cell.id === id);
    if (index < 0) return;
    if (insert || index === current.length - 1) {
      insertAfter(id, "code");
      return;
    }
    const next = current[index + 1];
    setSelectedId(next.id);
    setEditingId(next.kind === "markdown" ? null : next.id);
  }

  async function runCell(id: string, advance: boolean, insert: boolean): Promise<boolean> {
    if (notebookToolLockedRef.current) {
      setNotice("Wait for the Codex cell change to finish before running a cell.");
      return false;
    }
    const client = kernelClient.current;
    const cell = documentRef.current.cells.find((item) => item.id === id);
    if (!cell) return false;
    if (cell.kind !== "code") {
      setEditingId(null);
      if (advance) advanceAfterRun(id, insert);
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

  const workspaceName = status ? basename(status.config.workspace) : "workspace";
  const environmentName = status ? basename(status.config.venv) : ".venv";
  return (
    <div className={`app-shell ${leftOpen ? "has-left" : ""} ${rightOpen ? "has-right" : ""}`}>
      <header className="titlebar">
        <div className="brand"><i><span>Z</span></i><span>zbook</span></div>
        <div className="title-actions">
          <button className={leftOpen ? "is-active" : ""} onClick={() => setLeftOpen((value) => !value)} aria-label="Toggle files"><PanelIcon /></button>
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
                >
                  <button
                    className="tab-select"
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={path}
                    disabled={busy || notebookToolLocked || kernelState === "busy" || kernelState === "starting"}
                    onClick={() => void openNotebook(path)}
                  >
                    <span className="notebook-icon">▦</span>
                    <span className="tab-label">{basename(path)}</span>
                    <i className={active && saveState !== "saved" ? "is-dirty" : ""} />
                  </button>
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
            onSelect={selectCell}
            onEdit={(id) => {
              if (notebookToolLockedRef.current) return;
              setSelectedId(id);
              setEditingId(id);
              setMode(vimEnabled ? "NORMAL" : "INSERT");
            }}
            onChange={updateCell}
            onChangeKind={changeCellKind}
            onDelete={deleteCell}
            onRun={runCell}
            onAdd={(kind) => insertAfter(cells.at(-1)?.id ?? selectedId, kind)}
            onSave={() => void persistNotebook()}
            onExport={exportNotebook}
            onReload={() => void reloadNotebook()}
            onModeChange={setMode}
            onStopEdit={(id) => setEditingId((current) => current === id ? null : current)}
          />
        ) : (
          <main className="empty-workspace">
            <div><span>▦</span><h1>Open a notebook</h1><p>Choose an `.ipynb` file from the workspace or create a new one.</p><button onClick={() => void newNotebook()}><PlusIcon />New notebook</button></div>
          </main>
        )}
      </section>
      {rightOpen && (
        <CodexPanel
          available={status ? Boolean(status.tools.codex) : null}
          notebookPath={notebookPath}
          selectedCell={cells.find((cell) => cell.id === selectedId) ?? null}
          onBeforePrompt={ensureDocumentSaved}
          onWorkspaceChanged={() => void refreshAfterCodexChange()}
          onNotebookToolCall={handleNotebookToolCall}
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
      <footer className="statusbar">
        <div><BranchIcon />main</div>
        <button onClick={() => setVimEnabled((value) => !value)} className={vimEnabled ? "status-enabled" : ""}>
          {vimEnabled ? `VIM · ${mode}` : mode}
        </button>
        <div className="status-spacer" />
        <span>{status?.config.environment_mode === "project" ? "uv project" : "uv environment"}</span>
        <span>{environmentName}</span>
        <span>kernel: {kernelState}</span>
        <span>{notebookPath ?? "No notebook"}</span>
      </footer>
      {busy && <div className="busy-indicator"><i />Working…</div>}
      {notice && <button className="notice" onClick={() => setNotice(null)}>{notice}</button>}
    </div>
  );
}
