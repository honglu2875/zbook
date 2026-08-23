import {
  KernelConnection,
  ServerConnection,
  type Kernel,
  type KernelMessage,
} from "@jupyterlab/services";
import * as base from "@jupyter-widgets/base";
import * as controls from "@jupyter-widgets/controls";
import { HTMLManager } from "@jupyter-widgets/html-manager/lib/htmlmanager";
import * as output from "@jupyter-widgets/output";
import * as jupyterMatplotlib from "jupyter-matplotlib";
import "@jupyter-widgets/controls/css/widgets.css";
import "jupyter-matplotlib/css/mpl_widget.css";
import "../widget-outputs.css";
import { jupyterAuthToken, jupyterServerUrl } from "./http";

export interface KernelRuntime {
  kernel: Kernel.IKernelConnection;
  widgets: ZbookWidgetManager;
}

async function loadWidgetModule(moduleName: string, moduleVersion: string): Promise<unknown> {
  switch (moduleName) {
    case "@jupyter-widgets/base":
      return base;
    case "@jupyter-widgets/controls":
      return controls;
    case "@jupyter-widgets/output":
      return output;
    case "jupyter-matplotlib":
      return jupyterMatplotlib;
    default:
      throw new Error(
        `Widget module ${moduleName}@${moduleVersion} is not bundled with Zbook`,
      );
  }
}

class ZbookWidgetManager extends HTMLManager {
  private readonly views = new Set<base.DOMWidgetView>();
  private disposed = false;
  private readonly commOpenHandler: (
    comm: Kernel.IComm,
    message: KernelMessage.ICommOpenMsg,
  ) => Promise<void>;

  constructor(private readonly kernel: Kernel.IKernelConnection) {
    super({ loader: loadWidgetModule });
    this.commOpenHandler = async (comm, message) => {
      await this.handle_comm_open(new base.shims.services.Comm(comm), message);
    };
    kernel.registerCommTarget(this.comm_target_name, this.commOpenHandler);
  }

  async _create_comm(
    targetName: string,
    modelId?: string,
    data?: any,
    metadata?: any,
    buffers?: ArrayBuffer[] | ArrayBufferView[],
  ): Promise<base.IClassicComm> {
    const comm = this.kernel.createComm(targetName, modelId);
    if (data !== undefined || metadata !== undefined || buffers?.length) {
      comm.open(data ?? {}, metadata ?? {}, buffers);
    }
    return new base.shims.services.Comm(comm);
  }

  async _get_comm_info(): Promise<Record<string, unknown>> {
    const reply = await this.kernel.requestCommInfo({ target_name: this.comm_target_name });
    return (reply.content as { comms: Record<string, unknown> }).comms;
  }

  async render(modelId: string, element: HTMLElement): Promise<() => void> {
    if (this.disposed) {
      throw new Error("This widget's kernel is no longer running. Run the cell again to restore it.");
    }
    if (!this.has_model(modelId)) {
      throw new Error("This widget is no longer connected. Run the cell again to restore it.");
    }
    const model = await this.get_model(modelId) as base.DOMWidgetModel;
    const view = await this.create_view(model);
    this.views.add(view);
    try {
      await this.display_view(view, element);
    } catch (error) {
      this.views.delete(view);
      view.remove();
      throw error;
    }
    return () => {
      if (!this.views.delete(view)) return;
      view.remove();
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.kernel.removeCommTarget(this.comm_target_name, this.commOpenHandler);
    for (const view of this.views) view.remove();
    this.views.clear();
    this.disconnect();
    await this.clear_state();
  }
}

function waitForConnection(kernel: Kernel.IKernelConnection): Promise<void> {
  if (kernel.connectionStatus === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeout = 0;
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      kernel.connectionStatusChanged.disconnect(onStatus);
      if (error) reject(error);
      else resolve();
    };
    const onStatus = (_sender: Kernel.IKernelConnection, status: Kernel.ConnectionStatus) => {
      if (status === "connected") finish();
      if (status === "disconnected") finish(new Error("Could not open the kernel WebSocket"));
    };
    kernel.connectionStatusChanged.connect(onStatus);
    timeout = window.setTimeout(() => finish(new Error("Kernel connection timed out")), 10_000);
  });
}

export async function connectKernelRuntime(
  model: Kernel.IModel,
  clientId: string,
): Promise<KernelRuntime> {
  const baseUrl = jupyterServerUrl();
  const wsUrl = new URL(baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const token = jupyterAuthToken();
  const serverSettings = ServerConnection.makeSettings({
    baseUrl: baseUrl.toString(),
    wsUrl: wsUrl.toString(),
    token,
    appendToken: Boolean(token),
    init: { credentials: "same-origin" },
  });
  const kernel = new KernelConnection({
    model,
    serverSettings,
    clientId,
    username: "zbook",
  });
  const widgets = new ZbookWidgetManager(kernel);
  try {
    await waitForConnection(kernel);
    return { kernel, widgets };
  } catch (error) {
    await widgets.dispose();
    kernel.dispose();
    throw error;
  }
}
