import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { platform, release } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "./bridge.js";

export interface InspectCommandDependencies {
  readonly generateToken?: () => string;
  readonly getRequestToken?: () => string | undefined;
  readonly spawnInspector?: (input: SpawnInspectorInput) => InspectorChildProcess;
  readonly startDaemonServer?: (options: InspectDaemonListenOptions) => Promise<InspectDaemonServer>;
  readonly probeDaemon?: (url: string, auth?: DaemonRequestAuth) => Promise<InspectDaemonProbeResult>;
  readonly checkPortAvailable?: (port: number) => Promise<boolean>;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly inspectorEntryPath?: string;
  readonly listWorkspaces?: (
    daemonUrl: string,
    auth?: DaemonRequestAuth
  ) => Promise<readonly WorkspaceSummary[]>;
  readonly getWorkspaceById?: (
    daemonUrl: string,
    workspaceId: string,
    auth?: DaemonRequestAuth
  ) => Promise<WorkspaceLookupResult>;
}

export interface WorkspaceSummary {
  readonly workspace_id: string;
  readonly name: string | null;
  readonly repo_path: string | null;
  readonly workspace_state: string;
}

export type WorkspaceLookupResult =
  | { readonly status: "ok"; readonly workspace: WorkspaceSummary }
  | { readonly status: "not_found" }
  | { readonly status: "error"; readonly detail?: string };

export interface InspectDaemonListenOptions {
  readonly hostname?: string;
  readonly port?: number;
  readonly allowEphemeralRequestToken?: boolean;
}

