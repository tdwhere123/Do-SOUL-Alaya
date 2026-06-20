import type { Context } from "hono";
import {
  INSPECTOR_CORRELATION_ID_HEADER,
  INSPECTOR_REQUEST_ID_HEADER
} from "../runtime/app.js";
export {
  isRequestBodyTooLargeError,
  rejectUnexpectedRequestBody
} from "./request-body-guard.js";

export interface InspectorProxyOptions {
  readonly daemonUrl: string;
  readonly workspaceId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly daemonTimeoutMs?: number;
  readonly daemonRequestToken?: string;
  readonly reviewerToken?: string;
  readonly reviewerIdentity?: string;
}

const DEFAULT_DAEMON_PROXY_TIMEOUT_MS = 10_000;

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

interface ProxyDaemonRequest {
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

interface ProxyInvocation {
  readonly fetchImpl: typeof fetch;
  readonly daemonUrl: URL;
  readonly headers?: Headers;
  readonly requestId: string | undefined;
  readonly timeout: DaemonTimeoutHandle;
  readonly controller: AbortController;
}

interface DaemonTimeoutHandle {
  readonly clear: () => void;
  readonly didTimeout: () => boolean;
  readonly timeout: Promise<"timeout">;
}

export async function proxyDaemonJson(
  context: Context,
  options: InspectorProxyOptions,
  request: ProxyDaemonRequest
): Promise<Response> {
  const invocation = createProxyInvocation(context, options, request);
  try {
    const response = await fetchProxyResponse(invocation, request);
    if (response === "timeout") {
      return daemonTimeoutResponse(context, invocation.requestId);
    }
    return await forwardProxyResponse(context, request, invocation, response);
  } finally {
    invocation.timeout.clear();
  }
}

function createProxyInvocation(
  context: Context,
  options: InspectorProxyOptions,
  request: ProxyDaemonRequest
): ProxyInvocation {
  const controller = new AbortController();
  const timeoutMs = options.daemonTimeoutMs ?? DEFAULT_DAEMON_PROXY_TIMEOUT_MS;
  const requestId = readRequestId(context);
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    daemonUrl: new URL(request.path, normalizeBaseUrl(options.daemonUrl)),
    headers: buildProxyHeaders(options, request, requestId),
    requestId,
    timeout: startDaemonTimeout(controller, timeoutMs),
    controller
  };
}

function buildProxyHeaders(
  options: InspectorProxyOptions,
  request: ProxyDaemonRequest,
  requestId: string | undefined
): Headers | undefined {
  const headers = new Headers();
  if (request.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.daemonRequestToken !== undefined) {
    headers.set("x-request-token", options.daemonRequestToken);
    headers.set("x-alaya-desktop", "1");
  }
  if (requestId !== undefined) {
    headers.set(INSPECTOR_REQUEST_ID_HEADER, requestId);
    headers.set(INSPECTOR_CORRELATION_ID_HEADER, requestId);
  }
  return Array.from(headers).length > 0 ? headers : undefined;
}

async function fetchProxyResponse(
  invocation: ProxyInvocation,
  request: ProxyDaemonRequest
): Promise<Response | null | "timeout"> {
  return await Promise.race([
    fetchDaemonJson({
      fetchImpl: invocation.fetchImpl,
      url: invocation.daemonUrl,
      method: request.method,
      headers: invocation.headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: invocation.controller.signal
    }).catch((error) => {
      if (invocation.timeout.didTimeout() && isAbortError(error)) return "timeout" as const;
      throw error;
    }),
    invocation.timeout.timeout
  ]);
}

async function forwardProxyResponse(
  context: Context,
  request: ProxyDaemonRequest,
  invocation: ProxyInvocation,
  response: Response | null
): Promise<Response> {
  if (response === null) return daemonUnavailableResponse(context, invocation.requestId);
  if (!response.ok) return await daemonErrorResponse(context, request, invocation, response);
  return await daemonSuccessResponse(context, invocation, response);
}

