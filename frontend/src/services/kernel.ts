import type { Kernel, KernelMessage } from "@jupyterlab/services";
import {
  outputFromRaw,
  richOutputFromKernel,
  type NotebookOutput,
  type RawNotebookOutput,
} from "../model/notebook";
import { jupyterUrl, requestJson } from "./http";
import type { KernelRuntime } from "./widgetRuntime";

export type KernelState = "disconnected" | "starting" | "idle" | "busy" | "dead" | "error";

interface KernelModel extends Kernel.IModel {
  id: string;
  name: string;
  execution_state: string;
  last_activity: string;
  connections: number;
}

interface PendingExecution {
  outputs: RawNotebookOutput[];
  executionCount: number | null;
  clearOnNextOutput: boolean;
  displayIds: Map<string, number[]>;
  onUpdate?: (result: ExecutionResult) => void;
}

export interface ExecutionResult {
  outputs: NotebookOutput[];
  executionCount: number | null;
}

export class KernelClient {
  private runtime: KernelRuntime | null = null;
  private kernelId: string | null = null;
  private readonly sessionId = crypto.randomUUID();
  private state: KernelState = "disconnected";
  private startPromise: Promise<void> | null = null;

  constructor(private readonly onState: (state: KernelState) => void) {}

  get currentState(): KernelState {
    return this.state;
  }

  private setState(state: KernelState) {
    this.state = state;
    this.onState(state);
  }

