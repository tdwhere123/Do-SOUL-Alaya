/**
 * @internal Exposed via `@do-soul/alaya/cli/bridge` for the in-process
 * bench harness in `@do-soul/alaya-bench-runner`. Not a stability promise:
 * the export surface, symbol names, and signatures may change without a
 * deprecation period. If you rename or split this module, also update:
 *   - apps/core-daemon/package.json `exports."./cli/bridge"`
 *   - apps/bench-runner/src/harness/daemon.ts (the only known consumer)
 * @see apps/bench-runner/src/harness/daemon.ts
 */
import type { AlayaDaemonRuntime } from "../index.js";

export const ALAYA_SYSEXITS = Object.freeze({
  OK: 0,
  USAGE: 64,
  DATAERR: 65,
  NOINPUT: 66,
  SOFTWARE: 70,
  CANTCREAT: 73,
  TEMPFAIL: 75,
  NOPERM: 77
});

export type AlayaCliDaemonRuntime = Pick<AlayaDaemonRuntime, "startupSteps">;

export interface AlayaCliContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTTY: boolean;
  readonly jsonRequested?: boolean;
  readonly daemon: AlayaCliDaemonRuntime;
}

export interface AlayaCliResult {
  readonly exitCode: number;
  readonly json?: unknown;
}

export interface AlayaSubcommandSpec<TArgs = unknown> {
  readonly name: string;
  readonly description: string;
  readonly argsSchema: AlayaCliArgsSchema<TArgs>;
  readonly handler: (ctx: AlayaCliContext, args: TArgs) => Promise<AlayaCliResult>;
  readonly requiresDaemonReady: boolean;
}

export interface AlayaCliSchemaIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export interface AlayaCliArgsSchema<TArgs = unknown> {
  safeParse(input: unknown):
    | { readonly success: true; readonly data: TArgs }
    | { readonly success: false; readonly error: { readonly issues: readonly AlayaCliSchemaIssue[] } };
}

export interface AlayaCliBridge {
  registerSubcommand<TArgs>(spec: AlayaSubcommandSpec<TArgs>): void;
  dispatch(argv: readonly string[]): Promise<AlayaCliResult>;
  list(): readonly { readonly name: string; readonly description: string }[];
}

export interface AlayaCliBridgeOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly isTTY?: boolean;
  readonly isDaemonReady?: (daemon: AlayaCliDaemonRuntime) => boolean;
}

interface AlayaCliBridgeState {
  readonly daemon: AlayaCliDaemonRuntime;
  readonly entries: AlayaSubcommandSpec<unknown>[];
  readonly byName: Map<string, AlayaSubcommandSpec<unknown>>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTTY: boolean;
  readonly isDaemonReady: (daemon: AlayaCliDaemonRuntime) => boolean;
}

export class DuplicateSubcommandError extends Error {
  readonly subcommand: string;

  constructor(subcommand: string) {
    super(`Duplicate subcommand: ${subcommand}`);
    this.name = "DuplicateSubcommandError";
    this.subcommand = subcommand;
  }
}

export function createAlayaCliBridge(
  daemon: AlayaCliDaemonRuntime,
  options: AlayaCliBridgeOptions = {}
): AlayaCliBridge {
  const state = createBridgeState(daemon, options);
  return {
    registerSubcommand: (spec) => registerBridgeSubcommand(state, spec),
    dispatch: async (argv) => await dispatchCliCommand(state, argv),
    list: () => state.entries.map(({ name, description }) => ({ name, description }))
  };
}

function defaultDaemonReadiness(daemon: AlayaCliDaemonRuntime): boolean {
  return daemon.startupSteps.some((record) => record.step === "http-app");
}

function parseGlobalFlags(argv: readonly string[]): {
  readonly argv: readonly string[];
  readonly jsonRequested: boolean;
  readonly helpRequested: boolean;
} {
  const filtered: string[] = [];
  let jsonRequested = false;
  let helpRequested = false;

  for (const token of argv) {
    if (token === "--json") {
      jsonRequested = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      helpRequested = true;
      continue;
    }
    filtered.push(token);
  }

  return {
    argv: filtered,
    jsonRequested,
    helpRequested
  };
}

function formatZodIssues(issues: readonly AlayaCliSchemaIssue[]): readonly string[] {
  return issues.map((issue) => {
    const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
    return `- ${path}: ${issue.message}`;
  });
}

function writeGeneralHelp(stream: NodeJS.WritableStream, entries: readonly AlayaSubcommandSpec[]): void {
  writeLine(stream, "Usage: alaya <subcommand> [args]");
  writeLine(stream, "");
  writeLine(stream, "Subcommands:");
  if (entries.length === 0) {
    writeLine(stream, "  (none registered)");
  } else {
    for (const entry of entries) {
      writeLine(stream, `  ${entry.name}  ${entry.description}`);
    }
  }
  writeLine(stream, "");
  writeLine(stream, "Global options:");
  writeLine(stream, "  --help, -h  Show help.");
  writeLine(stream, "  --json      Emit JSON result payload.");
}

function writeSubcommandHelp(stream: NodeJS.WritableStream, spec: AlayaSubcommandSpec): void {
  writeLine(stream, `Usage: alaya ${spec.name} [args]`);
  writeLine(stream, "");
  writeLine(stream, spec.description);
  writeLine(stream, "");
  writeLine(stream, "Global options:");
  writeLine(stream, "  --help, -h  Show help.");
  writeLine(stream, "  --json      Emit JSON result payload.");
}

