import type { Context } from "hono";
import {
  INSPECTOR_CORRELATION_ID_HEADER,
  INSPECTOR_REQUEST_ID_HEADER
} from "../runtime/app.js";

export interface InspectorProxyOptions {
  readonly daemonUrl: string;
  readonly workspaceId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly daemonRequestToken?: string;
  readonly reviewerToken?: string;
  readonly reviewerIdentity?: string;
}

export function isRequestBodyTooLargeError(error: unknown): boolean {
  return readStatusCode(error) === 413 || readErrorName(error) === "BodyLimitError";
}

export async function rejectUnexpectedRequestBody(context: Context): Promise<Response | null> {
  const outcome = await inspectUnexpectedRequestBody(context);

  if (outcome === "none") {
    return null;
  }

  if (outcome === "too_large") {
    return context.json({ error: "request_body_too_large" }, 413);
  }

  return context.json({ error: "invalid_request" }, 400);
}

export function assertInspectorWorkspace(
  context: Context,
  options: InspectorProxyOptions,
  workspaceId: string | undefined
): Response | null {
  const expected = options.workspaceId?.trim();
  const provided = workspaceId;
  if (expected === undefined || expected.length === 0) {
    return context.json({ error: "workspace_binding_missing" }, 500);
  }
  if (provided === undefined || provided.length === 0) {
    return context.json({ error: "workspace_required" }, 400);
  }
  if (provided !== expected) {
    return context.json({ error: "workspace_forbidden" }, 403);
  }
  return null;
}

export async function proxyDaemonJson(
  context: Context,
  options: InspectorProxyOptions,
  request: {
    // A1 (HITL daemon backbone): POST is added so the Inspector can
    // forward accept/reject calls to the workspace-scoped daemon HTTP
    // wrapper around soul.review_memory_proposal.
    readonly method: "GET" | "PATCH" | "POST";
    readonly path: string;
    readonly body?: unknown;
    // Opt in to forwarding the daemon's {success: false, error:
    // {code, message}} envelope verbatim on 4xx/5xx so cross-surface
    // parity holds for soul.* tools whose error messages are closed-set
    // workflow strings. Default is sanitise.
    readonly forwardStructuredError?: boolean;
  }
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const daemonUrl = new URL(request.path, normalizeBaseUrl(options.daemonUrl));
  const headers = new Headers();
  let hasHeaders = false;
  if (request.body !== undefined) {
    headers.set("content-type", "application/json");
    hasHeaders = true;
  }
  if (options.daemonRequestToken !== undefined) {
    headers.set("x-request-token", options.daemonRequestToken);
    headers.set("x-alaya-desktop", "1");
    hasHeaders = true;
  }
  const requestId = readRequestId(context);
  if (requestId !== undefined) {
    headers.set(INSPECTOR_REQUEST_ID_HEADER, requestId);
    headers.set(INSPECTOR_CORRELATION_ID_HEADER, requestId);
    hasHeaders = true;
  }
  const response = await fetchImpl(daemonUrl, {
    method: request.method,
    headers: hasHeaders ? headers : undefined,
    body: request.body === undefined ? undefined : JSON.stringify(request.body)
  }).catch(() => null);

  if (response === null) {
    return context.json({ error: "daemon_unavailable" }, 503);
  }

  if (!response.ok) {
    // By default we sanitise daemon error bodies so free-text daemon
    // validation messages cannot leak user-supplied secrets through the
    // inspector. Routes that route through the MCP memory-tool handler
    // can opt in to verbatim forwarding because that workflow returns a
    // closed {success: false, error: {code, message}} envelope. The
    // forwarder still narrows to the canonical envelope shape; anything
    // else falls back to the sanitised body.
    if (request.forwardStructuredError === true) {
      const safe = await tryReadStructuredErrorEnvelope(response);
      if (safe !== null) {
        copyTraceHeaders(context, response, requestId);
        return context.json(safe, response.status as 400 | 401 | 403 | 404 | 409 | 422 | 500);
      }
    }
    copyTraceHeaders(context, response, requestId);
    return context.json({ error: `daemon_${response.status}` }, response.status as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503);
  }

  const payload = await response.json() as unknown;
  copyTraceHeaders(context, response, requestId);
  return context.json(payload, response.status as 200);
}

