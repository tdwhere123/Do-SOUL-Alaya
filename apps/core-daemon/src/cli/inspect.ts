import nodePath from "node:path";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "./bridge.js";
import {
  ALLOW_FIXED_TOKEN_ENV,
  EXTERNAL_DAEMON_REQUEST_TOKEN_ENV,
  DEFAULT_INSPECTOR_PORT
} from "./inspect-constants.js";
import { defaultOpenUrl, openCommandCandidates, openUrlWithSpawn } from "./inspect-browser.js";
import {
  defaultGenerateToken,
  defaultInspectorEntryPath,
  defaultSpawnInspector,
  waitForChildExitOrSignal,
  waitForInspectorReady,
  buildInspectorChildEnv
} from "./inspect-child-process.js";
import {
  defaultCheckPortAvailable,
  defaultGetWorkspaceById,
  defaultListWorkspaces,
  ensureDaemonForInspector,
  formatProbeDetail,
  normalizeOptionalToken,
  resolveDaemonRequestAuth,
  type WorkspaceResolution
} from "./inspect-daemon-client.js";
import { describeInspectError } from "./inspect-errors.js";
import type {
  DaemonRequestAuth,
  InspectArgs,
  InspectCommandDependencies,
  InspectDaemonServer,
  WorkspaceSummary
} from "./inspect-types.js";

export type {
  BrowserOpenerChildProcess,
  BrowserOpenerSpawn,
  DaemonRequestAuth,
  InspectCommandDependencies,
  InspectDaemonListenOptions,
  InspectDaemonProbeResult,
  InspectDaemonServer,
  InspectorChildProcess,
  SpawnInspectorInput,
  WorkspaceLookupResult,
  WorkspaceSummary
} from "./inspect-types.js";
export { buildInspectorChildEnv, openCommandCandidates, openUrlWithSpawn };

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
  const validationResult = await validateInspectRequest(ctx, args, checkPortAvailable);
  if (validationResult !== null) {
    return validationResult;
  }
  const token = args.token ?? (deps.generateToken ?? defaultGenerateToken)();
  let launch: InspectorLaunch | null = null;
  try {
    const launchResult = await launchInspector(ctx, args, deps, checkPortAvailable, token);
    if (!launchResult.ok) {
      return launchResult.result;
    }
    launch = launchResult.launch;
    ctx.stdout.write(`${launch.url}\n`);
    await maybeOpenInspectorUrl(args.open, launch.url, deps, ctx);
    await waitForChildExitOrSignal(launch.child);
    return { exitCode: ALAYA_SYSEXITS.OK, json: { url: launch.url, port: args.port } };
  } catch (error) {
    launch?.child.kill("SIGTERM");
    ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: ALAYA_SYSEXITS.SOFTWARE };
  } finally {
    await stopStartedInspectorDaemon(launch?.startedDaemon ?? null, ctx);
  }
}

async function resolveWorkspaceForInspector(
  ctx: AlayaCliContext,
  deps: InspectCommandDependencies,
  daemonUrl: string,
  explicitId: string | null,
  auth?: DaemonRequestAuth
): Promise<WorkspaceResolution> {
  if (explicitId !== null) {
    return await resolveExplicitWorkspaceForInspector(ctx, deps, daemonUrl, explicitId, auth);
  }
  return await resolveImplicitWorkspaceForInspector(ctx, deps, daemonUrl, auth);
}

function inspectArgsSchema(): AlayaCliArgsSchema<InspectArgs> {
  return {
    safeParse: safeParseInspectArgs
  };
}

async function validateInspectRequest(
  ctx: AlayaCliContext,
  args: InspectArgs,
  checkPortAvailable: (port: number) => Promise<boolean>
): Promise<AlayaCliResult | null> {
  if (!(await checkPortAvailable(args.port))) {
    ctx.stderr.write(`port ${args.port} in use; try alaya inspect --port ${args.port + 1}\n`);
    return { exitCode: ALAYA_SYSEXITS.TEMPFAIL };
  }
  if (args.token !== null && !fixedTokenOverrideAllowed(ctx.env)) {
    ctx.stderr.write(`--token is test-only; set ${ALLOW_FIXED_TOKEN_ENV}=1 to allow a fixed Inspector token\n`);
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }
  return null;
}

async function launchInspector(
  ctx: AlayaCliContext,
  args: InspectArgs,
  deps: InspectCommandDependencies,
  checkPortAvailable: (port: number) => Promise<boolean>,
  token: string
): Promise<
  | Readonly<{ ok: true; launch: InspectorLaunch }>
  | Readonly<{ ok: false; result: AlayaCliResult }>
