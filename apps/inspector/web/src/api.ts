/**
 * api.ts - Thin fetch wrapper for Alaya Inspector
 *
 * Single source of every HTTP call (Reviewer Gate G3). Pages MUST go through
 * `apiFetch`. Adds: token injection, workspaceId path interpolation, GET 5xx
 * retry-once with exponential backoff, and a global 401 handler for the
 * SessionExpired surface.
 */

let inspectorToken: string | null = null;
let currentWorkspaceId: string | null = null;
let onUnauthorized: (() => void) | null = null;

export const setInspectorToken = (token: string) => {
  inspectorToken = token;
};

export const getInspectorToken = () => inspectorToken;

export const setWorkspaceId = (id: string | null) => {
  currentWorkspaceId = id;
};

export const getWorkspaceId = () => currentWorkspaceId;

export const setUnauthorizedHandler = (handler: (() => void) | null) => {
  onUnauthorized = handler;
};

export interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  params?: Record<string, string>;
  body?: unknown;
}

export interface ApiError extends Error {
  status?: number;
}

const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { params, headers, body, method = "GET", ...rest } = options;

  let resolvedPath = path;
  if (currentWorkspaceId) {
    resolvedPath = path.replace(":workspaceId", currentWorkspaceId);
  }

  let url = resolvedPath.startsWith("http") ? resolvedPath : `/api${resolvedPath}`;

  if (params) {
    const searchParams = new URLSearchParams(params);
    url += (url.includes("?") ? "&" : "?") + searchParams.toString();
  }

  const init: RequestInit = {
    ...rest,
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(inspectorToken ? { "X-Alaya-Inspector-Token": inspectorToken } : {}),
      ...(headers ?? {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  };

  const canRetry = RETRYABLE_METHODS.has(method.toUpperCase());
  const maxAttempts = canRetry ? 2 : 1;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await sleep(200 * Math.pow(5, attempt - 1));
        continue;
      }
      throw err;
    }

    if (response.status === 401) {
      onUnauthorized?.();
      const error = new Error(
        "Unauthorized: Please re-run `alaya inspect` to get a fresh token."
      ) as ApiError;
      error.status = 401;
      throw error;
    }

    if (response.status >= 500 && response.status < 600 && attempt < maxAttempts) {
      await sleep(200 * Math.pow(5, attempt - 1));
      continue;
    }

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as {
        readonly message?: unknown;
        readonly error?: unknown;
      };
      const error = new Error(
        extractApiErrorMessage(errorData) ??
          `API Error: ${response.status} ${response.statusText}`
      ) as ApiError;
      error.status = response.status;
      throw error;
    }

    return response.json() as Promise<T>;
  }

  throw lastError instanceof Error ? lastError : new Error("apiFetch exhausted retries");
}

function extractApiErrorMessage(errorData: {
  readonly message?: unknown;
  readonly error?: unknown;
}): string | null {
  if (typeof errorData.message === "string" && errorData.message.trim().length > 0) {
    return errorData.message;
  }
  if (typeof errorData.error === "string" && errorData.error.trim().length > 0) {
    return errorData.error;
  }
  if (
    errorData.error !== null &&
    typeof errorData.error === "object" &&
    "message" in errorData.error
  ) {
    const message = (errorData.error as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return null;
}
