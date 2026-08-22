import { outputFromRaw, type NotebookOutput, type RawNotebookOutput } from "../model/notebook";
import { jupyterUrl, jupyterWebsocketUrl, requestJson } from "./http";

export type KernelState = "disconnected" | "starting" | "idle" | "busy" | "dead" | "error";

interface KernelModel {
  id: string;
  name: string;
  execution_state: string;
  last_activity: string;
  connections: number;
}

interface JupyterMessage {
  channel: "shell" | "iopub" | "stdin" | "control";
  header: {
    msg_id: string;
    msg_type: string;
    session: string;
    username?: string;
    date?: string;
    version?: string;
  };
  parent_header: { msg_id?: string };
  metadata: Record<string, unknown>;
  content: Record<string, unknown>;
  buffers?: unknown[];
}

interface PendingExecution {
  outputs: RawNotebookOutput[];
  executionCount: number | null;
  resolve: (result: ExecutionResult) => void;
  reject: (error: Error) => void;
  onUpdate?: (result: ExecutionResult) => void;
}

export interface ExecutionResult {
  outputs: NotebookOutput[];
  executionCount: number | null;
}

export class KernelClient {
  private socket: WebSocket | null = null;
  private kernelId: string | null = null;
  private readonly sessionId = crypto.randomUUID();
  private readonly pending = new Map<string, PendingExecution>();
  private state: KernelState = "disconnected";

  constructor(private readonly onState: (state: KernelState) => void) {}

  get currentState(): KernelState {
    return this.state;
  }

  private setState(state: KernelState) {
    this.state = state;
    this.onState(state);
  }

  async start(notebookPath: string): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.kernelId) return;
    this.setState("starting");
    try {
      const model = await requestJson<KernelModel>(jupyterUrl("kernels"), {
        method: "POST",
        body: JSON.stringify({ name: "zbook", path: notebookPath }),
      });
      this.kernelId = model.id;
      const url = jupyterWebsocketUrl(`kernels/${model.id}/channels`);
      url.searchParams.set("session_id", this.sessionId);
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onclose = () => this.handleClose(new Error("Kernel connection closed"));
      socket.onerror = () => this.setState("error");

      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("Kernel connection timed out")), 10_000);
        socket.onopen = () => {
          window.clearTimeout(timeout);
          this.setState("idle");
          resolve();
        };
        socket.addEventListener("error", () => {
          window.clearTimeout(timeout);
          reject(new Error("Could not open the kernel WebSocket"));
        }, { once: true });
      });
    } catch (error) {
      const kernelId = this.kernelId;
      const socket = this.socket;
      this.kernelId = null;
      this.socket = null;
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.close();
      }
      if (kernelId) {
        try {
          await requestJson<unknown>(jupyterUrl(`kernels/${kernelId}`), { method: "DELETE" });
        } catch {
          // Preserve the connection error; the server also reaps dead kernels.
        }
      }
      this.setState("error");
      throw error;
    }
  }

  async execute(
    code: string,
    onUpdate?: (result: ExecutionResult) => void,
  ): Promise<ExecutionResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Kernel is not connected");
    }
    const msgId = crypto.randomUUID();
    const message: JupyterMessage = {
      channel: "shell",
      header: {
        msg_id: msgId,
        msg_type: "execute_request",
        session: this.sessionId,
        username: "zbook",
        date: new Date().toISOString(),
        version: "5.4",
      },
      parent_header: {},
      metadata: {},
      content: {
        code,
        silent: false,
        store_history: true,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      },
      buffers: [],
    };
    this.setState("busy");
    return new Promise<ExecutionResult>((resolve, reject) => {
      this.pending.set(msgId, {
        outputs: [],
        executionCount: null,
        resolve,
        reject,
        onUpdate,
      });
      this.socket?.send(JSON.stringify(message));
    });
  }

  async interrupt(): Promise<void> {
    if (!this.kernelId) return;
    await requestJson<unknown>(jupyterUrl(`kernels/${this.kernelId}/interrupt`), {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async shutdown(): Promise<void> {
    const kernelId = this.kernelId;
    this.kernelId = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
    const error = new Error("Kernel was shut down");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (kernelId) {
      try {
        await requestJson<unknown>(jupyterUrl(`kernels/${kernelId}`), { method: "DELETE" });
      } catch {
        // The kernel may already have stopped; local state is still safely cleared.
      }
    }
    this.setState("disconnected");
  }

  private snapshot(pending: PendingExecution): ExecutionResult {
    return {
      outputs: pending.outputs.map(outputFromRaw),
      executionCount: pending.executionCount,
    };
  }

  private emit(pending: PendingExecution) {
    pending.onUpdate?.(this.snapshot(pending));
  }

  private handleMessage(data: string | ArrayBuffer | Blob) {
    if (typeof data !== "string") return;
    let message: JupyterMessage;
    try {
      message = JSON.parse(data) as JupyterMessage;
    } catch {
      return;
    }
    const parentId = message.parent_header?.msg_id;
    if (!parentId) return;
    const pending = this.pending.get(parentId);
    if (!pending) return;

    const content = message.content;
    switch (message.header.msg_type) {
      case "execute_input":
        pending.executionCount = typeof content.execution_count === "number"
          ? content.execution_count
          : pending.executionCount;
        this.emit(pending);
        break;
      case "stream":
        pending.outputs.push({
          output_type: "stream",
          name: content.name === "stderr" ? "stderr" : "stdout",
          text: typeof content.text === "string" ? content.text : "",
        });
        this.emit(pending);
        break;
      case "execute_result":
      case "display_data":
        pending.outputs.push({
          output_type: message.header.msg_type,
          data: (content.data ?? {}) as Record<string, unknown>,
          metadata: (content.metadata ?? {}) as Record<string, unknown>,
          execution_count: typeof content.execution_count === "number"
            ? content.execution_count
            : pending.executionCount,
        });
        this.emit(pending);
        break;
      case "error":
        pending.outputs.push({
          output_type: "error",
          ename: typeof content.ename === "string" ? content.ename : "Error",
          evalue: typeof content.evalue === "string" ? content.evalue : "",
          traceback: Array.isArray(content.traceback) ? content.traceback as string[] : [],
        });
        this.emit(pending);
        break;
      case "clear_output":
        pending.outputs = [];
        this.emit(pending);
        break;
      case "status":
        if (content.execution_state === "idle") {
          this.pending.delete(parentId);
          this.setState("idle");
          pending.resolve(this.snapshot(pending));
        } else if (content.execution_state === "busy") {
          this.setState("busy");
        }
        break;
    }
  }

  private handleClose(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.socket = null;
    this.kernelId = null;
    this.setState("dead");
  }
}
