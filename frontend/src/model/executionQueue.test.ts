import { describe, expect, it } from "vitest";
import {
  activateNextExecution,
  cancelAllExecutions,
  cancelQueuedFrom,
  clearPendingExecutions,
  completeActiveExecution,
  emptyExecutionQueue,
  enqueueExecution,
  executionPosition,
  failActiveExecution,
} from "./executionQueue";

function queued(...cellIds: string[]) {
  return cellIds.reduce(
    (queue, cellId) => enqueueExecution(queue, cellId).queue,
    emptyExecutionQueue(),
  );
}

describe("execution queue", () => {
  it("deduplicates cells and reports active and pending positions", () => {
    let queue = queued("a", "b");
    queue = activateNextExecution(queue);

    expect(executionPosition(queue, "a")).toBe(0);
    expect(executionPosition(queue, "b")).toBe(1);
    expect(enqueueExecution(queue, "b")).toEqual({ queue, accepted: false, position: 1 });
  });

  it("cancels a pending cell and its suffix without touching the active cell", () => {
    const queue = activateNextExecution(queued("a", "b", "c", "d"));
    const result = cancelQueuedFrom(queue, "c");

    expect(result.cancelledCellIds).toEqual(["c", "d"]);
    expect(result.queue.active?.cellId).toBe("a");
    expect(result.queue.pending.map((item) => item.cellId)).toEqual(["b"]);
  });

  it("cancels all remaining work when the active execution fails", () => {
    const queue = activateNextExecution(queued("a", "b", "c"));
    const failed = failActiveExecution(queue);

    expect(failed.cancelledCellIds).toEqual(["b", "c"]);
    expect(failed.queue).toEqual(emptyExecutionQueue());
  });

  it("advances normally after a successful execution", () => {
    let queue = activateNextExecution(queued("a", "b"));
    queue = activateNextExecution(completeActiveExecution(queue));

    expect(queue.active?.cellId).toBe("b");
    expect(queue.pending).toEqual([]);
  });

  it("clears pending work separately from cancelling the active execution", () => {
    const queue = activateNextExecution(queued("a", "b", "c"));
    const pending = clearPendingExecutions(queue);

    expect(pending.cancelledCellIds).toEqual(["b", "c"]);
    expect(pending.queue.active?.cellId).toBe("a");

    const all = cancelAllExecutions(queue);
    expect(all.cancelledCellIds).toEqual(["a", "b", "c"]);
    expect(all.queue).toEqual(emptyExecutionQueue());
  });
});