function writeHandlerError(
  stream: NodeJS.WritableStream,
  error: unknown,
  env: NodeJS.ProcessEnv
): void {
  const debugEnabled = env.ALAYA_DEBUG === "1";
  if (debugEnabled && error instanceof Error && typeof error.stack === "string") {
    writeLine(stream, error.stack);
    return;
  }

  writeLine(stream, sanitizeErrorMessage(error));
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : "Subcommand failed.";
  }
  return "Subcommand failed.";
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}

function createBridgeState(
  daemon: AlayaCliDaemonRuntime,
  options: AlayaCliBridgeOptions
): AlayaCliBridgeState {
  const stdout = options.stdout ?? process.stdout;
  return {
    daemon,
    entries: [],
    byName: new Map<string, AlayaSubcommandSpec<unknown>>(),
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdin: options.stdin ?? process.stdin,
    stdout,
    stderr: options.stderr ?? process.stderr,
    isTTY: options.isTTY ?? Boolean((stdout as NodeJS.WriteStream).isTTY),
    isDaemonReady: options.isDaemonReady ?? defaultDaemonReadiness
  };
}

function registerBridgeSubcommand<TArgs>(
  state: AlayaCliBridgeState,
  spec: AlayaSubcommandSpec<TArgs>
): void {
  if (state.byName.has(spec.name)) {
    throw new DuplicateSubcommandError(spec.name);
  }
  const erased = spec as unknown as AlayaSubcommandSpec<unknown>;
  state.entries.push(erased);
  state.byName.set(spec.name, erased);
}

async function dispatchCliCommand(
  state: AlayaCliBridgeState,
  argv: readonly string[]
): Promise<AlayaCliResult> {
  const preambleResult = handleBridgePreamble(state, argv);
  if (preambleResult !== null) {
    return preambleResult;
  }
  const spec = resolveRegisteredSpec(state, argv[0]!);
  if ("exitCode" in spec) {
    return spec;
  }
  const rawArgs = argv.slice(1);
  const parsedFlags = parseGlobalFlags(rawArgs);
  const helpResult = handleSubcommandHelp(state, spec, parsedFlags.helpRequested);
  if (helpResult !== null) {
    return helpResult;
  }
  const readinessResult = ensureBridgeDaemonReady(state, spec);
  if (readinessResult !== null) {
    return readinessResult;
  }
  const parsedArgs = spec.argsSchema.safeParse(parsedFlags.argv);
  if (!parsedArgs.success) {
    return writeInvalidArgs(state.stderr, spec, parsedArgs.error.issues);
  }
  return await executeBridgeSubcommand(state, spec, rawArgs, parsedFlags.jsonRequested, parsedArgs.data);
}

function handleBridgePreamble(
  state: AlayaCliBridgeState,
  argv: readonly string[]
): AlayaCliResult | null {
  if (argv.length === 0 || argv[0] === undefined) {
    writeGeneralHelp(state.stderr, state.entries);
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    writeGeneralHelp(state.stdout, state.entries);
    return { exitCode: ALAYA_SYSEXITS.OK };
  }
  return null;
}

function resolveRegisteredSpec(
  state: AlayaCliBridgeState,
  name: string
): AlayaSubcommandSpec<unknown> | AlayaCliResult {
  const spec = state.byName.get(name);
  if (spec !== undefined) {
    return spec;
  }
  writeLine(state.stderr, `Unknown subcommand: ${name}`);
  writeGeneralHelp(state.stderr, state.entries);
  return { exitCode: ALAYA_SYSEXITS.USAGE };
}

function handleSubcommandHelp(
  state: AlayaCliBridgeState,
  spec: AlayaSubcommandSpec<unknown>,
  helpRequested: boolean
): AlayaCliResult | null {
  if (!helpRequested) {
    return null;
  }
  writeSubcommandHelp(state.stdout, spec);
  return { exitCode: ALAYA_SYSEXITS.OK };
}

function ensureBridgeDaemonReady(
  state: AlayaCliBridgeState,
  spec: AlayaSubcommandSpec<unknown>
): AlayaCliResult | null {
  if (!spec.requiresDaemonReady || state.isDaemonReady(state.daemon)) {
    return null;
  }
  writeLine(state.stderr, "daemon not ready");
  return { exitCode: ALAYA_SYSEXITS.TEMPFAIL };
}

function writeInvalidArgs(
  stderr: NodeJS.WritableStream,
  spec: AlayaSubcommandSpec<unknown>,
  issues: readonly AlayaCliSchemaIssue[]
): AlayaCliResult {
  writeLine(stderr, `Invalid arguments for ${spec.name}:`);
  for (const issueLine of formatZodIssues(issues)) {
    writeLine(stderr, issueLine);
  }
  return { exitCode: ALAYA_SYSEXITS.USAGE };
}

async function executeBridgeSubcommand(
  state: AlayaCliBridgeState,
  spec: AlayaSubcommandSpec<unknown>,
  rawArgs: readonly string[],
  jsonRequested: boolean,
  parsedArgs: unknown
): Promise<AlayaCliResult> {
  const ctx = buildCliContext(state, rawArgs, jsonRequested);
  try {
    const result = await spec.handler(ctx, parsedArgs);
    if (jsonRequested) {
      const payload = result.json === undefined ? null : result.json;
      writeLine(state.stdout, JSON.stringify(payload));
    }
    return result;
  } catch (error) {
    writeHandlerError(state.stderr, error, state.env);
    return { exitCode: ALAYA_SYSEXITS.SOFTWARE };
  }
}

function buildCliContext(
  state: AlayaCliBridgeState,
  rawArgs: readonly string[],
  jsonRequested: boolean
): AlayaCliContext {
  return {
    cwd: state.cwd,
    env: state.env,
    argv: rawArgs,
    stdin: state.stdin,
    stdout: state.stdout,
    stderr: state.stderr,
    isTTY: state.isTTY,
    jsonRequested,
    daemon: state.daemon
  };
}
