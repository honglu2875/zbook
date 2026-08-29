export interface ExecutionQueueItem {
  cellId: string;
}

export interface ExecutionQueueState {
  active: ExecutionQueueItem | null;
  pending: ExecutionQueueItem[];
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
  return { active: null, pending: [] };
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
  if (queue.active || queue.pending.length === 0) return queue;
  const [active, ...pending] = queue.pending;
  return { active, pending };
}

export function completeActiveExecution(queue: ExecutionQueueState): ExecutionQueueState {
  return { active: null, pending: queue.pending };
}

export function failActiveExecution(queue: ExecutionQueueState): CancelResult {
  return {
    queue: emptyExecutionQueue(),
    cancelledCellIds: queue.pending.map((item) => item.cellId),
  };
}

export function cancelQueuedFrom(queue: ExecutionQueueState, cellId: string): CancelResult {
  const index = queue.pending.findIndex((item) => item.cellId === cellId);
  if (index < 0) return { queue, cancelledCellIds: [] };
  const cancelledCellIds = queue.pending.slice(index).map((item) => item.cellId);
  const pending = queue.pending.slice(0, index);
  return {
    queue: { ...queue, pending },
    cancelledCellIds,
  };
}

export function clearPendingExecutions(queue: ExecutionQueueState): CancelResult {
  if (queue.pending.length === 0) return { queue, cancelledCellIds: [] };
  return {
    queue: { ...queue, pending: [] },
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
