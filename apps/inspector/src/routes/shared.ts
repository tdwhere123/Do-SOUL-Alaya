import type { Context } from "hono";

export interface InspectorProxyOptions {
  readonly daemonUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly daemonRequestToken?: string;
  readonly reviewerToken?: string;
  readonly reviewerIdentity?: string;
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
    // gate-6-delta I2: opt in to forwarding the daemon's
    // {success: false, error: {code, message}} envelope verbatim on
    // 4xx/5xx so cross-surface parity holds for soul.* tools whose
    // error messages are closed-set workflow strings (no user-input
    // echo). Default is sanitise.
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
  if (request.method !== "GET" && options.daemonRequestToken !== undefined) {
    headers.set("x-request-token", options.daemonRequestToken);
    headers.set("x-alaya-desktop", "1");
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
    // gate-6-delta I2: by default we sanitise daemon error bodies so
    // free-text daemon validation messages cannot leak user-supplied
    // secrets through the inspector (see the embedding paste case in
    // routes.test.ts:157-179). Routes that route through the MCP
    // memory-tool handler — where the workflow returns a closed
    // {success: false, error: {code, message}} envelope — opt in to
    // verbatim forwarding so cross-surface parity with MCP/CLI holds
    // on the error path. The forwarder still narrows to the canonical
    // envelope shape; anything else falls back to the sanitised body.
    if (request.forwardStructuredError === true) {
      const safe = await tryReadStructuredErrorEnvelope(response);
      if (safe !== null) {
        return context.json(safe, response.status as 400 | 401 | 403 | 404 | 409 | 422 | 500);
      }
    }
    return context.json({ error: `daemon_${response.status}` }, response.status as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503);
  }

  const payload = await response.json() as unknown;
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
