export interface ExecutionQueueItem {
  cellId: string;
}

export interface ExecutionQueueState {
  active: ExecutionQueueItem | null;
  pending: ExecutionQueueItem[];
  paused: boolean;
}

export interface EnqueueResult {
  queue: ExecutionQueueState;
  accepted: boolean;
  position: number;
}

export interface CancelResult {
  queue: ExecutionQueueState;
  cancelledCellIds: string[];
}

export function emptyExecutionQueue(): ExecutionQueueState {
  return { active: null, pending: [], paused: false };
}

export function executionPosition(queue: ExecutionQueueState, cellId: string): number | null {
  if (queue.active?.cellId === cellId) return 0;
  const index = queue.pending.findIndex((item) => item.cellId === cellId);
  return index < 0 ? null : index + 1;
}

export function enqueueExecution(queue: ExecutionQueueState, cellId: string): EnqueueResult {
  const existingPosition = executionPosition(queue, cellId);
  if (existingPosition !== null) {
    return { queue, accepted: false, position: existingPosition };
  }
  const pending = [...queue.pending, { cellId }];
  return {
    queue: { ...queue, pending },
    accepted: true,
    position: pending.length,
  };
}

export function activateNextExecution(queue: ExecutionQueueState): ExecutionQueueState {
  if (queue.active || queue.paused || queue.pending.length === 0) return queue;
  const [active, ...pending] = queue.pending;
  return { active, pending, paused: false };
}

export function completeActiveExecution(
  queue: ExecutionQueueState,
  pauseRemaining = false,
): ExecutionQueueState {
  const paused = queue.pending.length > 0 && (queue.paused || pauseRemaining);
  return { active: null, pending: queue.pending, paused };
}

export function pauseExecutionQueue(queue: ExecutionQueueState): ExecutionQueueState {
  return queue.paused ? queue : { ...queue, paused: true };
}

export function resumeExecutionQueue(queue: ExecutionQueueState): ExecutionQueueState {
  return queue.paused ? { ...queue, paused: false } : queue;
}

export function cancelQueuedFrom(queue: ExecutionQueueState, cellId: string): CancelResult {
  const index = queue.pending.findIndex((item) => item.cellId === cellId);
  if (index < 0) return { queue, cancelledCellIds: [] };
  const cancelledCellIds = queue.pending.slice(index).map((item) => item.cellId);
  const pending = queue.pending.slice(0, index);
  return {
    queue: {
      ...queue,
      pending,
      paused: pending.length > 0 && queue.paused,
    },
    cancelledCellIds,
  };
}

export function clearPendingExecutions(queue: ExecutionQueueState): CancelResult {
  if (queue.pending.length === 0) return { queue, cancelledCellIds: [] };
  return {
    queue: { ...queue, pending: [], paused: false },
    cancelledCellIds: queue.pending.map((item) => item.cellId),
  };
}

export function cancelAllExecutions(queue: ExecutionQueueState): CancelResult {
  const cancelledCellIds = [
    ...(queue.active ? [queue.active.cellId] : []),
    ...queue.pending.map((item) => item.cellId),
  ];
  return { queue: emptyExecutionQueue(), cancelledCellIds };
}