async function daemonErrorResponse(
  context: Context,
  request: ProxyDaemonRequest,
  invocation: ProxyInvocation,
  response: Response
): Promise<Response> {
  if (request.forwardStructuredError === true) {
    const safe = await readStructuredErrorWithTimeout(response, invocation.timeout);
    if (safe === "timeout") return daemonTimeoutResponse(context, invocation.requestId, response);
    if (safe !== null) {
      copyTraceHeaders(context, response, invocation.requestId);
      return context.json(safe, response.status as 400 | 401 | 403 | 404 | 409 | 422 | 500);
    }
  }
  copyTraceHeaders(context, response, invocation.requestId);
  return context.json(
    { error: `daemon_${response.status}` },
    response.status as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503
  );
}

async function daemonSuccessResponse(
  context: Context,
  invocation: ProxyInvocation,
  response: Response
): Promise<Response> {
  const payload = await Promise.race([
    readDaemonJson(response, invocation.timeout.didTimeout),
    invocation.timeout.timeout
  ]);
  if (payload === "timeout") return daemonTimeoutResponse(context, invocation.requestId, response);
  copyTraceHeaders(context, response, invocation.requestId);
  return context.json(payload, response.status as 200);
}

function daemonTimeoutResponse(
  context: Context,
  requestId: string | undefined,
  response?: Response
): Response {
  if (response === undefined) copyFallbackTraceHeaders(context, requestId);
  else copyTraceHeaders(context, response, requestId);
  return context.json({ error: "daemon_timeout" }, 504);
}

function daemonUnavailableResponse(context: Context, requestId: string | undefined): Response {
  copyFallbackTraceHeaders(context, requestId);
  return context.json({ error: "daemon_unavailable" }, 503);
}

const KNOWN_WORKFLOW_ERROR_CODES = new Set([
  "NOT_FOUND",
  "VALIDATION",
  "NEEDS_CONTEXT",
  "UNKNOWN_TOOL"
]);

async function tryReadStructuredErrorEnvelope(
  response: Response,
  didTimeout: () => boolean
): Promise<
  { readonly success: false; readonly error: { readonly code: string; readonly message: string } } | null | "timeout"
> {
  const payload = await readDaemonJson(response, didTimeout);
  if (payload === "timeout") {
    return "timeout";
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

async function readStructuredErrorWithTimeout(
  response: Response,
  timeout: DaemonTimeoutHandle
): Promise<
  { readonly success: false; readonly error: { readonly code: string; readonly message: string } } | null | "timeout"
> {
  return await Promise.race([
    tryReadStructuredErrorEnvelope(response, timeout.didTimeout),
    timeout.timeout
  ]);
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function fetchDaemonJson(input: {
  readonly fetchImpl: typeof fetch;
  readonly url: URL;
  readonly method: "GET" | "PATCH" | "POST";
  readonly headers?: Headers;
  readonly body?: string;
  readonly signal: AbortSignal;
}): Promise<Response | null> {
  try {
    return await input.fetchImpl(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: input.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return null;
  }
}

async function readDaemonJson(
  response: Response,
  didTimeout: () => boolean
): Promise<unknown | "timeout"> {
  try {
    return await response.json();
  } catch (error) {
    if (didTimeout() && isAbortError(error)) {
      return "timeout";
    }
    throw error;
  }
}

function startDaemonTimeout(
  controller: AbortController,
  timeoutMs: number
): DaemonTimeoutHandle {
  let timedOut = false;
  let clearTimer = () => {};
  const timeout = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
    clearTimer = () => clearTimeout(timer);
  });
  return {
    clear: () => clearTimer(),
    didTimeout: () => timedOut,
    timeout
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function readRequestId(context: Context): string | undefined {
  const requestId = context.get("requestId");
  return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

function copyFallbackTraceHeaders(context: Context, requestId: string | undefined): void {
  if (requestId !== undefined && requestId.length > 0) {
    context.header(INSPECTOR_REQUEST_ID_HEADER, requestId);
    context.header(INSPECTOR_CORRELATION_ID_HEADER, requestId);
  }
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