export interface InspectDaemonServer {
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

export type InspectDaemonProbeResult =
  | { readonly status: "compatible" }
  | { readonly status: "unavailable"; readonly detail?: string }
  | { readonly status: "auth_required"; readonly detail?: string }
  | { readonly status: "missing_capability"; readonly detail?: string };

interface DaemonRequestAuth {
  readonly requestToken?: string;
}

export interface SpawnInspectorInput {
  readonly port: number;
  readonly token: string;
  readonly workspaceId: string;
  readonly inspectorEntryPath: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface InspectorChildProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface BrowserOpenerChildProcess {
  unref(): void;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type BrowserOpenerSpawn = (
  command: string,
  args: readonly string[]
) => BrowserOpenerChildProcess;

interface InspectArgs {
  readonly open: boolean;
  readonly port: number;
  readonly token: string | null;
  readonly workspace: string | null;
}

const DEFAULT_INSPECTOR_PORT = 5174;
const DEFAULT_DAEMON_HOST = "127.0.0.1";
const DEFAULT_DAEMON_PORT = 5173;
const READY_LINE = "inspector_ready";
const SHUTDOWN_TIMEOUT_MS = 2000;
const ALLOW_FIXED_TOKEN_ENV = "ALAYA_INSPECTOR_ALLOW_FIXED_TOKEN";
const EXTERNAL_DAEMON_REQUEST_TOKEN_ENV = "ALAYA_INSPECTOR_DAEMON_REQUEST_TOKEN";
const INSPECTOR_CHILD_ENV_KEYS = ["ALAYA_DAEMON_URL", "ALAYA_REQUEST_TOKEN"] as const;

export function createInspectCommand(deps: InspectCommandDependencies = {}): AlayaSubcommandSpec<InspectArgs> {
  return {
    name: "inspect",
    description: "Start the loopback memory Inspector server.",
    argsSchema: inspectArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => await executeInspect(ctx, args, deps)
  };
}

async function executeInspect(
  ctx: AlayaCliContext,
  args: InspectArgs,
  deps: InspectCommandDependencies
): Promise<AlayaCliResult> {
  const checkPortAvailable = deps.checkPortAvailable ?? defaultCheckPortAvailable;
  if (!(await checkPortAvailable(args.port))) {
    ctx.stderr.write(`port ${args.port} in use; try alaya inspect --port ${args.port + 1}\n`);
    return { exitCode: ALAYA_SYSEXITS.TEMPFAIL };
  }

  if (args.token !== null && !fixedTokenOverrideAllowed(ctx.env)) {
    ctx.stderr.write(`--token is test-only; set ${ALLOW_FIXED_TOKEN_ENV}=1 to allow a fixed Inspector token\n`);
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }

  const token = args.token ?? (deps.generateToken ?? defaultGenerateToken)();
  let child: InspectorChildProcess | null = null;
  let startedDaemon: InspectDaemonServer | null = null;

  try {
    const externalDaemonRequestToken = normalizeOptionalToken(
      ctx.env[EXTERNAL_DAEMON_REQUEST_TOKEN_ENV]
    );
    const daemon = await ensureDaemonForInspector(
      ctx,
      deps,
      checkPortAvailable,
      externalDaemonRequestToken
    );
    startedDaemon = daemon.startedDaemon;
    const daemonRequestAuth = resolveDaemonRequestAuth({
      startedDaemon: daemon.startedDaemon !== null,
      getRequestToken: deps.getRequestToken,
      externalRequestToken: externalDaemonRequestToken
    });
    const workspaceResolution = await resolveWorkspaceForInspector(
      ctx,
      deps,
      daemon.url,
      args.workspace,
      daemonRequestAuth
    );
    if (workspaceResolution.status !== "ok") {
      return { exitCode: workspaceResolution.exitCode };
    }
    const url =
      `http://127.0.0.1:${args.port}/?workspaceId=${encodeURIComponent(workspaceResolution.workspaceId)}` +
      `#token=${encodeURIComponent(token)}`;
    const inspectorEnv: NodeJS.ProcessEnv = { ALAYA_DAEMON_URL: daemon.url };
    if (daemonRequestAuth.requestToken !== undefined) {
      inspectorEnv.ALAYA_REQUEST_TOKEN = daemonRequestAuth.requestToken;
    }
    child = (deps.spawnInspector ?? defaultSpawnInspector)({
      port: args.port,
      token,
      workspaceId: workspaceResolution.workspaceId,
      inspectorEntryPath: deps.inspectorEntryPath ?? defaultInspectorEntryPath(),
      env: inspectorEnv
    });
    await waitForInspectorReady(child, ctx);
    ctx.stdout.write(`${url}\n`);
    if (args.open) {
      await (deps.openUrl ?? defaultOpenUrl)(url).catch((error) => {
        ctx.stderr.write(`could not open browser automatically; copy the printed URL manually (${describeError(error)})\n`);
      });
    }
    await waitForChildExitOrSignal(child);
    return { exitCode: ALAYA_SYSEXITS.OK, json: { url, port: args.port } };
  } catch (error) {
    child?.kill("SIGTERM");
    ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: ALAYA_SYSEXITS.SOFTWARE };
  } finally {
    if (startedDaemon !== null) {
      await startedDaemon.close().catch((error) => {
        ctx.stderr.write(`failed to stop Inspector daemon: ${describeError(error)}\n`);
      });
    }
  }
}

type WorkspaceResolution =
  | { readonly status: "ok"; readonly workspaceId: string }
  | { readonly status: "fail"; readonly exitCode: number };

async function resolveWorkspaceForInspector(
  ctx: AlayaCliContext,
  deps: InspectCommandDependencies,
  daemonUrl: string,
  explicitId: string | null,
  auth?: DaemonRequestAuth
): Promise<WorkspaceResolution> {
  if (explicitId !== null) {
    const trimmed = explicitId.trim();
    const lookup = await (deps.getWorkspaceById ?? defaultGetWorkspaceById)(daemonUrl, trimmed, auth);
    if (lookup.status === "ok") {
      return { status: "ok", workspaceId: lookup.workspace.workspace_id };
    }
    if (lookup.status === "not_found") {
      ctx.stderr.write(
        `workspace "${trimmed}" not found in daemon; run 'alaya install' inside the project root, or rerun without --workspace to auto-select / list candidates.\n`
      );
      return { status: "fail", exitCode: ALAYA_SYSEXITS.USAGE };
    }
    ctx.stderr.write(
      `failed to verify workspace "${trimmed}" against daemon${formatProbeDetail(lookup.detail)}.\n`
    );
    return { status: "fail", exitCode: ALAYA_SYSEXITS.SOFTWARE };
  }

  let workspaces: readonly WorkspaceSummary[];
  try {
    workspaces = await (deps.listWorkspaces ?? defaultListWorkspaces)(daemonUrl, auth);
  } catch (error) {
    ctx.stderr.write(`failed to list workspaces from daemon: ${describeError(error)}\n`);
    return { status: "fail", exitCode: ALAYA_SYSEXITS.SOFTWARE };
  }

  const active = workspaces.filter((ws) => ws.workspace_state === "active");
  if (active.length === 0) {
    ctx.stderr.write(
      "no active workspace registered; run 'alaya install' inside your project root first.\n"
    );
    return { status: "fail", exitCode: ALAYA_SYSEXITS.SOFTWARE };
  }
  if (active.length === 1) {
    return { status: "ok", workspaceId: active[0]!.workspace_id };
  }

  const normalizedCwd = nodePath.resolve(ctx.cwd);
  const cwdMatches = active.filter(
    (ws) =>
      typeof ws.repo_path === "string" &&
      ws.repo_path.trim().length > 0 &&
      nodePath.resolve(ws.repo_path) === normalizedCwd
  );
  if (cwdMatches.length === 1) {
    const match = cwdMatches[0]!;
    const label = match.name?.trim().length ? match.name : match.workspace_id;
    ctx.stderr.write(
      `using workspace ${match.workspace_id} (${label}) for the current directory; pass --workspace <id> to override.\n`
    );
    return { status: "ok", workspaceId: match.workspace_id };
  }

  ctx.stderr.write(
    "multiple workspaces registered; choose one with --workspace <id>:\n"
  );
  for (const ws of active) {
    const label = ws.name?.trim().length ? ws.name : "(no name)";
    const repoPath = ws.repo_path?.trim().length ? ws.repo_path : "(no repo path)";
    ctx.stderr.write(`  ${ws.workspace_id}  ${label}  ${repoPath}\n`);
  }
  return { status: "fail", exitCode: ALAYA_SYSEXITS.USAGE };
}

async function defaultListWorkspaces(
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

async function defaultGetWorkspaceById(
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
    return { status: "error", detail: describeError(error) };
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
  const payload = (await response.json().catch(() => ({}))) as { readonly data?: unknown };
  return { status: "ok", workspace: coerceWorkspaceSummary(payload?.data) };
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

async function ensureDaemonForInspector(
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

function inspectArgsSchema(): AlayaCliArgsSchema<InspectArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return { success: false, error: { issues: [{ path: [], message: "Expected a string argument list." }] } };
      }

      let open = false;
      let port = DEFAULT_INSPECTOR_PORT;
      let token: string | null = null;
      let workspace: string | null = null;
      for (let index = 0; index < input.length; index += 1) {
        const current = input[index]!;
        if (current === "--open") {
          open = true;
          continue;
        }
        if (current === "--port") {
          const value = input[index + 1];
          if (value === undefined) {
            return { success: false, error: { issues: [{ path: [index], message: "--port requires a value." }] } };
          }
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
            return { success: false, error: { issues: [{ path: [index + 1], message: "Invalid port." }] } };
          }
          port = parsed;
          index += 1;
          continue;
        }
        if (current === "--token") {
          const value = input[index + 1];
          if (value === undefined || !/^[0-9a-f]+$/iu.test(value) || value.length < 64) {
            return { success: false, error: { issues: [{ path: [index + 1], message: "Invalid token." }] } };
          }
          token = value;
          index += 1;
          continue;
        }
        if (current === "--workspace") {
          const value = input[index + 1];
          if (value === undefined || value.trim().length === 0) {
            return { success: false, error: { issues: [{ path: [index + 1], message: "--workspace requires a non-empty workspace_id." }] } };
          }
          workspace = value;
          index += 1;
          continue;
        }
        return { success: false, error: { issues: [{ path: [index], message: `Unknown inspect option: ${current}` }] } };
      }

      return { success: true, data: { open, port, token, workspace } };
    }
  };
}