  async start(notebookPath: string): Promise<void> {
    if (
      this.runtime
      && !this.runtime.kernel.isDisposed
      && this.runtime.kernel.connectionStatus !== "disconnected"
    ) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startRuntime(notebookPath).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startRuntime(notebookPath: string): Promise<void> {
    await this.disposeRuntime(true);
    this.setState("starting");
    let model: KernelModel | null = null;
    try {
      model = await requestJson<KernelModel>(jupyterUrl("kernels"), {
        method: "POST",
        body: JSON.stringify({ name: "zbook", path: notebookPath }),
      });
      this.kernelId = model.id;
      const { connectKernelRuntime } = await import("./widgetRuntime");
      const runtime = await connectKernelRuntime(model, this.sessionId);
      this.runtime = runtime;
      runtime.kernel.connectionStatusChanged.connect(this.handleConnectionStatus);
      runtime.kernel.statusChanged.connect(this.handleKernelStatus);
      this.setState("idle");
    } catch (error) {
      const kernelId = model?.id ?? this.kernelId;
      this.runtime = null;
      this.kernelId = null;
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
    const runtime = this.runtime;
    if (!runtime || runtime.kernel.isDisposed || runtime.kernel.connectionStatus === "disconnected") {
      throw new Error("Kernel is not connected");
    }
    const pending: PendingExecution = {
      outputs: [],
      executionCount: null,
      clearOnNextOutput: false,
      displayIds: new Map(),
      onUpdate,
    };
    this.setState("busy");
    const future = runtime.kernel.requestExecute({
      code,
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: false,
      stop_on_error: true,
    });
    future.onIOPub = (message) => this.handleExecutionMessage(message, pending);
    try {
      await future.done;
      if (this.runtime === runtime) this.setState("idle");
      return this.snapshot(pending);
    } catch (error) {
      if (this.runtime === runtime && this.state !== "dead") this.setState("error");
      throw error;
    }
  }

  async renderWidget(modelId: string, element: HTMLElement): Promise<() => void> {
    const runtime = this.runtime;
    if (!runtime || runtime.kernel.isDisposed) {
      throw new Error("Run the cell to connect this widget to a live kernel.");
    }
    return runtime.widgets.render(modelId, element);
  }

  async interrupt(): Promise<void> {
    if (!this.kernelId) return;
    await requestJson<unknown>(jupyterUrl(`kernels/${this.kernelId}/interrupt`), {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async shutdown(): Promise<void> {
    const starting = this.startPromise;
    if (starting) {
      try {
        await starting;
      } catch {
        // A failed start has already cleaned up its partial kernel.
      }
    }
    await this.disposeRuntime(true);
    this.setState("disconnected");
  }

  private async disposeRuntime(deleteKernel: boolean): Promise<void> {
    const kernelId = this.kernelId;
    const runtime = this.runtime;
    this.kernelId = null;
    this.runtime = null;
    if (runtime) {
      runtime.kernel.connectionStatusChanged.disconnect(this.handleConnectionStatus);
      runtime.kernel.statusChanged.disconnect(this.handleKernelStatus);
      try {
        await runtime.widgets.dispose();
      } catch {
        // A dead connection can make widget cleanup fail; disposing locally is sufficient.
      } finally {
        runtime.kernel.dispose();
      }
    }
    if (deleteKernel && kernelId) {
      try {
        await requestJson<unknown>(jupyterUrl(`kernels/${kernelId}`), { method: "DELETE" });
      } catch {
        // The kernel may already have stopped; local state is still safely cleared.
      }
    }
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

  private prepareForOutput(pending: PendingExecution) {
    if (!pending.clearOnNextOutput) return;
    pending.outputs = [];
    pending.displayIds.clear();
    pending.clearOnNextOutput = false;
  }

  private rememberDisplayId(
    pending: PendingExecution,
    content: Record<string, any>,
    outputIndex: number,
  ) {
    const transient = content.transient;
    const displayId = transient && typeof transient === "object"
      ? (transient as Record<string, unknown>).display_id
      : null;
    if (typeof displayId !== "string") return;
    const indices = pending.displayIds.get(displayId) ?? [];
    indices.push(outputIndex);
    pending.displayIds.set(displayId, indices);
  }

  private handleExecutionMessage(
    message: KernelMessage.IIOPubMessage,
    pending: PendingExecution,
  ) {
    const content = message.content as Record<string, any>;
    switch (message.header.msg_type) {
      case "execute_input":
        pending.executionCount = typeof content.execution_count === "number"
          ? content.execution_count
          : pending.executionCount;
        this.emit(pending);
        break;
      case "stream":
        this.prepareForOutput(pending);
        pending.outputs.push({
          output_type: "stream",
          name: content.name === "stderr" ? "stderr" : "stdout",
          text: typeof content.text === "string" ? content.text : "",
        });
        this.emit(pending);
        break;
      case "execute_result":
      case "display_data": {
        this.prepareForOutput(pending);
        const output = richOutputFromKernel(
          message.header.msg_type,
          (content.data ?? {}) as Record<string, unknown>,
          (content.metadata ?? {}) as Record<string, unknown>,
          typeof content.execution_count === "number"
            ? content.execution_count
            : pending.executionCount,
        );
        const outputIndex = pending.outputs.push(output) - 1;
        this.rememberDisplayId(pending, content, outputIndex);
        this.emit(pending);
        break;
      }
      case "update_display_data": {
        const transient = content.transient;
        const displayId = transient && typeof transient === "object"
          ? (transient as Record<string, unknown>).display_id
          : null;
        const indices = typeof displayId === "string" ? pending.displayIds.get(displayId) : null;
        if (!indices?.length) break;
        const output = richOutputFromKernel(
          "display_data",
          (content.data ?? {}) as Record<string, unknown>,
          (content.metadata ?? {}) as Record<string, unknown>,
          pending.executionCount,
        );
        for (const index of indices) pending.outputs[index] = output;
        this.emit(pending);
        break;
      }
      case "error":
        this.prepareForOutput(pending);
        pending.outputs.push({
          output_type: "error",
          ename: typeof content.ename === "string" ? content.ename : "Error",
          evalue: typeof content.evalue === "string" ? content.evalue : "",
          traceback: Array.isArray(content.traceback) ? content.traceback as string[] : [],
        });
        this.emit(pending);
        break;
      case "clear_output":
        if (content.wait === true) {
          pending.clearOnNextOutput = true;
        } else {
          pending.outputs = [];
          pending.displayIds.clear();
          this.emit(pending);
        }
        break;
      case "status":
        if (content.execution_state === "busy") this.setState("busy");
        break;
    }
  }

  private readonly handleConnectionStatus = (
    kernel: Kernel.IKernelConnection,
    status: Kernel.ConnectionStatus,
  ) => {
    if (this.runtime?.kernel !== kernel) return;
    if (status === "disconnected") {
      this.setState("dead");
    } else if (status === "connected" && this.state === "starting") {
      this.setState("idle");
    }
  };

  private readonly handleKernelStatus = (
    kernel: Kernel.IKernelConnection,
    status: KernelMessage.Status,
  ) => {
    if (this.runtime?.kernel !== kernel) return;
    if (status === "dead") this.setState("dead");
  };
}