const KNOWN_WORKFLOW_ERROR_CODES = new Set([
  "NOT_FOUND",
  "VALIDATION",
  "NEEDS_CONTEXT",
  "UNKNOWN_TOOL"
]);

async function tryReadStructuredErrorEnvelope(
  response: Response
): Promise<{ readonly success: false; readonly error: { readonly code: string; readonly message: string } } | null> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const candidate = payload as { readonly success?: unknown; readonly error?: unknown };
  if (candidate.success !== false) {
    return null;
  }
  const error = candidate.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return null;
  }
  const errorObject = error as { readonly code?: unknown; readonly message?: unknown };
  if (typeof errorObject.code !== "string" || !KNOWN_WORKFLOW_ERROR_CODES.has(errorObject.code)) {
    return null;
  }
  if (typeof errorObject.message !== "string") {
    return null;
  }
  return {
    success: false,
    error: { code: errorObject.code, message: errorObject.message }
  };
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function readRequestId(context: Context): string | undefined {
  const requestId = context.get("requestId");
  return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

function copyTraceHeaders(context: Context, response: Response, fallbackRequestId: string | undefined): void {
  const requestId =
    response.headers.get(INSPECTOR_REQUEST_ID_HEADER) ??
    response.headers.get(INSPECTOR_CORRELATION_ID_HEADER) ??
    fallbackRequestId;
  if (requestId !== null && requestId !== undefined && requestId.length > 0) {
    context.header(INSPECTOR_REQUEST_ID_HEADER, requestId);
    context.header(INSPECTOR_CORRELATION_ID_HEADER, requestId);
  }
  copyHeaderIfPresent(context, response, "x-total-count");
  copyHeaderIfPresent(context, response, "x-limit");
  copyHeaderIfPresent(context, response, "x-offset");
}

function copyHeaderIfPresent(context: Context, response: Response, name: string): void {
  const value = response.headers.get(name);
  if (value !== null && value.length > 0) {
    context.header(name, value);
  }
}

async function inspectUnexpectedRequestBody(context: Context): Promise<"none" | "unexpected" | "too_large"> {
  const declaredLength = readDeclaredLength(context.req.header("content-length"));
  if (declaredLength !== null && declaredLength > 10 * 1024 * 1024) {
    return "too_large";
  }

  const transferEncoding = normalizeOptionalHeader(context.req.header("transfer-encoding"));
  const body = context.req.raw.body;
  if (body === null) {
    if ((declaredLength ?? 0) > 0 || transferEncoding !== undefined) {
      return "unexpected";
    }
    return "none";
  }

  const reader = body.getReader();
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > 10 * 1024 * 1024) {
        return "too_large";
      }
    }
  } catch (error) {
    if (isRequestBodyTooLargeError(error)) {
      return "too_large";
    }
    throw error;
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  if (total > 0 || (declaredLength ?? 0) > 0 || transferEncoding !== undefined) {
    return "unexpected";
  }

  return "none";
}

function readStatusCode(error: unknown): number | null {
  if (error === null || typeof error !== "object") {
    return null;
  }

  const candidate = error as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly cause?: unknown;
  };

  if (typeof candidate.status === "number") {
    return candidate.status;
  }

  if (typeof candidate.statusCode === "number") {
    return candidate.statusCode;
  }

  return candidate.cause === undefined ? null : readStatusCode(candidate.cause);
}

function readErrorName(error: unknown): string | null {
  if (error instanceof Error) {
    return error.name;
  }

  if (error === null || typeof error !== "object") {
    return null;
  }

  const candidate = error as { readonly cause?: unknown };
  return candidate.cause === undefined ? null : readErrorName(candidate.cause);
}

function readDeclaredLength(header: string | undefined): number | null {
  if (header === undefined) {
    return null;
  }

  const parsed = Number.parseInt(header, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionalHeader(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
