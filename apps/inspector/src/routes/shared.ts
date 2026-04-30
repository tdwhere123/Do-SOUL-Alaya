import type { Context } from "hono";

export interface InspectorProxyOptions {
  readonly daemonUrl: string;
  readonly fetchImpl?: typeof fetch;
}

export async function proxyDaemonJson(
  context: Context,
  options: InspectorProxyOptions,
  request: {
    readonly method: "GET" | "PATCH";
    readonly path: string;
    readonly body?: unknown;
  }
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const daemonUrl = new URL(request.path, normalizeBaseUrl(options.daemonUrl));
  const response = await fetchImpl(daemonUrl, {
    method: request.method,
    headers: request.body === undefined ? undefined : { "content-type": "application/json" },
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
