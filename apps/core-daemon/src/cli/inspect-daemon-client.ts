import { createServer } from "node:net";
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  EXTERNAL_DAEMON_REQUEST_TOKEN_ENV
} from "./inspect-constants.js";
import { describeInspectError } from "./inspect-errors.js";
import type { AlayaCliContext } from "./bridge.js";
import type {
  DaemonRequestAuth,
  InspectCommandDependencies,
  InspectDaemonProbeResult,
  InspectDaemonServer,
  WorkspaceLookupResult,
  WorkspaceSummary
} from "./inspect-types.js";

export type WorkspaceResolution =
  | { readonly status: "ok"; readonly workspaceId: string }
  | { readonly status: "fail"; readonly exitCode: number };

export async function defaultCheckPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function defaultProbeDaemon(url: string, auth?: DaemonRequestAuth): Promise<InspectDaemonProbeResult> {
  const baseUrl = normalizeBaseUrl(url);
  try {
    const response = await fetch(new URL("/health", baseUrl), {
      method: "GET"
    });
    if (!response.ok) {
      return { status: "unavailable", detail: `health HTTP ${response.status}` };
    }
  } catch (error) {
    return { status: "unavailable", detail: describeInspectError(error) };
  }

  try {
    const capability = await fetch(new URL("/config/runtime/garden-compute", baseUrl), {
      ...buildDaemonRequestInit("GET", auth)
    });
    if (capability.ok) {
      return { status: "compatible" };
    }
    if (capability.status === 403) {
      return { status: "auth_required", detail: "HTTP 403" };
    }
    return { status: "missing_capability", detail: `HTTP ${capability.status}` };
  } catch (error) {
    return { status: "missing_capability", detail: describeInspectError(error) };
  }
}

export async function defaultListWorkspaces(
  daemonUrl: string,
  auth?: DaemonRequestAuth
): Promise<readonly WorkspaceSummary[]> {
  const baseUrl = normalizeBaseUrl(daemonUrl);
  const response = await fetch(new URL("workspaces", baseUrl), buildDaemonRequestInit("GET", auth));
  if (response.status === 403 && auth?.requestToken === undefined) {
    throw new Error(
      "daemon /workspaces requires request-token auth; set ALAYA_INSPECTOR_DAEMON_REQUEST_TOKEN or let `alaya inspect` manage the daemon"
    );
  }
  if (!response.ok) {
    throw new Error(`daemon /workspaces returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { readonly data?: unknown };
  const data = payload?.data;
  if (!Array.isArray(data)) {
    throw new Error("daemon /workspaces response did not include a data array");
  }
  return data.map((entry: unknown) => coerceWorkspaceSummary(entry));
}

export async function defaultGetWorkspaceById(
  daemonUrl: string,
  workspaceId: string,
  auth?: DaemonRequestAuth
): Promise<WorkspaceLookupResult> {
  const baseUrl = normalizeBaseUrl(daemonUrl);
  let response: Response;
  try {
    response = await fetch(new URL(`workspaces/${encodeURIComponent(workspaceId)}`, baseUrl), {
      ...buildDaemonRequestInit("GET", auth)
    });
  } catch (error) {
    return { status: "error", detail: describeInspectError(error) };
  }
  if (response.status === 404) {
    return { status: "not_found" };
  }
  if (response.status === 403 && auth?.requestToken === undefined) {
    return {
      status: "error",
      detail:
        "daemon requires request-token auth; set ALAYA_INSPECTOR_DAEMON_REQUEST_TOKEN or let `alaya inspect` manage the daemon"
    };
  }
  if (!response.ok) {
    return { status: "error", detail: `HTTP ${response.status}` };
  }
  // a 200 with unparseable JSON is a broken daemon, not an empty-ok workspace
  let payload: { readonly data?: unknown };
  try {
    payload = (await response.json()) as { readonly data?: unknown };
  } catch {
    return { status: "error", detail: "non-JSON response" };
  }
  return { status: "ok", workspace: coerceWorkspaceSummary(payload?.data) };
}

export async function ensureDaemonForInspector(
  ctx: AlayaCliContext,
  deps: InspectCommandDependencies,
  checkPortAvailable: (port: number) => Promise<boolean>,
  externalRequestToken: string | undefined
): Promise<{ readonly url: string; readonly startedDaemon: InspectDaemonServer | null }> {
  const configuredUrl = ctx.env.ALAYA_DAEMON_URL?.trim();
  if (configuredUrl !== undefined && configuredUrl.length > 0) {
    return { url: configuredUrl, startedDaemon: null };
  }

  const fallbackUrl = `http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}`;
  if (deps.startDaemonServer === undefined) {
    throw new Error("Inspector requires a managed daemon; start it through `alaya inspect` or set ALAYA_DAEMON_URL explicitly.");
  }

  if (!(await checkPortAvailable(DEFAULT_DAEMON_PORT))) {
    const probe = await (deps.probeDaemon ?? defaultProbeDaemon)(fallbackUrl, {
      requestToken: externalRequestToken
    });
    if (probe.status === "unavailable") {
      throw new Error(
        `daemon port ${DEFAULT_DAEMON_PORT} is in use but does not answer as Alaya; stop that process or set ALAYA_DAEMON_URL explicitly.`
      );
    }
    if (probe.status === "auth_required") {
      throw new Error(
        `daemon on ${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT} requires request-token auth; set ${EXTERNAL_DAEMON_REQUEST_TOKEN_ENV} or stop that daemon and rerun alaya inspect.`
      );
    }
    if (probe.status === "missing_capability") {
      throw new Error(
        `stale/incompatible daemon on ${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}: missing required /config/runtime/garden-compute capability${formatProbeDetail(probe.detail)}. Stop that daemon and rerun alaya inspect.`
      );
    }
    ctx.stderr.write(`daemon port ${DEFAULT_DAEMON_PORT} is in use; using existing daemon at ${fallbackUrl}\n`);
    return { url: fallbackUrl, startedDaemon: null };
  }

  const startedDaemon = await deps.startDaemonServer({
    hostname: DEFAULT_DAEMON_HOST,
    port: DEFAULT_DAEMON_PORT,
    allowEphemeralRequestToken: true
  });
  return {
    url: `http://${startedDaemon.hostname}:${startedDaemon.port}`,
    startedDaemon
  };
}

