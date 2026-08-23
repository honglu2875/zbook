import type { RawNotebook } from "../model/notebook";
import type { ContentRevision } from "./contentRevision";

const DATABASE_NAME = "zbook-document-recovery";
const DATABASE_VERSION = 1;
const STORE_NAME = "documents";

export interface DocumentRecovery {
  key: string;
  workspace: string;
  notebookPath: string;
  content: RawNotebook;
  baseRevision: ContentRevision | null;
  updatedAt: number;
}

function recoveryKey(workspace: string, notebookPath: string): string {
  return `${workspace}\n${notebookPath}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Could not open recovery storage"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("workspace", "workspace", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Recovery transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Recovery transaction failed"));
  });
}

export async function storeDocumentRecovery(
  workspace: string,
  notebookPath: string,
  content: RawNotebook,
  baseRevision: ContentRevision | null,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      key: recoveryKey(workspace, notebookPath),
      workspace,
      notebookPath,
      content,
      baseRevision,
      updatedAt: Date.now(),
    } satisfies DocumentRecovery);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function loadDocumentRecovery(
  workspace: string,
  notebookPath: string,
): Promise<DocumentRecovery | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(recoveryKey(workspace, notebookPath));
    const result = await new Promise<DocumentRecovery | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as DocumentRecovery | undefined);
      request.onerror = () => reject(request.error ?? new Error("Could not read recovery draft"));
    });
    await transactionDone(transaction);
    return result ?? null;
  } finally {
    database.close();
  }
}

export async function removeDocumentRecovery(
  workspace: string,
  notebookPath: string,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(recoveryKey(workspace, notebookPath));
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function removeDocumentRecoveriesUnder(
  workspace: string,
  entryPath: string,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const index = transaction.objectStore(STORE_NAME).index("workspace");
    const request = index.openCursor(IDBKeyRange.only(workspace));
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("Could not clean recovery drafts"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = cursor.value as DocumentRecovery;
        if (
          record.notebookPath === entryPath
          || record.notebookPath.startsWith(`${entryPath}/`)
        ) cursor.delete();
        cursor.continue();
      };
    });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function remapDocumentRecoveriesUnder(
  workspace: string,
  entryPath: string,
  nextEntryPath: string,
): Promise<void> {
  const database = await openDatabase();
  try {
    const readTransaction = database.transaction(STORE_NAME, "readonly");
    const request = readTransaction.objectStore(STORE_NAME).index("workspace")
      .getAll(IDBKeyRange.only(workspace));
    const records = await new Promise<DocumentRecovery[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as DocumentRecovery[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read recovery drafts"));
    });
    await transactionDone(readTransaction);

    const affected = records.filter((record) => (
      record.notebookPath === entryPath
      || record.notebookPath.startsWith(`${entryPath}/`)
    ));
    if (!affected.length) return;

    const writeTransaction = database.transaction(STORE_NAME, "readwrite");
    const store = writeTransaction.objectStore(STORE_NAME);
    for (const record of affected) {
      const notebookPath = `${nextEntryPath}${record.notebookPath.slice(entryPath.length)}`;
      store.delete(record.key);
      store.put({
        ...record,
        key: recoveryKey(workspace, notebookPath),
        notebookPath,
      } satisfies DocumentRecovery);
    }
    await transactionDone(writeTransaction);
  } finally {
    database.close();
  }
}
