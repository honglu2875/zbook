import { appUrl, requestJson } from "./http";

export interface InstalledPackage {
  name: string;
  version: string;
  editable_project_location?: string;
}

export interface KernelReadiness {
  ready: boolean;
  version: string | null;
  python_version?: string | null;
  error: string | null;
}

export interface EnvironmentCandidate {
  path: string;
  project: string | null;
  label: string;
  active: boolean;
  temporary: boolean;
}

interface EnvironmentsResponse {
  ok: boolean;
  active: string;
  candidates: EnvironmentCandidate[];
}

interface PackageListResponse {
  ok: boolean;
  packages: InstalledPackage[];
}

export interface MutationResponse {
  ok: boolean;
  lines: string[];
  kernel?: KernelReadiness;
}

export async function listPackages(): Promise<InstalledPackage[]> {
  const response = await requestJson<PackageListResponse>(appUrl("api/packages"));
  return response.packages;
}

export function installPackage(requirement: string): Promise<MutationResponse> {
  return requestJson<MutationResponse>(appUrl("api/packages"), {
    method: "POST",
    body: JSON.stringify({ requirement }),
  });
}

export function uninstallPackage(name: string): Promise<MutationResponse> {
  return requestJson<MutationResponse>(appUrl(`api/packages/${encodeURIComponent(name)}`), {
    method: "DELETE",
  });
}

export function prepareKernel(): Promise<MutationResponse> {
  return requestJson<MutationResponse>(appUrl("api/kernel/prepare"), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function listEnvironments(): Promise<EnvironmentsResponse> {
  return requestJson<EnvironmentsResponse>(appUrl("api/environments"));
}

export function selectEnvironment(path: string): Promise<unknown> {
  return requestJson<unknown>(appUrl("api/environments"), {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}