function fixedTokenOverrideAllowed(env: NodeJS.ProcessEnv): boolean {
  const value = env[ALLOW_FIXED_TOKEN_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function defaultGenerateToken(): string {
  return randomBytes(32).toString("hex");
}

function defaultInspectorEntryPath(): string {
  return fileURLToPath(import.meta.resolve("@do-soul/alaya-inspector/dist/server.js"));
}

function defaultSpawnInspector(input: SpawnInspectorInput): InspectorChildProcess {
  return spawnChildProcess(process.execPath, [input.inspectorEntryPath], {
    env: buildInspectorChildEnv(input),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function buildInspectorChildEnv(input: SpawnInspectorInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INSPECTOR_CHILD_ENV_KEYS) {
    const value = input.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.ALAYA_INSPECTOR_TOKEN = input.token;
  env.ALAYA_INSPECTOR_PORT = String(input.port);
  env.ALAYA_INSPECTOR_WORKSPACE_ID = input.workspaceId;
  return env;
}

async function waitForInspectorReady(child: InspectorChildProcess, ctx: AlayaCliContext): Promise<void> {
  if (child.stdout === null) {
    throw new Error("inspector stdout unavailable");
  }

  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === READY_LINE) {
          child.stdout?.off("data", onData);
          resolve();
        } else if (line.trim().length > 0) {
          ctx.stdout.write(`[inspector] ${line}\n`);
        }
      }
    };
    child.stdout!.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`inspector exited before ready: ${code ?? signal ?? "unknown"}`)));
  });

  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/u)) {
      if (line.trim().length > 0) ctx.stdout.write(`[inspector] ${line}\n`);
    }
  });
  child.stderr?.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/u)) {
      if (line.trim().length > 0) ctx.stderr.write(`[inspector] ${line}\n`);
    }
  });
}