> {
  const externalDaemonRequestToken = normalizeOptionalToken(ctx.env[EXTERNAL_DAEMON_REQUEST_TOKEN_ENV]);
  const daemon = await ensureDaemonForInspector(ctx, deps, checkPortAvailable, externalDaemonRequestToken);
  const daemonRequestAuth = resolveDaemonRequestAuth({
    startedDaemon: daemon.startedDaemon !== null,
    getRequestToken: deps.getRequestToken,
    externalRequestToken: externalDaemonRequestToken
  });
  const workspaceResolution = await resolveWorkspaceForInspector(ctx, deps, daemon.url, args.workspace, daemonRequestAuth);
  if (workspaceResolution.status !== "ok") {
    return { ok: false, result: { exitCode: workspaceResolution.exitCode } };
  }
  const url = buildInspectorUrl(args.port, workspaceResolution.workspaceId, token);
  const child = (deps.spawnInspector ?? defaultSpawnInspector)({
    port: args.port,
    token,
    workspaceId: workspaceResolution.workspaceId,
    inspectorEntryPath: deps.inspectorEntryPath ?? defaultInspectorEntryPath(),
    env: buildInspectorEnv(daemon.url, daemonRequestAuth)
  });
  await waitForInspectorReady(child, ctx);
  return { ok: true, launch: { url, child, startedDaemon: daemon.startedDaemon } };
}

async function resolveExplicitWorkspaceForInspector(
  ctx: AlayaCliContext,
  deps: InspectCommandDependencies,
  daemonUrl: string,
  explicitId: string,
  auth?: DaemonRequestAuth
): Promise<WorkspaceResolution> {
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
  ctx.stderr.write(`failed to verify workspace "${trimmed}" against daemon${formatProbeDetail(lookup.detail)}.\n`);
  return { status: "fail", exitCode: ALAYA_SYSEXITS.SOFTWARE };
}

async function resolveImplicitWorkspaceForInspector(
  ctx: AlayaCliContext,
  deps: InspectCommandDependencies,
  daemonUrl: string,
  auth?: DaemonRequestAuth
): Promise<WorkspaceResolution> {
  const active = await listActiveWorkspacesForInspector(ctx, deps, daemonUrl, auth);
  if ("status" in active) {
    return active;
  }
  if (active.length === 1) {
    return { status: "ok", workspaceId: active[0]!.workspace_id };
  }
  const currentDirectoryMatch = resolveWorkspaceFromCurrentDirectory(ctx.cwd, active);
  if (currentDirectoryMatch !== null) {
    ctx.stderr.write(
      `using workspace ${currentDirectoryMatch.workspace_id} (${currentDirectoryMatch.label}) for the current directory; pass --workspace <id> to override.\n`
    );
    return { status: "ok", workspaceId: currentDirectoryMatch.workspace_id };
  }
  return writeMultipleWorkspaceChoices(ctx, active);
}

async function listActiveWorkspacesForInspector(
  ctx: AlayaCliContext,
  deps: InspectCommandDependencies,
  daemonUrl: string,
  auth?: DaemonRequestAuth
): Promise<readonly WorkspaceSummary[] | WorkspaceResolution> {
  try {
    const workspaces = await (deps.listWorkspaces ?? defaultListWorkspaces)(daemonUrl, auth);
    const active = workspaces.filter((ws) => ws.workspace_state === "active");
    if (active.length > 0) {
      return active;
    }
  } catch (error) {
    ctx.stderr.write(`failed to list workspaces from daemon: ${describeInspectError(error)}\n`);
    return { status: "fail", exitCode: ALAYA_SYSEXITS.SOFTWARE };
  }
  ctx.stderr.write("no active workspace registered; run 'alaya install' inside your project root first.\n");
  return { status: "fail", exitCode: ALAYA_SYSEXITS.SOFTWARE };
}

function resolveWorkspaceFromCurrentDirectory(
  cwd: string,
  active: readonly WorkspaceSummary[]
): Readonly<{ workspace_id: string; label: string }> | null {
  const normalizedCwd = nodePath.resolve(cwd);
  const cwdMatches = active.filter(
    (ws) =>
      typeof ws.repo_path === "string" &&
      ws.repo_path.trim().length > 0 &&
      nodePath.resolve(ws.repo_path) === normalizedCwd
  );
  if (cwdMatches.length !== 1) {
    return null;
  }
  const match = cwdMatches[0]!;
  return {
    workspace_id: match.workspace_id,
    label: match.name?.trim().length ? match.name : match.workspace_id
  };
}

