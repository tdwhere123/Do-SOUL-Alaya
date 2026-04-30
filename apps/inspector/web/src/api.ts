/**
 * api.ts - Thin fetch wrapper for Alaya Inspector
 */

let inspectorToken: string | null = null;
let currentWorkspaceId: string | null = null;

export const setInspectorToken = (token: string) => {
  inspectorToken = token;
};

export const getInspectorToken = () => inspectorToken;

export const setWorkspaceId = (id: string) => {
  currentWorkspaceId = id;
};

export const getWorkspaceId = () => currentWorkspaceId;

export interface ApiRequestOptions extends RequestInit {
  params?: Record<string, string>;
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { params, headers, ...rest } = options;
  
  // Inject workspaceId into path if :workspaceId placeholder exists
  let resolvedPath = path;
  if (currentWorkspaceId) {
    resolvedPath = path.replace(':workspaceId', currentWorkspaceId);
  }

  let url = resolvedPath.startsWith('http') ? resolvedPath : `/api${resolvedPath}`;
  
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += (url.includes('?') ? '&' : '?') + searchParams.toString();
  }

  const response = await fetch(url, {
    ...rest,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...(inspectorToken ? { 'X-Alaya-Inspector-Token': inspectorToken } : {}),
    },
  });

  if (response.status === 401) {
    const error = new Error('Unauthorized: Please re-run `alaya inspect` to get a fresh token.');
    (error as any).status = 401;
    throw error;
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `API Error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