async function waitForChildExitOrSignal(child: InspectorChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    let resolved = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        process.off("SIGINT", terminate);
        process.off("SIGTERM", terminate);
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve();
      }
    };
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, SHUTDOWN_TIMEOUT_MS).unref();
    };
    process.once("SIGINT", terminate);
    process.once("SIGTERM", terminate);
    child.once("exit", finish);
  });
}

async function defaultCheckPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function defaultProbeDaemon(url: string, auth?: DaemonRequestAuth): Promise<InspectDaemonProbeResult> {
  const baseUrl = normalizeBaseUrl(url);
  try {
    const response = await fetch(new URL("/health", baseUrl), {
      method: "GET"
    });
    if (!response.ok) {
      return { status: "unavailable", detail: `health HTTP ${response.status}` };
    }
  } catch (error) {
    return { status: "unavailable", detail: describeError(error) };
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
    return { status: "missing_capability", detail: describeError(error) };
  }
}

function resolveDaemonRequestAuth(input: {
  readonly startedDaemon: boolean;
  readonly getRequestToken?: () => string | undefined;
  readonly externalRequestToken: string | undefined;
}): DaemonRequestAuth {
  return input.startedDaemon
    ? { requestToken: normalizeOptionalToken(input.getRequestToken?.()) }
    : { requestToken: input.externalRequestToken };
}

function normalizeOptionalToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
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

function formatProbeDetail(detail: string | undefined): string {
  return detail === undefined || detail.trim().length === 0 ? "" : ` (${detail.trim()})`;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function defaultOpenUrl(url: string): Promise<void> {
  await openUrlWithSpawn(url, {
    spawnBrowser: (command, args) =>
      spawnChildProcess(command, [...args], {
        detached: true,
        stdio: "ignore"
      })
  });
}

export async function openUrlWithSpawn(
  url: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly os?: NodeJS.Platform;
    readonly osRelease?: string;
    readonly spawnBrowser?: BrowserOpenerSpawn;
  } = {}
): Promise<void> {
  const candidates = openCommandCandidates(url, options);
  const spawnBrowser = options.spawnBrowser ?? ((command, args) => spawnChildProcess(command, [...args], {
    detached: true,
    stdio: "ignore"
  }));
  const errors: string[] = [];

  for (const [command, args] of candidates) {
    try {
      await spawnBrowserCandidate(spawnBrowser, command, args);
      return;
    } catch (error) {
      errors.push(`${command}: ${describeError(error)}`);
    }
  }

  throw new Error(`no browser opener worked (${errors.join("; ")})`);
}

export function openCommandCandidates(
  url: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly os?: NodeJS.Platform;
    readonly osRelease?: string;
  } = {}
): readonly (readonly [string, readonly string[]])[] {
  const os = options.os ?? platform();
  if (os === "darwin") return [["open", [url]]];
  if (os === "win32") return [["cmd", ["/c", "start", "", url]]];
  if (os === "linux" && isWslEnvironment(options.env ?? process.env, options.osRelease ?? release())) {
    return [
      ["wslview", [url]],
      ["cmd.exe", ["/c", "start", "", url]],
      ["xdg-open", [url]]
    ];
  }
  return [["xdg-open", [url]]];
}

async function spawnBrowserCandidate(
  spawnBrowser: BrowserOpenerSpawn,
  command: string,
  args: readonly string[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnBrowser(command, args);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

function isWslEnvironment(env: NodeJS.ProcessEnv, osRelease: string): boolean {
  return (
    env.WSL_DISTRO_NAME !== undefined ||
    env.WSL_INTEROP !== undefined ||
    osRelease.toLowerCase().includes("microsoft")
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return String(error);
}