function writeMultipleWorkspaceChoices(
  ctx: Pick<AlayaCliContext, "stderr">,
  active: readonly WorkspaceSummary[]
): WorkspaceResolution {
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

function safeParseInspectArgs(input: unknown):
  | { readonly success: true; readonly data: InspectArgs }
  | { readonly success: false; readonly error: { readonly issues: readonly { readonly path: readonly number[]; readonly message: string }[] } } {
  if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
    return { success: false, error: { issues: [{ path: [], message: "Expected a string argument list." }] } };
  }
  return parseInspectArgs(input);
}

function parseInspectArgs(
  input: readonly string[]
):
  | { readonly success: true; readonly data: InspectArgs }
  | { readonly success: false; readonly error: { readonly issues: readonly { readonly path: readonly number[]; readonly message: string }[] } } {
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
    const optionResult = applyInspectOption(input, index, current, {
      port,
      token,
      workspace
    });
    if (!optionResult.ok) {
      return { success: false, error: { issues: [{ path: optionResult.path, message: optionResult.message }] } };
    }
    if (!optionResult.handled) {
      return { success: false, error: { issues: [{ path: [index], message: `Unknown inspect option: ${current}` }] } };
    }
    ({ port, token, workspace } = optionResult.nextState);
    index += optionResult.consumed;
  }
  return { success: true, data: { open, port, token, workspace } };
}

function applyInspectOption(
  input: readonly string[],
  index: number,
  current: string,
  state: Readonly<{ port: number; token: string | null; workspace: string | null }>
):
  | Readonly<{ ok: true; handled: false; consumed: 0; nextState: typeof state }>
  | Readonly<{ ok: true; handled: true; consumed: 1; nextState: typeof state }>
  | Readonly<{ ok: false; path: readonly number[]; message: string }> {
  if (current === "--port") {
    const value = input[index + 1];
    if (value === undefined) {
      return { ok: false, path: [index], message: "--port requires a value." };
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
      return { ok: false, path: [index + 1], message: "Invalid port." };
    }
    return { ok: true, handled: true, consumed: 1, nextState: { ...state, port: parsed } };
  }
  if (current === "--token") {
    const value = input[index + 1];
    if (value === undefined || !/^[0-9a-f]+$/iu.test(value) || value.length < 64) {
      return { ok: false, path: [index + 1], message: "Invalid token." };
    }
    return { ok: true, handled: true, consumed: 1, nextState: { ...state, token: value } };
  }
  if (current === "--workspace") {
    const value = input[index + 1];
    if (value === undefined || value.trim().length === 0) {
      return { ok: false, path: [index + 1], message: "--workspace requires a non-empty workspace_id." };
    }
    return { ok: true, handled: true, consumed: 1, nextState: { ...state, workspace: value } };
  }
  return { ok: true, handled: false, consumed: 0, nextState: state };
}

function buildInspectorUrl(port: number, workspaceId: string, token: string): string {
  return `http://127.0.0.1:${port}/?workspaceId=${encodeURIComponent(workspaceId)}#token=${encodeURIComponent(token)}`;
}

function buildInspectorEnv(daemonUrl: string, daemonRequestAuth?: DaemonRequestAuth): NodeJS.ProcessEnv {
  const inspectorEnv: NodeJS.ProcessEnv = { ALAYA_DAEMON_URL: daemonUrl };
  if (daemonRequestAuth?.requestToken !== undefined) {
    inspectorEnv.ALAYA_REQUEST_TOKEN = daemonRequestAuth.requestToken;
  }
  return inspectorEnv;
}

async function maybeOpenInspectorUrl(
  open: boolean,
  url: string,
  deps: InspectCommandDependencies,
  ctx: AlayaCliContext
): Promise<void> {
  if (!open) {
    return;
  }
  await (deps.openUrl ?? defaultOpenUrl)(url).catch((error) => {
    ctx.stderr.write(`could not open browser automatically; copy the printed URL manually (${describeInspectError(error)})\n`);
  });
}

async function stopStartedInspectorDaemon(
  startedDaemon: InspectDaemonServer | null,
  ctx: AlayaCliContext
): Promise<void> {
  if (startedDaemon === null) {
    return;
  }
  await startedDaemon.close().catch((error) => {
    ctx.stderr.write(`failed to stop Inspector daemon: ${describeInspectError(error)}\n`);
  });
}

interface InspectorLaunch {
  readonly url: string;
  readonly child: ReturnType<typeof defaultSpawnInspector>;
  readonly startedDaemon: InspectDaemonServer | null;
}

function fixedTokenOverrideAllowed(env: NodeJS.ProcessEnv): boolean {
  const value = env[ALLOW_FIXED_TOKEN_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