export function resolveDaemonRequestAuth(input: {
  readonly startedDaemon: boolean;
  readonly getRequestToken?: () => string | undefined;
  readonly externalRequestToken: string | undefined;
}): DaemonRequestAuth {
  return input.startedDaemon
    ? { requestToken: normalizeOptionalToken(input.getRequestToken?.()) }
    : { requestToken: input.externalRequestToken };
}

export function normalizeOptionalToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function formatProbeDetail(detail: string | undefined): string {
  return detail === undefined || detail.trim().length === 0 ? "" : ` (${detail.trim()})`;
}

function coerceWorkspaceSummary(value: unknown): WorkspaceSummary {
  const record = (value ?? {}) as Record<string, unknown>;
  const workspaceId = typeof record.workspace_id === "string" ? record.workspace_id : "";
  const name = typeof record.name === "string" ? record.name : null;
  const repoPath = typeof record.repo_path === "string" ? record.repo_path : null;
  const state = typeof record.workspace_state === "string" ? record.workspace_state : "unknown";
  return {
    workspace_id: workspaceId,
    name,
    repo_path: repoPath,
    workspace_state: state
  };
}

function buildDaemonRequestInit(
  method: "GET" | "PATCH" | "POST",
  auth?: DaemonRequestAuth
): Readonly<{ readonly method: "GET" | "PATCH" | "POST"; readonly headers?: Headers }> {
  const headers = buildDaemonRequestHeaders(auth);
  return headers === undefined ? { method } : { method, headers };
}

function buildDaemonRequestHeaders(auth?: DaemonRequestAuth): Headers | undefined {
  if (auth?.requestToken === undefined) {
    return undefined;
  }
  const headers = new Headers();
  headers.set("x-request-token", auth.requestToken);
  headers.set("x-alaya-desktop", "1");
  return headers;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
