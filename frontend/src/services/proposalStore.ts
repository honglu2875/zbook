import type { CellProposal } from "../model/cellProposals";

interface StoredCellProposal extends CellProposal {
  key: string;
  workspace: string;
}

const DATABASE_NAME = "zbook-state";
const DATABASE_VERSION = 1;
const STORE_NAME = "cell-proposals";
const WORKSPACE_INDEX = "workspace";
const pendingWrites = new Map<string, Promise<void>>();

function proposalKey(workspace: string, notebookPath: string, cellId: string): string {
  return JSON.stringify([workspace, notebookPath, cellId]);
}

function queuedWrite(key: string, operation: () => Promise<void>): Promise<void> {
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pendingWrites.set(key, current);
  void current.then(
    () => {
      if (pendingWrites.get(key) === current) pendingWrites.delete(key);
    },
    () => {
      if (pendingWrites.get(key) === current) pendingWrites.delete(key);
    },
  );
  return current;
}

function validStoredProposal(value: unknown): value is StoredCellProposal {
  if (!value || typeof value !== "object") return false;
  const proposal = value as Partial<StoredCellProposal>;
  return typeof proposal.key === "string"
    && typeof proposal.workspace === "string"
    && typeof proposal.notebookPath === "string"
    && typeof proposal.cellId === "string"
    && typeof proposal.baseSource === "string"
    && typeof proposal.draftSource === "string"
    && Number.isInteger(proposal.baseDocumentRevision)
    && Number.isInteger(proposal.proposalRevision)
    && (proposal.ownerThreadId === null || typeof proposal.ownerThreadId === "string")
    && (proposal.ownerTurnId === null || typeof proposal.ownerTurnId === "string")
    && (proposal.state === "streaming" || proposal.state === "review" || proposal.state === "conflict")
    && typeof proposal.updatedAt === "number";
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains(STORE_NAME)) return;
      const store = database.createObjectStore(STORE_NAME, { keyPath: "key" });
      store.createIndex(WORKSPACE_INDEX, WORKSPACE_INDEX, { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open Zbook recovery storage."));
  });
}

function transactionCompleted(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    const [result] = await Promise.all([requestResult(request), transactionCompleted(transaction)]);
    return result;
  } finally {
    database.close();
  }
}

export async function loadCellProposals(workspace: string): Promise<CellProposal[]> {
  const workspaceKeyPrefix = `${JSON.stringify([workspace]).slice(0, -1)},`;
  const pending = [...pendingWrites.entries()]
    .filter(([key]) => key.startsWith(workspaceKeyPrefix))
    .map(([, operation]) => operation.catch(() => undefined));
  await Promise.all(pending);
  const records = await withStore(
    "readonly",
    (store) => store.index(WORKSPACE_INDEX).getAll(workspace) as IDBRequest<StoredCellProposal[]>,
  );
  return records.flatMap((record): CellProposal[] => {
    if (!validStoredProposal(record) || record.workspace !== workspace) return [];
    const { key: _key, workspace: _workspace, ...proposal } = record;
    return [{
      ...proposal,
      state: proposal.state === "streaming" ? "review" : proposal.state,
    }];
  });
}

export async function storeCellProposal(workspace: string, proposal: CellProposal): Promise<void> {
  const key = proposalKey(workspace, proposal.notebookPath, proposal.cellId);
  const record: StoredCellProposal = {
    ...proposal,
    key,
    workspace,
  };
  await queuedWrite(key, async () => {
    await withStore("readwrite", (store) => store.put(record));
  });
}

export async function removeCellProposal(
  workspace: string,
  notebookPath: string,
  cellId: string,
): Promise<void> {
  const key = proposalKey(workspace, notebookPath, cellId);
  await queuedWrite(key, async () => {
    await withStore("readwrite", (store) => store.delete(key));
  });
}
