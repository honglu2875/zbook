import { describe, expect, it, vi } from "vitest";
import type { ExecutionResult, KernelState } from "./kernel";
import { NotebookKernelPool, type ManagedKernel } from "./kernelPool";

class FakeKernel implements ManagedKernel {
  state: KernelState = "disconnected";
  shutdown = vi.fn(async () => this.emit("disconnected"));

  constructor(private readonly onState: (state: KernelState) => void) {}

  get currentState(): KernelState {
    return this.state;
  }

  emit(state: KernelState) {
    this.state = state;
    this.onState(state);
  }

  async start(): Promise<void> {
    this.emit("idle");
  }

  async execute(): Promise<ExecutionResult> {
    return { outputs: [], executionCount: 1 };
  }

  async renderWidget(): Promise<() => void> {
    return () => undefined;
  }

  async interrupt(): Promise<void> {}
}

function setup() {
  const kernels: FakeKernel[] = [];
  const changed = vi.fn();
  const pool = new NotebookKernelPool(changed, (onState) => {
    const kernel = new FakeKernel(onState);
    kernels.push(kernel);
    return kernel;
  });
  return { pool, kernels, changed };
}

describe("NotebookKernelPool", () => {
  it("creates and retains one kernel per notebook", () => {
    const { pool, kernels } = setup();

    expect(pool.client("one.ipynb")).toBe(pool.client("one.ipynb"));
    expect(pool.client("two.ipynb")).not.toBe(pool.client("one.ipynb"));
    expect(kernels).toHaveLength(2);
  });

  it("tracks independent states and remaps renamed notebooks", () => {
    const { pool, kernels } = setup();
    pool.client("folder/one.ipynb");
    pool.client("two.ipynb");
    kernels[0].emit("idle");
    kernels[1].emit("error");

    pool.remapUnder("folder", "renamed");

    expect(pool.state("folder/one.ipynb")).toBe("disconnected");
    expect(pool.state("renamed/one.ipynb")).toBe("idle");
    expect(pool.state("two.ipynb")).toBe("error");
  });

  it("shuts down one notebook, a directory, or the complete pool", async () => {
    const { pool, kernels } = setup();
    pool.client("folder/one.ipynb");
    pool.client("folder/two.ipynb");
    pool.client("other.ipynb");

    await pool.shutdown("folder/one.ipynb");
    expect(kernels[0].shutdown).toHaveBeenCalledOnce();
    expect(pool.has("folder/one.ipynb")).toBe(false);

    await pool.shutdownUnder("folder");
    expect(kernels[1].shutdown).toHaveBeenCalledOnce();
    expect(pool.has("other.ipynb")).toBe(true);

    await pool.shutdownAll();
    expect(kernels[2].shutdown).toHaveBeenCalledOnce();
    expect(pool.has("other.ipynb")).toBe(false);
  });
});
