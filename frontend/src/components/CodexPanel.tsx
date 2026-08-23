import { FormEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { NotebookCell } from "../model/notebook";
import {
  selectionLineLabel,
  selectionPreview,
  type NotebookSelectionQuote,
} from "../model/selectionContext";
import {
  NOTEBOOK_APPLY_TOOL,
  NOTEBOOK_LOCK_TOOL,
  NOTEBOOK_PROPOSE_TOOL,
  type NotebookToolContext,
  type NotebookToolResponse,
} from "../model/notebookTools";
import { websocketUrl } from "../services/http";
import { ChevronIcon, CloseIcon, HistoryIcon, RefreshIcon, SparkIcon, StopIcon } from "./icons";

type MessageRole = "user" | "assistant" | "activity";
type ConnectionState = "checking" | "connecting" | "ready" | "error";

interface Message {
  id: string;
  role: MessageRole;
  text: string;
  pending?: boolean;
  welcome?: boolean;
}

interface StoredThread {
  id: string;
  title: string;
  updatedAt: number;
}

interface WorkspaceThreadStore {
  workspace: string | null;
  activeId: string | null;
  threads: StoredThread[];
}

interface Approval {
  requestId: string | number;
  method: string;
  title: string;
  detail: string;
  decisions: string[];
}

interface AccountState {
  account?: { type: string; email?: string | null; planType?: string } | null;
  requiresOpenaiAuth: boolean;
}

interface ReasoningOption {
  reasoningEffort: string;
  description?: string;
}

interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ReasoningOption[];
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  planType?: string | null;
}

interface RateLimitsState {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
  rateLimitResetCredits?: { availableCount?: number } | null;
}

interface CodexEvent {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

interface CodexPanelProps {
  available: boolean | null;
  workspace: string | null;
  notebookPath: string | null;
  selectedCell: NotebookCell | null;
  selectionQuote: NotebookSelectionQuote | null;
  onBeforePrompt: () => Promise<boolean>;
  onWorkspaceChanged: () => void;
  onTurnStarted: () => void;
  onTurnFinished: () => void;
  onNotebookToolCall: (
    tool: string,
    argumentsValue: unknown,
    context: NotebookToolContext,
  ) => Promise<NotebookToolResponse>;
  onReturnToNotebook: () => void;
  onClearSelectionQuote: () => void;
}

interface QuotaView {
  label: string;
  remaining: number;
  resetsAt: number | null;
  weekly: boolean;
}

// Version the preference once so browsers that auto-saved the former Terra
// default receive the new Luna default. Explicit choices persist from here on.
const MODEL_STORAGE = "zbook.codex.model.v2";
const EFFORT_STORAGE = "zbook.codex.effort";
const WEEK_MINUTES = 7 * 24 * 60;
const THREAD_STORE_VERSION = 1;
const MAX_STORED_THREADS = 30;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000] as const;

function initialMessages(): Message[] {
  return [{
    id: crypto.randomUUID(),
    role: "assistant",
    text: "I can work in this workspace and edit the open notebook directly through Zbook's cell tools.",
    welcome: true,
  }];
}

function threadStorageKey(workspace: string): string {
  return `zbook.codex.threads.v${THREAD_STORE_VERSION}:${workspace}`;
}

function loadThreadStore(workspace: string): WorkspaceThreadStore {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(threadStorageKey(workspace)) ?? "null") as {
      activeId?: unknown;
      threads?: unknown;
    } | null;
    const threads = Array.isArray(parsed?.threads)
      ? parsed.threads.flatMap((item): StoredThread[] => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.title !== "string") return [];
        return [{
          id: record.id,
          title: record.title.slice(0, 120) || "Untitled thread",
          updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
        }];
      }).slice(0, MAX_STORED_THREADS)
      : [];
    const activeId = typeof parsed?.activeId === "string"
      && threads.some((thread) => thread.id === parsed.activeId)
      ? parsed.activeId
      : null;
    return { workspace, activeId, threads };
  } catch {
    return { workspace, activeId: null, threads: [] };
  }
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split("\n", 1)[0].replace(/\s+/g, " ");
  return firstLine.length > 52 ? `${firstLine.slice(0, 49)}…` : firstLine || "Untitled thread";
}

function threadTime(timestamp: number): string {
  if (!timestamp) return "Earlier";
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function errorDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    return String((value as { message: unknown }).message);
  }
  return value ? JSON.stringify(value) : "The Codex turn did not complete.";
}

function storedValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeValue(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be disabled without affecting the active session.
  }
}

function modelValue(model: CodexModel): string {
  return model.model || model.id;
}

function modelEfforts(model: CodexModel | undefined): string[] {
  return model?.supportedReasoningEfforts
    .map((option) => option.reasoningEffort)
    .filter(Boolean) ?? [];
}

function mergeSnapshot(current: RateLimitSnapshot, update: RateLimitSnapshot): RateLimitSnapshot {
  return {
    ...current,
    ...update,
    primary: update.primary ? { ...current.primary, ...update.primary } : current.primary,
    secondary: update.secondary ? { ...current.secondary, ...update.secondary } : current.secondary,
  };
}

function quotaForModel(
  state: RateLimitsState | null,
  model: CodexModel | undefined,
): QuotaView | null {
  if (!state) return null;
  const catalog = Object.values(state.rateLimitsByLimitId ?? {});
  const normalizedModel = `${model?.displayName ?? ""} ${model?.model ?? ""}`.toLowerCase();
  const modelBucket = catalog.find((snapshot) => (
    snapshot.limitName && normalizedModel.includes(snapshot.limitName.toLowerCase())
  ));
  const snapshots = [modelBucket, state.rateLimits, ...catalog].filter(
    (snapshot, index, values): snapshot is RateLimitSnapshot => (
      Boolean(snapshot) && values.indexOf(snapshot) === index
    ),
  );
  for (const snapshot of snapshots) {
    const windows = [snapshot.primary, snapshot.secondary]
      .filter((window): window is RateLimitWindow => Boolean(window))
      .sort((left, right) => (
        (right.windowDurationMins ?? 0) - (left.windowDurationMins ?? 0)
      ));
    const window = windows.find((candidate) => (
      (candidate.windowDurationMins ?? 0) >= WEEK_MINUTES
    )) ?? windows[0];
    if (!window) continue;
    return {
      label: snapshot.limitName || "Codex",
      remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)),
      resetsAt: window.resetsAt ?? null,
      weekly: (window.windowDurationMins ?? 0) >= WEEK_MINUTES,
    };
  }
  return null;
}

function displayPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function resetLabel(timestamp: number | null): string {
  if (!timestamp) return "Reset time unavailable";
  return `Resets ${new Date(timestamp * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function itemRecord(params: Record<string, unknown>): Record<string, unknown> | null {
  const item = params.item;
  return item && typeof item === "object" ? item as Record<string, unknown> : null;
}

export function CodexPanel({
  available,
  workspace,
  notebookPath,
  selectedCell,
  selectionQuote,
  onBeforePrompt,
  onWorkspaceChanged,
  onTurnStarted,
  onTurnFinished,
  onNotebookToolCall,
  onReturnToNotebook,
  onClearSelectionQuote,
}: CodexPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [account, setAccount] = useState<AccountState | null>(null);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [rateLimits, setRateLimits] = useState<RateLimitsState | null>(null);
  const [quotaProblem, setQuotaProblem] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [threadOpen, setThreadOpen] = useState(false);
  const [threadStore, setThreadStore] = useState<WorkspaceThreadStore>({
    workspace: null,
    activeId: null,
    threads: [],
  });
  const [accountRefreshing, setAccountRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("Ready");
  const [includeContext, setIncludeContext] = useState(true);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const bridgeReady = useRef(false);
  const activeAssistant = useRef<string | null>(null);
  const agentMessages = useRef(new Map<string, string>());
  const conversation = useRef<HTMLDivElement>(null);
  const workspaceChanged = useRef(false);
  const streamedActivity = useRef(new Set<string>());
  const modelsRef = useRef<CodexModel[]>([]);
  const modelRef = useRef("");
  const effortRef = useRef("");
  const activeThreadRef = useRef<string | null>(null);
  const boundThreadRef = useRef<string | null>(null);
  const pendingThreadTitle = useRef<string | null>(null);
  const threadToggle = useRef<HTMLButtonElement>(null);
  const threadPopover = useRef<HTMLElement>(null);
  const accountToggle = useRef<HTMLButtonElement>(null);
  const accountPopover = useRef<HTMLElement>(null);
  const callbacks = useRef({ onBeforePrompt, onWorkspaceChanged, onTurnStarted, onTurnFinished, onNotebookToolCall });
  callbacks.current = { onBeforePrompt, onWorkspaceChanged, onTurnStarted, onTurnFinished, onNotebookToolCall };
  activeThreadRef.current = threadStore.activeId;

  useEffect(() => {
    if (!workspace) {
      setThreadStore({ workspace: null, activeId: null, threads: [] });
      activeThreadRef.current = null;
      return;
    }
    const stored = loadThreadStore(workspace);
    activeThreadRef.current = stored.activeId;
    boundThreadRef.current = null;
    setThreadStore(stored);
    setMessages(initialMessages());
  }, [workspace]);

  useEffect(() => {
    if (!workspace || threadStore.workspace !== workspace) return;
    try {
      window.localStorage.setItem(threadStorageKey(workspace), JSON.stringify({
        activeId: threadStore.activeId,
        threads: threadStore.threads,
      }));
    } catch {
      // Thread persistence is optional when browser storage is unavailable.
    }
  }, [threadStore, workspace]);

  useEffect(() => {
    if (!accountOpen && !threadOpen) return;
    function closePopoverWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountOpen(false);
        setThreadOpen(false);
      }
    }
    function closePopoverFromOutside(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (threadOpen
        && !threadToggle.current?.contains(target)
        && !threadPopover.current?.contains(target)) setThreadOpen(false);
      if (accountOpen
        && !accountToggle.current?.contains(target)
        && !accountPopover.current?.contains(target)) setAccountOpen(false);
    }
    window.addEventListener("keydown", closePopoverWithKeyboard);
    window.addEventListener("pointerdown", closePopoverFromOutside);
    return () => {
      window.removeEventListener("keydown", closePopoverWithKeyboard);
      window.removeEventListener("pointerdown", closePopoverFromOutside);
    };
  }, [accountOpen, threadOpen]);

  useEffect(() => {
    if (available === null) {
      setConnection("checking");
      return;
    }
    if (!available) {
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      reconnectAttempt.current = 0;
      bridgeReady.current = false;
      callbacks.current.onTurnFinished();
      setConnection("error");
      setProblem("Codex CLI was not found on PATH.");
      return;
    }

    let disposed = false;
    let receivedReady = false;
    let connectionProblem: string | null = null;
    bridgeReady.current = false;
    setConnection("connecting");
    setStage("Connecting");
    setProblem(null);
    const socket = new WebSocket(websocketUrl("api/codex"));
    socketRef.current = socket;
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type === "ready") receivedReady = true;
        if (!receivedReady && message.type === "error") {
          connectionProblem = String(message.message ?? "The local Codex bridge could not start.");
        }
        handleBridgeMessage(message, socket);
      } catch {
        setProblem("The local Codex bridge sent an invalid message. Reconnecting may help.");
      }
    };
    socket.onerror = () => {
      setStage("Disconnected");
    };
    socket.onclose = () => {
      if (!disposed && socketRef.current === socket) {
        callbacks.current.onTurnFinished();
        socketRef.current = null;
        bridgeReady.current = false;
        boundThreadRef.current = null;
        setConnection("error");
        setStage("Disconnected");
        setBusy(false);
        setApprovals([]);
        const assistantId = activeAssistant.current;
        if (assistantId) {
          setMessages((current) => current.map((message) => message.id === assistantId
            ? { ...message, text: message.text || "Codex disconnected before completing the response.", pending: false }
            : message));
          activeAssistant.current = null;
        }
        agentMessages.current.clear();

        const attempt = reconnectAttempt.current;
        const delay = RECONNECT_DELAYS_MS[attempt];
        if (delay === undefined) {
          setProblem(`${connectionProblem ?? "The local Codex bridge disconnected."} Automatic retries stopped.`);
          return;
        }
        reconnectAttempt.current += 1;
        const seconds = delay < 1_000 ? `${delay} ms` : `${delay / 1_000} s`;
        setProblem(`${connectionProblem ?? "The local Codex bridge disconnected."} Retrying in ${seconds}…`);
        reconnectTimer.current = window.setTimeout(() => {
          reconnectTimer.current = null;
          if (!disposed) setReconnectGeneration((value) => value + 1);
        }, delay);
      }
    };
    return () => {
      disposed = true;
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      callbacks.current.onTurnFinished();
      if (socketRef.current === socket) socketRef.current = null;
      bridgeReady.current = false;
      boundThreadRef.current = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    };
  }, [available, reconnectGeneration]);

  useEffect(() => {
    const element = conversation.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, approvals]);

  function setModelSelection(value: string, catalog = models, preferredEffort?: string | null) {
    const model = catalog.find((item) => modelValue(item) === value);
    if (!model) return;
    const efforts = modelEfforts(model);
    const nextEffort = (
      preferredEffort && efforts.includes(preferredEffort)
        ? preferredEffort
        : efforts.includes("medium")
          ? "medium"
          : efforts.includes(model.defaultReasoningEffort)
            ? model.defaultReasoningEffort
            : efforts[0] ?? ""
    );
    modelRef.current = value;
    effortRef.current = nextEffort;
    setSelectedModel(value);
    setSelectedEffort(nextEffort);
    storeValue(MODEL_STORAGE, value);
    if (nextEffort) storeValue(EFFORT_STORAGE, nextEffort);
  }

  function applyCatalog(catalog: CodexModel[], defaults: { model?: unknown; effort?: unknown }) {
    modelsRef.current = catalog;
    setModels(catalog);
    const requested = modelRef.current || storedValue(MODEL_STORAGE);
    const fallback = typeof defaults.model === "string" ? defaults.model : modelValue(catalog[0]);
    const model = catalog.find((item) => modelValue(item) === requested)
      ?? catalog.find((item) => modelValue(item) === fallback)
      ?? catalog[0];
    if (!model) {
      modelRef.current = "";
      effortRef.current = "";
      setSelectedModel("");
      setSelectedEffort("");
      return;
    }
    const requestedEffort = effortRef.current
      || storedValue(EFFORT_STORAGE)
      || (typeof defaults.effort === "string" ? defaults.effort : null);
    setModelSelection(modelValue(model), catalog, requestedEffort);
  }

  function addAssistantError(text: string) {
    setMessages((current) => [...current, {
      id: crypto.randomUUID(),
      role: "assistant",
      text,
    }]);
  }

  function updateThreadStore(
    updater: (current: WorkspaceThreadStore) => WorkspaceThreadStore,
  ) {
    setThreadStore((current) => {
      if (current.workspace !== workspace) return current;
      const next = updater(current);
      activeThreadRef.current = next.activeId;
      return next;
    });
  }

  function upsertThread(threadId: string, title?: string, updatedAt = Date.now()) {
    updateThreadStore((current) => {
      const existing = current.threads.find((thread) => thread.id === threadId);
      const entry: StoredThread = {
        id: threadId,
        title: title?.trim() || existing?.title || "Untitled thread",
        updatedAt,
      };
      return {
        ...current,
        activeId: threadId,
        threads: [entry, ...current.threads.filter((thread) => thread.id !== threadId)]
          .slice(0, MAX_STORED_THREADS),
      };
    });
  }

  function beginAssistantItem(itemId: string): string {
    const existing = agentMessages.current.get(itemId);
    if (existing) return existing;
    let messageId = activeAssistant.current;
    if (!messageId) {
      messageId = crypto.randomUUID();
      setMessages((current) => [...current, {
        id: messageId!,
        role: "assistant",
        text: "",
        pending: true,
      }]);
    }
    activeAssistant.current = messageId;
    agentMessages.current.set(itemId, messageId);
    return messageId;
  }

  function appendAssistantDelta(itemId: string, delta: string) {
    const messageId = beginAssistantItem(itemId);
    setMessages((current) => current.map((message) => message.id === messageId
      ? { ...message, text: message.text + delta }
      : message));
  }

  function completeAssistantItem(itemId: string, text: string | null) {
    const messageId = agentMessages.current.get(itemId) ?? beginAssistantItem(itemId);
    setMessages((current) => current.map((message) => message.id === messageId
      ? { ...message, text: message.text || text || "", pending: false }
      : message));
    agentMessages.current.delete(itemId);
    if (activeAssistant.current === messageId) activeAssistant.current = null;
  }

  function appendActivity(itemId: string, delta: string) {
    const id = `activity-${itemId}`;
    const pendingAssistant = activeAssistant.current;
    setMessages((current) => {
      const found = current.some((message) => message.id === id);
      if (!found) {
        const activity: Message = { id, role: "activity", text: delta };
        const pendingIndex = current.findIndex((message) => (
          message.id === pendingAssistant
          && message.role === "assistant"
          && message.pending
          && !message.text
        ));
        if (pendingIndex >= 0) {
          return [
            ...current.slice(0, pendingIndex),
            activity,
            ...current.slice(pendingIndex),
          ];
        }
        return [...current, activity];
      }
      return current.map((message) => message.id === id
        ? { ...message, text: `${message.text}${delta}`.slice(-12_000) }
        : message);
    });
  }

  function noteStartedItem(params: Record<string, unknown>) {
    const item = itemRecord(params);
    if (!item) return;
    const type = item.type;
    const id = String(item.id ?? "tool");
    if (type === "agentMessage") {
      beginAssistantItem(id);
    } else if (type === "commandExecution") {
      setStage("Running command");
      const command = typeof item.command === "string" ? item.command : "Command started";
      appendActivity(id, `$ ${command}\n`);
    } else if (type === "fileChange") {
      setStage("Editing workspace");
      workspaceChanged.current = true;
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((change) => change && typeof change === "object" && "path" in change
          ? String((change as { path: unknown }).path)
          : null)
        .filter(Boolean);
      appendActivity(id, paths.length ? `Editing ${paths.join(", ")}\n` : "Editing workspace files\n");
    }
  }

  function noteCompletedItem(params: Record<string, unknown>) {
    const item = itemRecord(params);
    if (!item) return;
    const type = item.type;
    const id = String(item.id ?? "tool");
    if (type === "agentMessage") {
      completeAssistantItem(id, typeof item.text === "string" ? item.text : null);
    } else if (type === "commandExecution") {
      const status = String(item.status ?? "completed");
      const output = !streamedActivity.current.has(id) && typeof item.aggregatedOutput === "string"
        ? item.aggregatedOutput
        : "";
      streamedActivity.current.delete(id);
      appendActivity(
        id,
        `${output ? `${output}${output.endsWith("\n") ? "" : "\n"}` : ""}${status === "completed" ? "✓" : "·"} ${status}\n`,
      );
      setStage("Thinking");
    } else if (type === "fileChange") {
      const status = String(item.status ?? "completed");
      if (status === "completed") workspaceChanged.current = true;
      appendActivity(id, `${status === "completed" ? "✓ Changes applied" : `· ${status}`}\n`);
      setStage("Thinking");
    }
  }

  function finishTurn(params: Record<string, unknown>) {
    const turn = params.turn as { status?: string; error?: unknown } | undefined;
    const status = turn?.status ?? "completed";
    const emptyText = status === "interrupted" ? "(Stopped.)" : status === "failed" ? "(Failed.)" : "(Done.)";
    setMessages((current) => current.map((message) => message.role === "assistant" && message.pending
      ? { ...message, text: message.text || emptyText, pending: false }
      : message));
    if (status === "failed") addAssistantError(errorDetail(turn?.error));
    activeAssistant.current = null;
    agentMessages.current.clear();
    setBusy(false);
    setStage(status === "interrupted" ? "Stopped" : status === "failed" ? "Failed" : "Ready");
    setApprovals([]);
    callbacks.current.onTurnFinished();
    if (workspaceChanged.current) {
      workspaceChanged.current = false;
      callbacks.current.onWorkspaceChanged();
    }
  }

  function handleCodexEvent(event: CodexEvent) {
    const method = event.method;
    const params = event.params ?? {};
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      setStage("Responding");
      appendAssistantDelta(String(params.itemId ?? "agent"), params.delta);
      return;
    }
    if (method === "item/started") {
      noteStartedItem(params);
      return;
    }
    if (method === "item/completed") {
      noteCompletedItem(params);
      return;
    }
    if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
      const itemId = String(params.itemId ?? "tool");
      streamedActivity.current.add(itemId);
      appendActivity(itemId, params.delta);
      return;
    }
    if (method === "item/fileChange/outputDelta" || method === "item/fileChange/patchUpdated") {
      workspaceChanged.current = true;
      setStage("Editing workspace");
      if (typeof params.delta === "string") {
        appendActivity(String(params.itemId ?? "tool"), params.delta);
      }
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      if (event.id === undefined) return;
      const command = typeof params.command === "string" ? params.command : "Workspace file changes";
      const reason = typeof params.reason === "string" ? params.reason : "Codex needs your approval to continue.";
      const advertised = Array.isArray(params.availableDecisions)
        ? params.availableDecisions.filter((decision): decision is string => typeof decision === "string")
        : [];
      setStage("Waiting for approval");
      setApprovals((current) => [...current.filter((item) => item.requestId !== event.id), {
        requestId: event.id!,
        method,
        title: method.includes("commandExecution") ? "Run command?" : "Apply file changes?",
        detail: `${command}\n${reason}`,
        decisions: advertised.length ? advertised : ["accept", "acceptForSession", "decline"],
      }]);
      return;
    }
    if (method === "serverRequest/resolved") {
      setApprovals((current) => current.filter((item) => item.requestId !== params.requestId));
      setStage("Thinking");
      return;
    }
    if (method === "account/rateLimits/updated") {
      const update = params.rateLimits as RateLimitSnapshot | undefined;
      if (update) {
        setRateLimits((current) => {
          if (!current) return { rateLimits: update };
          const id = update.limitId ?? current.rateLimits.limitId;
          const map = { ...(current.rateLimitsByLimitId ?? {}) };
          if (id) map[id] = mergeSnapshot(map[id] ?? {}, update);
          return {
            ...current,
            rateLimits: !update.limitId || update.limitId === current.rateLimits.limitId
              ? mergeSnapshot(current.rateLimits, update)
              : current.rateLimits,
            rateLimitsByLimitId: map,
          };
        });
      }
      return;
    }
    if (method === "model/rerouted" && typeof params.toModel === "string") {
      const catalog = modelsRef.current;
      if (catalog.some((model) => modelValue(model) === params.toModel)) {
        setModelSelection(params.toModel, catalog, effortRef.current);
      }
      return;
    }
    if (method === "error") {
      const willRetry = params.willRetry === true;
      setStage(willRetry ? "Retrying" : "Working");
      if (!willRetry) setProblem(errorDetail(params.error));
      return;
    }
    if (method === "turn/completed") finishTurn(params);
  }

  async function answerNotebookTool(
    message: Record<string, unknown>,
    socket: WebSocket,
  ) {
    const requestId = message.requestId;
    const tool = message.tool;
    if ((typeof requestId !== "string" && typeof requestId !== "number") || typeof tool !== "string") {
      setProblem("The Codex bridge sent an invalid notebook tool request.");
      return;
    }
    const activityId = `notebook-tool-${String(message.callId ?? requestId)}`;
    const locking = tool === NOTEBOOK_LOCK_TOOL;
    const proposing = tool === NOTEBOOK_PROPOSE_TOOL;
    const editing = tool === NOTEBOOK_APPLY_TOOL;
    setStage(locking ? "Protecting cells" : proposing ? "Drafting cell" : editing ? "Editing notebook" : "Reading notebook");
    appendActivity(
      activityId,
      locking
        ? "Updating turn-scoped cell locks…\n"
        : proposing
          ? "Staging a cell proposal through Zbook…\n"
        : editing
          ? "Applying cell changes through Zbook…\n"
          : "Reading cells through Zbook…\n",
    );

    let response: NotebookToolResponse;
    try {
      response = await callbacks.current.onNotebookToolCall(tool, message.arguments, {
        callId: typeof message.callId === "string" ? message.callId : null,
        threadId: typeof message.threadId === "string" ? message.threadId : null,
        turnId: typeof message.turnId === "string" ? message.turnId : null,
      });
    } catch (error) {
      response = { success: false, result: { error: String(error) } };
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "notebookToolResult",
        requestId,
        success: response.success,
        result: response.result,
      }));
    }
    appendActivity(
      activityId,
      response.success ? "✓ Zbook notebook tool completed\n" : "· Zbook notebook tool rejected the change\n",
    );
    setStage("Thinking");
  }

  function handleBridgeMessage(message: Record<string, unknown>, socket: WebSocket) {
    if (message.type === "notebookToolCall") {
      void answerNotebookTool(message, socket);
      return;
    }
    if (message.type === "ready") {
      bridgeReady.current = true;
      reconnectAttempt.current = 0;
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      const nextAccount = message.account as AccountState;
      setAccount(nextAccount);
      const catalog = Array.isArray(message.models)
        ? message.models as CodexModel[]
        : modelsRef.current;
      const defaults = message.defaults && typeof message.defaults === "object"
        ? message.defaults as { model?: unknown; effort?: unknown }
        : {};
      if (catalog.length) applyCatalog(catalog, defaults);
      const modelError = typeof message.modelError === "string" && !catalog.length
        ? message.modelError
        : null;
      setConnection("ready");
      setStage("Ready");
      setProblem(modelError);
      if (nextAccount?.account) setLoginUrl(null);
      const storedThread = activeThreadRef.current;
      const authenticated = !nextAccount?.requiresOpenaiAuth || Boolean(nextAccount?.account);
      if (!authenticated) boundThreadRef.current = null;
      if (authenticated && storedThread && boundThreadRef.current !== storedThread) {
        setBusy(true);
        setStage("Restoring thread");
        socket.send(JSON.stringify({
          type: "resumeThread",
          threadId: storedThread,
          model: modelRef.current || null,
        }));
      }
      return;
    }
    if (message.type === "thread") {
      const threadId = typeof message.threadId === "string" ? message.threadId : null;
      boundThreadRef.current = threadId;
      if (threadId) {
        upsertThread(threadId, pendingThreadTitle.current ?? undefined);
        pendingThreadTitle.current = null;
      }
      return;
    }
    if (message.type === "threadRestored") {
      const threadId = typeof message.threadId === "string" ? message.threadId : null;
      if (!threadId) return;
      const history = Array.isArray(message.messages)
        ? message.messages.flatMap((item): Message[] => {
          if (!item || typeof item !== "object") return [];
          const record = item as Record<string, unknown>;
          if ((record.role !== "user" && record.role !== "assistant" && record.role !== "activity")
            || typeof record.text !== "string") return [];
          return [{
            id: typeof record.id === "string" ? record.id : crypto.randomUUID(),
            role: record.role,
            text: record.text,
          }];
        })
        : [];
      const thread = message.thread && typeof message.thread === "object"
        ? message.thread as Record<string, unknown>
        : {};
      const title = typeof thread.name === "string" && thread.name.trim()
        ? thread.name
        : typeof thread.preview === "string" && thread.preview.trim()
          ? titleFromPrompt(thread.preview)
          : undefined;
      boundThreadRef.current = threadId;
      upsertThread(threadId, title);
      setMessages(history.length ? history : initialMessages());
      setBusy(false);
      setStage("Ready");
      setProblem(null);
      setThreadOpen(false);
      return;
    }
    if (message.type === "threadUnavailable") {
      callbacks.current.onTurnFinished();
      const threadId = typeof message.threadId === "string" ? message.threadId : null;
      if (threadId) {
        updateThreadStore((current) => ({
          ...current,
          activeId: current.activeId === threadId ? null : current.activeId,
          threads: current.threads.filter((thread) => thread.id !== threadId),
        }));
      }
      boundThreadRef.current = null;
      setMessages(initialMessages());
      setBusy(false);
      setStage("Ready");
      setProblem(`That saved Codex thread is no longer available. ${String(message.message ?? "")}`.trim());
      return;
    }
    if (message.type === "rateLimits") {
      setRateLimits((message.rateLimits as RateLimitsState | null) ?? null);
      setQuotaProblem(typeof message.error === "string" ? message.error : null);
      setAccountRefreshing(false);
      return;
    }
    if (message.type === "settings") {
      const catalog = modelsRef.current;
      const model = typeof message.model === "string" ? message.model : modelRef.current;
      if (catalog.some((item) => modelValue(item) === model)) {
        setModelSelection(model, catalog, typeof message.effort === "string" ? message.effort : effortRef.current);
      }
      return;
    }
    if (message.type === "codex") {
      handleCodexEvent(message.message as CodexEvent);
      return;
    }
    if (message.type === "approvalResolved") {
      setApprovals((current) => current.filter((item) => item.requestId !== message.requestId));
      setStage("Thinking");
      return;
    }
    if (message.type === "turn") {
      const catalog = modelsRef.current;
      if (typeof message.model === "string" && catalog.some((item) => modelValue(item) === message.model)) {
        setModelSelection(message.model, catalog, typeof message.effort === "string" ? message.effort : effortRef.current);
      }
      setStage("Thinking");
      return;
    }
    if (message.type === "login") {
      const result = message.result as { authUrl?: string; verificationUrl?: string };
      setLoginUrl(result.authUrl ?? result.verificationUrl ?? null);
      setStage("Waiting for sign-in");
      return;
    }
    if (message.type === "error") {
      callbacks.current.onTurnFinished();
      const detail = String(message.message ?? "Unknown Codex bridge error");
      setProblem(detail);
      setStage("Failed");
      setAccountRefreshing(false);
      if (!bridgeReady.current) {
        setBusy(false);
        setApprovals([]);
        return;
      }
      const assistantId = activeAssistant.current;
      if (assistantId) {
        socketRef.current?.send(JSON.stringify({ type: "interrupt" }));
        setMessages((current) => current.map((entry) => entry.id === assistantId
          ? { ...entry, text: entry.text || detail, pending: false }
          : entry));
        activeAssistant.current = null;
      } else {
        addAssistantError(detail);
      }
      agentMessages.current.clear();
      setBusy(false);
      setApprovals([]);
      if (workspaceChanged.current) {
        workspaceChanged.current = false;
        callbacks.current.onWorkspaceChanged();
      }
    }
  }

  async function sendPrompt(value: string) {
    const clean = value.trim();
    const socket = socketRef.current;
    if (!clean || !socket || socket.readyState !== WebSocket.OPEN || busy) return;
    setBusy(true);
    setStage("Saving context");
    if (!(await callbacks.current.onBeforePrompt())) {
      setBusy(false);
      setStage("Ready");
      return;
    }
    callbacks.current.onTurnStarted();
    const assistantId = crypto.randomUUID();
    if (!activeThreadRef.current) pendingThreadTitle.current = titleFromPrompt(clean);
    else upsertThread(activeThreadRef.current);
    activeAssistant.current = assistantId;
    agentMessages.current.clear();
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", text: clean },
      { id: assistantId, role: "assistant", text: "", pending: true },
    ]);
    setStage("Starting");
    socket.send(JSON.stringify({
      type: "prompt",
      prompt: clean,
      model: modelRef.current || null,
      effort: effortRef.current || null,
      context: includeContext || selectionQuote ? {
        ...(includeContext ? {
          notebook: notebookPath,
          cellKind: selectedCell?.kind,
          cellId: selectedCell?.id,
        } : {}),
        ...(selectionQuote ? { selection: selectionQuote } : {}),
      } : null,
    }));
    setPrompt("");
    if (selectionQuote) onClearSelectionQuote();
    setProblem(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void sendPrompt(prompt);
  }

  function respondApproval(requestId: string | number, decision: string) {
    if (decision === "accept" || decision === "acceptForSession") workspaceChanged.current = true;
    setStage("Applying decision");
    socketRef.current?.send(JSON.stringify({ type: "approval", requestId, decision }));
  }

  function newThread() {
    callbacks.current.onTurnFinished();
    socketRef.current?.send(JSON.stringify({ type: "newThread" }));
    activeAssistant.current = null;
    agentMessages.current.clear();
    setBusy(false);
    setStage("Ready");
    setApprovals([]);
    streamedActivity.current.clear();
    boundThreadRef.current = null;
    pendingThreadTitle.current = null;
    updateThreadStore((current) => ({ ...current, activeId: null }));
    setThreadOpen(false);
    setMessages(initialMessages());
  }

  function resumeThread(threadId: string) {
    const socket = socketRef.current;
    if (busy || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (boundThreadRef.current === threadId) {
      setThreadOpen(false);
      return;
    }
    callbacks.current.onTurnFinished();
    updateThreadStore((current) => ({ ...current, activeId: threadId }));
    boundThreadRef.current = null;
    activeAssistant.current = null;
    agentMessages.current.clear();
    streamedActivity.current.clear();
    setApprovals([]);
    setMessages([]);
    setBusy(true);
    setStage("Restoring thread");
    setProblem(null);
    socket.send(JSON.stringify({
      type: "resumeThread",
      threadId,
      model: modelRef.current || null,
    }));
  }

  function forgetThread(threadId: string) {
    const wasActive = activeThreadRef.current === threadId;
    updateThreadStore((current) => ({
      ...current,
      activeId: wasActive ? null : current.activeId,
      threads: current.threads.filter((thread) => thread.id !== threadId),
    }));
    if (wasActive) newThread();
  }

  function refreshAccount() {
    setAccountRefreshing(true);
    socketRef.current?.send(JSON.stringify({ type: "refreshAccount" }));
  }

  function retryConnection() {
    if (!available) return;
    reconnectAttempt.current = 0;
    if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
    setConnection("connecting");
    setStage("Connecting");
    setProblem(null);
    setReconnectGeneration((value) => value + 1);
  }

  function logout() {
    if (!window.confirm("Sign out of the Codex CLI on this machine?")) return;
    setAccountRefreshing(true);
    callbacks.current.onTurnFinished();
    setAccountOpen(false);
    boundThreadRef.current = null;
    socketRef.current?.send(JSON.stringify({ type: "logout" }));
  }

  const signedIn = !account?.requiresOpenaiAuth || Boolean(account.account);
  const ready = connection === "ready" && signedIn;
  const currentModel = models.find((model) => modelValue(model) === selectedModel);
  const efforts = modelEfforts(currentModel);
  const quota = quotaForModel(rateLimits, currentModel);
  const accountLabel = account?.account?.type === "chatgpt"
    ? account.account.planType ?? "ChatGPT"
    : account?.account?.type ?? null;
  const accountName = account?.account?.email || (accountLabel ? `${accountLabel} account` : "Codex account");
  const cellLabel = selectedCell ? `${selectedCell.kind} cell` : null;
  const quotaPercent = quota ? displayPercent(quota.remaining) : "—";
  const resetCredits = rateLimits?.rateLimitResetCredits?.availableCount ?? 0;
  const currentThread = threadStore.threads.find((thread) => thread.id === threadStore.activeId);
  const compactModel = (currentModel?.displayName || selectedModel || "Model")
    .replace(/^gpt[- ]?5(?:\.\d+)?[- ]?/i, "")
    .trim();

  return (
    <aside className="codex-panel" aria-label="Codex assistant">
      <div className="codex-heading">
        <span className="codex-brand">
          <SparkIcon />CODEX
          <i
            className={`connection-dot ${ready ? "is-ready" : ""}`}
            title={connection === "checking" ? "Checking Codex" : connection === "connecting" ? "Connecting to Codex" : ready ? `${accountLabel ?? "Codex"} connected` : "Codex needs attention"}
          />
          <span className="sr-only" role="status" aria-live="polite">
            {connection === "checking" ? "Checking Codex" : connection === "connecting" ? "Connecting to Codex" : ready ? "Codex connected" : "Codex needs attention"}
          </span>
        </span>
        <div className="codex-heading-actions">
          <button
            ref={threadToggle}
            className={`thread-summary ${threadOpen ? "is-open" : ""}`}
            onClick={() => {
              setThreadOpen((value) => !value);
              setAccountOpen(false);
            }}
            disabled={connection !== "ready"}
            aria-expanded={threadOpen}
            aria-haspopup="dialog"
            aria-label={`Codex threads${currentThread ? `, current: ${currentThread.title}` : ""}`}
            title={currentThread?.title ?? "Codex thread history"}
          ><HistoryIcon /><span>{threadStore.threads.length || ""}</span></button>
          <button
            ref={accountToggle}
            className={`codex-session-summary ${accountOpen ? "is-open" : ""}`}
            onClick={() => {
              setAccountOpen((value) => !value);
              setThreadOpen(false);
            }}
            disabled={connection !== "ready"}
            aria-expanded={accountOpen}
            aria-haspopup="dialog"
            title="Model, reasoning, account, and quota"
          >
            <span>{compactModel || "Model"}</span>
            <em>{selectedEffort ? selectedEffort.slice(0, 1).toUpperCase() : "–"}</em>
            <strong>{quotaPercent}</strong>
            <ChevronIcon />
          </button>
        </div>
      </div>
      {threadOpen && (
        <section ref={threadPopover} className="codex-thread-popover" role="dialog" aria-label="Zbook Codex threads">
          <header>
            <div><strong>Threads</strong><span>This workspace</span></div>
            <button type="button" onClick={newThread} disabled={busy}><span>+</span> New</button>
          </header>
          <div className="thread-list">
            {threadStore.threads.length ? threadStore.threads.map((thread) => (
              <div className={`thread-row ${thread.id === threadStore.activeId ? "is-active" : ""}`} key={thread.id}>
                <button type="button" onClick={() => resumeThread(thread.id)} disabled={busy}>
                  <span>{thread.title}</span><em>{threadTime(thread.updatedAt)}</em>
                </button>
                <button
                  type="button"
                  className="thread-forget"
                  onClick={() => forgetThread(thread.id)}
                  disabled={busy}
                  aria-label={`Forget ${thread.title}`}
                  title="Remove from Zbook history"
                ><CloseIcon /></button>
              </div>
            )) : <p>No saved Zbook threads yet.</p>}
          </div>
          <footer>Only sessions started from Zbook appear here.</footer>
        </section>
      )}
      {accountOpen && (
        <section ref={accountPopover} className="codex-account-popover" role="dialog" aria-label="Codex settings and account">
          <header>
            <div><i>{account?.account?.type === "chatgpt" ? "C" : "A"}</i><span><strong>{accountName}</strong><em>{accountLabel ? `${accountLabel} plan · local CLI` : "Local Codex CLI"}</em></span></div>
            <button onClick={() => setAccountOpen(false)} aria-label="Close account details"><CloseIcon /></button>
          </header>
          <div className="codex-settings-fields">
            <label title={currentModel?.description}>
              <span>Model</span>
              <select
                aria-label="Codex model"
                value={selectedModel}
                onChange={(event) => setModelSelection(event.target.value, models, effortRef.current)}
                disabled={!ready || busy || models.length === 0}
              >
                {models.map((model) => <option value={modelValue(model)} key={model.id}>{model.displayName}</option>)}
              </select>
            </label>
            <label>
              <span>Reasoning</span>
              <select
                aria-label="Codex reasoning effort"
                value={selectedEffort}
                onChange={(event) => {
                  effortRef.current = event.target.value;
                  setSelectedEffort(event.target.value);
                  storeValue(EFFORT_STORAGE, event.target.value);
                }}
                disabled={!ready || busy || efforts.length === 0}
              >
                {efforts.map((effort) => <option value={effort} key={effort}>{effort}</option>)}
              </select>
            </label>
          </div>
          {signedIn ? (
            <>
              <div className="quota-detail">
                <div><span>{quota?.weekly ? "Weekly remaining" : "Quota remaining"}</span><strong>{quotaPercent}</strong></div>
                <div className="quota-track"><i style={{ width: quota ? `${quota.remaining}%` : "0%" }} /></div>
                <p>{quota
                  ? `${quota.label} · ${resetLabel(quota.resetsAt)}${resetCredits ? ` · ${resetCredits} reset credit${resetCredits === 1 ? "" : "s"}` : ""}`
                  : quotaProblem ?? "Quota data is unavailable for this account."}</p>
              </div>
              <div className="account-actions">
                <button onClick={refreshAccount} disabled={accountRefreshing}><RefreshIcon />{accountRefreshing ? "Refreshing" : "Refresh"}</button>
                {account?.account && <button onClick={logout} disabled={busy || accountRefreshing}>Sign out</button>}
              </div>
            </>
          ) : (
            <div className="account-signin">
              <p>Use your ChatGPT subscription through the local Codex CLI.</p>
              <button onClick={() => socketRef.current?.send(JSON.stringify({ type: "login" }))}>Sign in with ChatGPT</button>
              {loginUrl && <a href={loginUrl} target="_blank" rel="noreferrer">Continue sign-in ↗</a>}
            </div>
          )}
        </section>
      )}
      <div className="context-strip">
        <span>Context</span>
        {notebookPath && <button title={notebookPath}>{notebookPath.split("/").at(-1)}</button>}
        {cellLabel && <button>{cellLabel}</button>}
        {!notebookPath && <em>workspace</em>}
      </div>
      <div className="conversation" ref={conversation}>
        {!signedIn && connection === "ready" && (
          <div className="codex-auth-card">
            <strong>Use your Codex subscription</strong>
            <p>Sign in through the local Codex CLI. No API key is sent to Zbook.</p>
            <button onClick={() => socketRef.current?.send(JSON.stringify({ type: "login" }))}>Sign in with ChatGPT</button>
            {loginUrl && <a href={loginUrl} target="_blank" rel="noreferrer">Continue sign-in ↗</a>}
          </div>
        )}
        {messages.map((message) => (
          <div className={`message message-${message.role}`} key={message.id}>
            <span>{message.role === "assistant" ? "CODEX" : message.role === "user" ? "YOU" : "ACTIVITY"}</span>
            {message.role === "assistant" ? <ReactMarkdown>{message.text}</ReactMarkdown> : <pre>{message.text}</pre>}
            {message.pending && !message.text && <i className="codex-thinking" />}
            {message.welcome && (
              <div className="suggestions">
                <button disabled={!ready || busy} onClick={() => void sendPrompt("Explain the selected cell")}>Explain this cell</button>
                <button disabled={!ready || busy} onClick={() => void sendPrompt("Find the error in the selected cell")}>Find the error</button>
                <button disabled={!ready || busy} onClick={() => void sendPrompt("Suggest the next notebook cell")}>Write the next cell</button>
              </div>
            )}
          </div>
        ))}
        {approvals.map((approval) => (
          <div className="approval-card" key={approval.requestId}>
            <strong>{approval.title}</strong>
            <pre>{approval.detail}</pre>
            <div>
              {approval.decisions.includes("decline") && <button onClick={() => respondApproval(approval.requestId, "decline")}>Deny</button>}
              {approval.decisions.includes("acceptForSession") && <button onClick={() => respondApproval(approval.requestId, "acceptForSession")}>Allow session</button>}
              {approval.decisions.includes("accept") && <button className="approval-primary" onClick={() => respondApproval(approval.requestId, "accept")}>Allow</button>}
            </div>
          </div>
        ))}
        {problem && (
          <div className="codex-problem" role="alert">
            <span>{problem}</span>
            <div>
              {connection === "error" && available && (
                <button type="button" onClick={retryConnection}>Retry now</button>
              )}
              <button type="button" onClick={() => setProblem(null)} aria-label="Dismiss Codex notice">Dismiss</button>
            </div>
          </div>
        )}
      </div>
      {busy && (
        <div
          className="codex-working-indicator"
          role="status"
          aria-live="polite"
          aria-label={`Codex is working: ${stage}`}
        >
          <strong>Working<span className="codex-working-dots" aria-hidden="true" /></strong>
          <em>{stage === "Working" ? "" : stage}</em>
        </div>
      )}
      <form className="prompt-box" onSubmit={submit}>
        {selectionQuote && (
          <section className="prompt-selection-quote" aria-label="Quoted notebook selection">
            <header>
              <span>
                <SparkIcon />
                <strong>{selectionLineLabel(selectionQuote)}</strong>
                <em>{selectionQuote.notebookPath.split("/").at(-1)} · {selectionQuote.cellKind}</em>
              </span>
              <button
                type="button"
                onClick={onClearSelectionQuote}
                disabled={busy}
                aria-label="Remove quoted selection"
                title="Remove quoted selection"
              ><CloseIcon /></button>
            </header>
            <pre title="Compact preview; the full selection will be sent to Codex">
              {selectionPreview(selectionQuote.text)}
            </pre>
          </section>
        )}
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              if (accountOpen || threadOpen) return;
              event.preventDefault();
              onReturnToNotebook();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={ready ? "Ask about or change this notebook…" : "Connect Codex to start…"}
          aria-label="Message Codex"
          rows={3}
          disabled={!ready || busy}
        />
        <div className="prompt-actions">
          <button type="button" className={`context-button ${includeContext ? "is-active" : ""}`} onClick={() => setIncludeContext((value) => !value)} aria-pressed={includeContext}>@ context</button>
          <span className={busy ? "is-busy" : ""}>{busy ? "stop to interrupt" : "↵ send · ⇧↵ newline"}</span>
          {busy ? (
            <button type="button" className="send-button stop-codex" onClick={() => { setStage("Stopping"); socketRef.current?.send(JSON.stringify({ type: "interrupt" })); }} aria-label="Stop Codex" title="Stop Codex"><StopIcon /></button>
          ) : (
            <button type="submit" className="send-button" disabled={!prompt.trim() || !ready} aria-label="Send to Codex"><span aria-hidden="true">↑</span></button>
          )}
        </div>
      </form>
    </aside>
  );
}
