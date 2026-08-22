import type { RawNotebook } from "../model/notebook";
import { encodeApiPath, jupyterUrl, requestJson } from "./http";

export type ContentType = "directory" | "file" | "notebook";

export interface ContentEntry {
  name: string;
  path: string;
  type: ContentType;
  writable: boolean;
  created: string;
  last_modified: string;
  mimetype: string | null;
  format: "json" | "text" | "base64" | null;
  content?: ContentEntry[] | RawNotebook | string | null;
}

function contentsUrl(path = ""): URL {
  const suffix = encodeApiPath(path);
  return jupyterUrl(`contents${suffix ? `/${suffix}` : ""}`);
}

export async function listDirectory(path = "", refresh = false): Promise<ContentEntry[]> {
  const url = contentsUrl(path);
  url.searchParams.set("content", "1");
  url.searchParams.set("type", "directory");
  if (refresh) url.searchParams.set("_refresh", String(Date.now()));
  const model = await requestJson<ContentEntry>(url, refresh ? { cache: "no-store" } : {});
  if (model.type !== "directory" || !Array.isArray(model.content)) {
    throw new Error(`${path || "Workspace"} is not a directory`);
  }
  return [...model.content].sort((left, right) => {
    if (left.type === "directory" && right.type !== "directory") return -1;
    if (right.type === "directory" && left.type !== "directory") return 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

export async function readNotebook(path: string): Promise<ContentEntry> {
  const url = contentsUrl(path);
  url.searchParams.set("content", "1");
  url.searchParams.set("type", "notebook");
  // Notebook contents can be changed by Codex or another process.  Both the
  // query nonce and fetch policy are intentional: intermediary caches should
  // never turn Reload into a no-op.
  url.searchParams.set("_refresh", String(Date.now()));
  const model = await requestJson<ContentEntry>(url, { cache: "no-store" });
  if (model.type !== "notebook" || !model.content || Array.isArray(model.content)) {
    throw new Error(`${path} is not a notebook`);
  }
  return model;
}

export async function createNotebook(parent = ""): Promise<ContentEntry> {
  return requestJson<ContentEntry>(contentsUrl(parent), {
    method: "POST",
    body: JSON.stringify({ type: "notebook" }),
  });
}

export async function createDirectory(path: string): Promise<ContentEntry> {
  return requestJson<ContentEntry>(contentsUrl(path), {
    method: "PUT",
    body: JSON.stringify({ type: "directory" }),
  });
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`Could not encode ${file.name}`));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function uploadFile(parent: string, file: File): Promise<ContentEntry> {
  const path = parent ? `${parent}/${file.name}` : file.name;
  if (file.name.toLowerCase().endsWith(".ipynb")) {
    let notebook: RawNotebook;
    try {
      notebook = JSON.parse(await file.text()) as RawNotebook;
    } catch (error) {
      throw new Error(`${file.name} is not valid notebook JSON: ${String(error)}`);
    }
    return requestJson<ContentEntry>(contentsUrl(path), {
      method: "PUT",
      body: JSON.stringify({ type: "notebook", format: "json", content: notebook }),
    });
  }
  return requestJson<ContentEntry>(contentsUrl(path), {
    method: "PUT",
    body: JSON.stringify({ type: "file", format: "base64", content: await fileAsBase64(file) }),
  });
}

export async function saveNotebook(path: string, content: RawNotebook): Promise<ContentEntry> {
  return requestJson<ContentEntry>(contentsUrl(path), {
    method: "PUT",
    body: JSON.stringify({ type: "notebook", format: "json", content }),
  });
}

export async function renameEntry(path: string, newPath: string): Promise<ContentEntry> {
  return requestJson<ContentEntry>(contentsUrl(path), {
    method: "PATCH",
    body: JSON.stringify({ path: newPath }),
  });
}

export async function deleteEntry(path: string): Promise<void> {
  await requestJson<unknown>(contentsUrl(path), { method: "DELETE" });
}
