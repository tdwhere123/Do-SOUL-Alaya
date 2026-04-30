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
  const entries: AlayaSubcommandSpec<any>[] = [];
  const byName = new Map<string, AlayaSubcommandSpec<any>>();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const isTTY = options.isTTY ?? Boolean((stdout as NodeJS.WriteStream).isTTY);
  const isDaemonReady = options.isDaemonReady ?? defaultDaemonReadiness;

  return {
    registerSubcommand: (spec) => {
      if (byName.has(spec.name)) {
        throw new DuplicateSubcommandError(spec.name);
      }
      entries.push(spec);
      byName.set(spec.name, spec);
    },

    dispatch: async (argv) => {
      if (argv.length === 0 || argv[0] === undefined) {
        writeGeneralHelp(stderr, entries);
        return { exitCode: ALAYA_SYSEXITS.USAGE };
      }
      if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
        writeGeneralHelp(stdout, entries);
        return { exitCode: ALAYA_SYSEXITS.OK };
      }

      const name = argv[0];
      const spec = byName.get(name);
      if (spec === undefined) {
        writeLine(stderr, `Unknown subcommand: ${name}`);
        writeGeneralHelp(stderr, entries);
        return { exitCode: ALAYA_SYSEXITS.USAGE };
      }

      const rawArgs = argv.slice(1);
      const parsedFlags = parseGlobalFlags(rawArgs);
      if (parsedFlags.helpRequested) {
        writeSubcommandHelp(stdout, spec);
        return { exitCode: ALAYA_SYSEXITS.OK };
      }

      if (spec.requiresDaemonReady && !isDaemonReady(daemon)) {
        writeLine(stderr, "daemon not ready");
        return { exitCode: ALAYA_SYSEXITS.TEMPFAIL };
      }

      const parsedArgs = spec.argsSchema.safeParse(parsedFlags.argv);
      if (!parsedArgs.success) {
        writeLine(stderr, `Invalid arguments for ${spec.name}:`);
        for (const issueLine of formatZodIssues(parsedArgs.error.issues)) {
          writeLine(stderr, issueLine);
        }
        return { exitCode: ALAYA_SYSEXITS.USAGE };
      }

      const ctx: AlayaCliContext = {
        cwd,
        env,
        argv: rawArgs,
        stdin,
        stdout,
        stderr,
        isTTY,
        daemon
      };

      try {
        const result = await spec.handler(ctx, parsedArgs.data);
        if (parsedFlags.jsonRequested) {
          const payload = result.json === undefined ? null : result.json;
          writeLine(stdout, JSON.stringify(payload));
        }
        return result;
      } catch (error) {
        writeHandlerError(stderr, error, env);
        return { exitCode: ALAYA_SYSEXITS.SOFTWARE };
      }
    },

    list: () => entries.map(({ name, description }) => ({ name, description }))
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
