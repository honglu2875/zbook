import { FormEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { NotebookCell } from "../model/notebook";
import { websocketUrl } from "../services/http";
import { SparkIcon, StopIcon } from "./icons";

type MessageRole = "user" | "assistant" | "activity";

interface Message {
  id: string;
  role: MessageRole;
  text: string;
  pending?: boolean;
}

interface Approval {
  requestId: string | number;
  method: string;
  title: string;
  detail: string;
}

interface AccountState {
  account?: { type: string; email?: string | null; planType?: string } | null;
  requiresOpenaiAuth: boolean;
}

interface CodexEvent {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

interface CodexPanelProps {
  available: boolean | null;
  notebookPath: string | null;
  selectedCell: NotebookCell | null;
  onBeforePrompt: () => Promise<boolean>;
  onWorkspaceChanged: () => void;
}

function initialMessages(): Message[] {
  return [{
    id: crypto.randomUUID(),
    role: "assistant",
    text: "I can work in this workspace and use the open notebook or selected cell as context.",
  }];
}

function errorDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    return String((value as { message: unknown }).message);
  }
  return value ? JSON.stringify(value) : "The Codex turn did not complete.";
}

export function CodexPanel({
  available,
  notebookPath,
  selectedCell,
  onBeforePrompt,
  onWorkspaceChanged,
}: CodexPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [connection, setConnection] = useState<"checking" | "connecting" | "ready" | "error">("checking");
  const [account, setAccount] = useState<AccountState | null>(null);
  const [busy, setBusy] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeAssistant = useRef<string | null>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const workspaceChanged = useRef(false);
  const callbacks = useRef({ onBeforePrompt, onWorkspaceChanged });
  callbacks.current = { onBeforePrompt, onWorkspaceChanged };

  useEffect(() => {
    if (available === null) {
      setConnection("checking");
      return;
    }
    if (!available) {
      setConnection("error");
      setProblem("Codex CLI was not found on PATH.");
      return;
    }

    setConnection("connecting");
    const socket = new WebSocket(websocketUrl("api/codex"));
    socketRef.current = socket;
    socket.onmessage = (event) => handleBridgeMessage(JSON.parse(event.data) as Record<string, unknown>);
    socket.onerror = () => {
      setConnection("error");
      setProblem("The local Codex bridge could not connect.");
      setBusy(false);
      setApprovals([]);
    };
    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
        setConnection("error");
        setBusy(false);
        setApprovals([]);
        const assistantId = activeAssistant.current;
        if (assistantId) {
          setMessages((current) => current.map((message) => message.id === assistantId
            ? { ...message, text: message.text || "Codex disconnected before completing the response.", pending: false }
            : message));
          activeAssistant.current = null;
        }
      }
    };
    return () => {
      if (socketRef.current === socket) socketRef.current = null;
      socket.close();
    };
  }, [available]);

  useEffect(() => {
    const element = conversation.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, approvals]);

  function addAssistantError(text: string) {
    setMessages((current) => [...current, {
      id: crypto.randomUUID(),
      role: "assistant",
      text,
    }]);
  }

  function appendAssistantDelta(delta: string) {
    let id = activeAssistant.current;
    if (!id) {
      id = crypto.randomUUID();
      activeAssistant.current = id;
      setMessages((current) => [...current, { id: id!, role: "assistant", text: delta, pending: true }]);
      return;
    }
    setMessages((current) => current.map((message) => message.id === id
      ? { ...message, text: message.text + delta }
      : message));
  }

  function appendActivity(itemId: string, delta: string) {
    const id = `activity-${itemId}`;
    setMessages((current) => {
      const found = current.some((message) => message.id === id);
      if (!found) return [...current, { id, role: "activity", text: delta }];
      return current.map((message) => message.id === id
        ? { ...message, text: `${message.text}${delta}`.slice(-12_000) }
        : message);
    });
  }

  function handleCodexEvent(event: CodexEvent) {
    const method = event.method;
    const params = event.params ?? {};
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      appendAssistantDelta(params.delta);
      return;
    }
    if ((method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta")
      && typeof params.delta === "string") {
      if (method === "item/fileChange/outputDelta") workspaceChanged.current = true;
      appendActivity(String(params.itemId ?? "tool"), params.delta);
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      if (event.id === undefined) return;
      const command = typeof params.command === "string" ? params.command : "Workspace file changes";
      const reason = typeof params.reason === "string" ? params.reason : "Codex needs your approval to continue.";
      setApprovals((current) => [...current, {
        requestId: event.id!,
        method,
        title: method.includes("commandExecution") ? "Run command?" : "Apply file changes?",
        detail: `${command}\n${reason}`,
      }]);
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn as { status?: string; error?: unknown } | undefined;
      const assistantId = activeAssistant.current;
      if (assistantId) {
        setMessages((current) => current.map((message) => message.id === assistantId
          ? { ...message, text: message.text || "(No response.)", pending: false }
          : message));
      }
      if (turn?.status === "failed") addAssistantError(errorDetail(turn.error));
      activeAssistant.current = null;
      setBusy(false);
      setApprovals([]);
      if (workspaceChanged.current) {
        workspaceChanged.current = false;
        callbacks.current.onWorkspaceChanged();
      }
    }
  }

  function handleBridgeMessage(message: Record<string, unknown>) {
    if (message.type === "ready") {
      setAccount(message.account as AccountState);
      setConnection("ready");
      setProblem(null);
      return;
    }
    if (message.type === "codex") {
      handleCodexEvent(message.message as CodexEvent);
      return;
    }
    if (message.type === "approvalResolved") {
      setApprovals((current) => current.filter((item) => item.requestId !== message.requestId));
      return;
    }
    if (message.type === "login") {
      const result = message.result as { authUrl?: string; verificationUrl?: string };
      setLoginUrl(result.authUrl ?? result.verificationUrl ?? null);
      return;
    }
    if (message.type === "error") {
      const detail = String(message.message ?? "Unknown Codex bridge error");
      setProblem(detail);
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
    if (!(await callbacks.current.onBeforePrompt())) {
      setBusy(false);
      return;
    }
    const assistantId = crypto.randomUUID();
    activeAssistant.current = assistantId;
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", text: clean },
      { id: assistantId, role: "assistant", text: "", pending: true },
    ]);
    socket.send(JSON.stringify({
      type: "prompt",
      prompt: clean,
      context: includeContext ? {
        notebook: notebookPath,
        cellKind: selectedCell?.kind,
        source: selectedCell?.source,
      } : null,
    }));
    setPrompt("");
    setProblem(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void sendPrompt(prompt);
  }

  function respondApproval(requestId: string | number, decision: string) {
    if (decision === "accept" || decision === "acceptForSession") workspaceChanged.current = true;
    socketRef.current?.send(JSON.stringify({ type: "approval", requestId, decision }));
  }

  function newThread() {
    socketRef.current?.send(JSON.stringify({ type: "newThread" }));
    activeAssistant.current = null;
    setBusy(false);
    setApprovals([]);
    setMessages(initialMessages());
  }

  const signedIn = !account?.requiresOpenaiAuth || Boolean(account.account);
  const ready = connection === "ready" && signedIn;
  const accountLabel = account?.account?.type === "chatgpt"
    ? account.account.planType ?? "ChatGPT"
    : account?.account?.type ?? null;
  const cellLabel = selectedCell ? `${selectedCell.kind} cell` : null;

  return (
    <aside className="codex-panel" aria-label="Codex assistant">
      <div className="codex-heading">
        <span><SparkIcon />CODEX</span>
        <div className="codex-heading-actions">
          {connection === "ready" && <button onClick={newThread} disabled={busy} title="New Codex thread">new</button>}
          <span className={`connection-state ${ready ? "is-ready" : ""}`}>
            <i />{connection === "checking" ? "checking" : connection === "connecting" ? "connecting" : ready ? accountLabel ?? "ready" : "attention"}
          </span>
        </div>
      </div>
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
            <p>Sign in through the local Codex CLI. No API key is sent to Quick Notebook.</p>
            <button onClick={() => socketRef.current?.send(JSON.stringify({ type: "login" }))}>Sign in with ChatGPT</button>
            {loginUrl && <a href={loginUrl} target="_blank" rel="noreferrer">Continue sign-in ↗</a>}
          </div>
        )}
        {messages.map((message, index) => (
          <div className={`message message-${message.role}`} key={message.id}>
            <span>{message.role === "assistant" ? "CODEX" : message.role === "user" ? "YOU" : "ACTIVITY"}</span>
            {message.role === "assistant" ? <ReactMarkdown>{message.text}</ReactMarkdown> : <pre>{message.text}</pre>}
            {message.pending && !message.text && <i className="codex-thinking" />}
            {message.role === "assistant" && index === 0 && (
              <div className="suggestions">
                <button onClick={() => void sendPrompt("Explain the selected cell")}>Explain this cell</button>
                <button onClick={() => void sendPrompt("Find the error in the selected cell")}>Find the error</button>
                <button onClick={() => void sendPrompt("Suggest the next notebook cell")}>Write the next cell</button>
              </div>
            )}
          </div>
        ))}
        {approvals.map((approval) => (
          <div className="approval-card" key={approval.requestId}>
            <strong>{approval.title}</strong>
            <pre>{approval.detail}</pre>
            <div>
              <button onClick={() => respondApproval(approval.requestId, "decline")}>Deny</button>
              <button onClick={() => respondApproval(approval.requestId, "acceptForSession")}>Allow session</button>
              <button className="approval-primary" onClick={() => respondApproval(approval.requestId, "accept")}>Allow</button>
            </div>
          </div>
        ))}
        {problem && <button className="codex-problem" onClick={() => setProblem(null)}>{problem}</button>}
      </div>
      <form className="prompt-box" onSubmit={submit}>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={ready ? "Ask about this notebook…" : "Connect Codex to start…"}
          rows={3}
          disabled={!ready || busy}
        />
        <div className="prompt-actions">
          <button type="button" className={`context-button ${includeContext ? "is-active" : ""}`} onClick={() => setIncludeContext((value) => !value)}>@ context</button>
          <span>{busy ? "Codex is working" : "↵ send · ⇧↵ newline"}</span>
          {busy ? (
            <button type="button" className="send-button stop-codex" onClick={() => socketRef.current?.send(JSON.stringify({ type: "interrupt" }))} title="Stop Codex"><StopIcon /></button>
          ) : (
            <button type="submit" className="send-button" disabled={!prompt.trim() || !ready}>↑</button>
          )}
        </div>
      </form>
    </aside>
  );
}
