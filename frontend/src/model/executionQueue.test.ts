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
  pauseExecutionQueue,
  resumeExecutionQueue,
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

  it("pauses remaining work after completion and resumes explicitly", () => {
    let queue = activateNextExecution(queued("a", "b"));
    queue = completeActiveExecution(queue, true);

    expect(queue.paused).toBe(true);
    expect(activateNextExecution(queue).active).toBeNull();

    queue = activateNextExecution(resumeExecutionQueue(queue));
    expect(queue.active?.cellId).toBe("b");
    expect(queue.paused).toBe(false);
  });

  it("retains an interrupt pause requested before more work is queued", () => {
    let queue = activateNextExecution(queued("a"));
    queue = pauseExecutionQueue(queue);
    queue = enqueueExecution(queue, "b").queue;
    queue = completeActiveExecution(queue);

    expect(queue.paused).toBe(true);
    expect(queue.pending.map((item) => item.cellId)).toEqual(["b"]);
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
