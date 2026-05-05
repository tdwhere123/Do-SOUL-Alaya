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
  });

  if (!response.ok) {
    return context.json({ error: `daemon_${response.status}` }, response.status as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503);
  }

  const payload = await response.json() as unknown;
  return context.json(payload, response.status as 200);
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
