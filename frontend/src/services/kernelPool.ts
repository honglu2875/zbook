import type {
  ExecutionResult,
  KernelState,
} from "./kernel";

export interface ManagedKernel {
  readonly currentState: KernelState;
  start(notebookPath: string): Promise<void>;
  execute(
    code: string,
    onUpdate?: (result: ExecutionResult) => void,
  ): Promise<ExecutionResult>;
  renderWidget(modelId: string, element: HTMLElement): Promise<() => void>;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;
}

type KernelFactory = (onState: (state: KernelState) => void) => ManagedKernel;

interface KernelSlot {
  path: string;
  state: KernelState;
  client: ManagedKernel;
}

function isSameOrChild(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

/** Keep one live IPython kernel per notebook tab without coupling it to React state. */
export class NotebookKernelPool {
  private readonly slots = new Map<string, KernelSlot>();

  constructor(
    private readonly onChange: () => void,
    private readonly createKernel: KernelFactory,
  ) {}

  client(path: string): ManagedKernel {
    const existing = this.slots.get(path);
    if (existing) return existing.client;

    const slot = { path, state: "disconnected" } as KernelSlot;
    slot.client = this.createKernel((state) => {
      slot.state = state;
      if (this.slots.get(slot.path) === slot) this.onChange();
    });
    this.slots.set(path, slot);
    this.onChange();
    return slot.client;
  }

  state(path: string | null): KernelState {
    return path ? this.slots.get(path)?.state ?? "disconnected" : "disconnected";
  }

  has(path: string): boolean {
    return this.slots.has(path);
  }

  async shutdown(path: string): Promise<void> {
    const slot = this.slots.get(path);
    if (!slot) return;
    await slot.client.shutdown();
    if (this.slots.get(path) === slot) this.slots.delete(path);
    this.onChange();
  }

  async shutdownUnder(path: string): Promise<void> {
    const affected = [...this.slots.keys()].filter((candidate) => isSameOrChild(candidate, path));
    await Promise.all(affected.map((candidate) => this.shutdown(candidate)));
  }

  async shutdownAll(): Promise<void> {
    const paths = [...this.slots.keys()];
    await Promise.all(paths.map((path) => this.shutdown(path)));
  }

  remapUnder(path: string, nextPath: string): void {
    const affected = [...this.slots.entries()]
      .filter(([candidate]) => isSameOrChild(candidate, path));
    for (const [candidate] of affected) this.slots.delete(candidate);
    for (const [candidate, slot] of affected) {
      const remapped = `${nextPath}${candidate.slice(path.length)}`;
      slot.path = remapped;
      this.slots.set(remapped, slot);
    }
    if (affected.length) this.onChange();
  }
}
