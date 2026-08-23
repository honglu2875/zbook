const documentBase = new URL(".", window.location.href);
const launchToken = new URL(window.location.href).searchParams.get("token");

export function jupyterServerUrl(): URL {
  return new URL("../", documentBase);
}

export function jupyterAuthToken(): string {
  return launchToken ?? "";
}

function authenticated(url: URL): URL {
  if (launchToken && !url.searchParams.has("token")) url.searchParams.set("token", launchToken);
  return url;
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return null;
}

export function appUrl(path: string): URL {
  return authenticated(new URL(path.replace(/^\//, ""), documentBase));
}

export function jupyterUrl(path: string): URL {
  return authenticated(new URL(`../api/${path.replace(/^\//, "")}`, documentBase));
}

export function websocketUrl(path: string): URL {
  const url = appUrl(path);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

export function jupyterWebsocketUrl(path: string): URL {
  const url = jupyterUrl(path);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

export async function requestJson<T>(url: URL | string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const xsrf = readCookie("_xsrf");
  if (xsrf && init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase())) {
    headers.set("X-XSRFToken", xsrf);
  }

  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string; error?: string };
      detail = parsed.message ?? parsed.error ?? raw;
    } catch {
      // Keep the response text when it is not JSON.
    }
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  const raw = await response.text();
  return raw ? JSON.parse(raw) as T : undefined as T;
}

export function encodeApiPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}
