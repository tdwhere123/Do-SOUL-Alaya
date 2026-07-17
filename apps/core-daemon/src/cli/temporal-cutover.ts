import {
  cutOverTemporalProjection,
  recoverTemporalProjectionCutover,
  rollbackTemporalProjectionCutover
} from "../runtime/temporal-cutover/cutover.js";
import { ALAYA_SYSEXITS, type AlayaCliArgsSchema, type AlayaCliContext, type AlayaSubcommandSpec } from "./bridge.js";
import { resolveAlayaConfigDir, resolveAlayaConfigPaths } from "./config-files.js";

type TemporalCutoverAction = "cutover" | "rollback" | "recover";

interface TemporalCutoverArgs {
  readonly action: TemporalCutoverAction;
  readonly candidateFilename: string | null;
  readonly candidateReceiptFilename: string | null;
  readonly journalFilename: string;
  readonly reason: string;
  readonly yes: true;
}

interface TemporalCutoverRuntime {
  shutdown(): Promise<void>;
}

export interface TemporalCutoverCommandDependencies {
  readonly cutOver?: typeof cutOverTemporalProjection;
  readonly rollback?: typeof rollbackTemporalProjectionCutover;
  readonly recover?: typeof recoverTemporalProjectionCutover;
}

/**
 * Stops the CLI's short-lived runtime before changing the active DB pointer.
 * The cutover lease then independently proves no other daemon still owns it.
 */
export function createTemporalCutoverCommandSpec(
  runtime: TemporalCutoverRuntime,
  deps: TemporalCutoverCommandDependencies = {}
): AlayaSubcommandSpec<TemporalCutoverArgs> {
  return {
    name: "temporal-cutover",
    description: "Stop the daemon and cut over, roll back, or recover a temporal projection.",
    argsSchema: temporalCutoverArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => {
      await runtime.shutdown();
      const result = await executeTemporalCutoverAction(ctx, args, deps);
      if (ctx.jsonRequested !== true) writeTemporalCutoverResult(ctx, args.action, result);
      return { exitCode: ALAYA_SYSEXITS.OK, json: result };
    }
  };
}

function temporalCutoverArgsSchema(): AlayaCliArgsSchema<TemporalCutoverArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return invalidArgs("Expected a string argument list.");
      }
      const parsed = parseTemporalCutoverArgs(input);
      return parsed.ok ? { success: true, data: parsed.args } : invalidArgs(parsed.message);
    }
  };
}

function invalidArgs(message: string): {
  readonly success: false;
  readonly error: { readonly issues: readonly { readonly path: readonly []; readonly message: string }[] };
} {
  return { success: false, error: { issues: [{ path: [], message }] } };
}

function parseTemporalCutoverArgs(
  input: readonly string[]
):
  | Readonly<{ ok: true; args: TemporalCutoverArgs }>
  | Readonly<{ ok: false; message: string }> {
  let reason: string | null = null;
  let yes = false;
  const positionals: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]!;
    if (token === "--yes") {
      yes = true;
      continue;
    }
    if (token === "--reason") {
      const value = input[index + 1];
      if (value === undefined || value.trim().length === 0) {
        return { ok: false, message: "--reason requires non-empty text." };
      }
      reason = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, message: `unknown option: ${token}` };
    positionals.push(token);
  }

  const action = positionals[0];
  if (action !== "cutover" && action !== "rollback" && action !== "recover") {
    return { ok: false, message: "expected cutover, rollback, or recover as the first argument." };
  }
  if (!yes) return { ok: false, message: `${action} requires --yes after operator review.` };
  if (reason === null) return { ok: false, message: `${action} requires --reason <text>.` };
  return action === "cutover"
    ? parseCutoverArgs(positionals, reason)
    : parseRecoveryArgs(action, positionals, reason);
}

function parseCutoverArgs(
  positionals: readonly string[],
  reason: string
): Readonly<{ ok: true; args: TemporalCutoverArgs }> | Readonly<{ ok: false; message: string }> {
  const [, candidateFilename, candidateReceiptFilename, journalFilename] = positionals;
  if (
    positionals.length !== 4 ||
    candidateFilename === undefined ||
    candidateReceiptFilename === undefined ||
    journalFilename === undefined ||
    !isNonEmptyPath(candidateFilename) ||
    !isNonEmptyPath(candidateReceiptFilename) ||
    !isNonEmptyPath(journalFilename)
  ) {
    return {
      ok: false,
      message: "cutover requires <candidate-db> <candidate-receipt> <journal> exactly once."
    };
  }
  return {
    ok: true,
    args: {
      action: "cutover",
      candidateFilename,
      candidateReceiptFilename,
      journalFilename,
      reason,
      yes: true
    }
  };
}

function parseRecoveryArgs(
  action: "rollback" | "recover",
  positionals: readonly string[],
  reason: string
): Readonly<{ ok: true; args: TemporalCutoverArgs }> | Readonly<{ ok: false; message: string }> {
  const [, journalFilename] = positionals;
  if (positionals.length !== 2 || journalFilename === undefined || !isNonEmptyPath(journalFilename)) {
    return { ok: false, message: `${action} requires exactly one <journal> path.` };
  }
  return {
    ok: true,
    args: {
      action,
      candidateFilename: null,
      candidateReceiptFilename: null,
      journalFilename,
      reason,
      yes: true
    }
  };
}

async function executeTemporalCutoverAction(
  ctx: AlayaCliContext,
  args: TemporalCutoverArgs,
  deps: TemporalCutoverCommandDependencies
): Promise<unknown> {
  if (args.action === "cutover") {
    return await (deps.cutOver ?? cutOverTemporalProjection)({
      configPaths: resolveAlayaConfigPaths(resolveAlayaConfigDir({ env: ctx.env })),
      candidateFilename: args.candidateFilename!,
      candidateReceiptFilename: args.candidateReceiptFilename!,
      journalFilename: args.journalFilename,
      reason: args.reason
    });
  }
  const action = args.action === "rollback" ? deps.rollback ?? rollbackTemporalProjectionCutover : deps.recover ?? recoverTemporalProjectionCutover;
  return await action({ journalFilename: args.journalFilename, reason: args.reason });
}

function writeTemporalCutoverResult(
  ctx: AlayaCliContext,
  action: TemporalCutoverAction,
  result: unknown
): void {
  ctx.stdout.write(`temporal ${action} completed: ${JSON.stringify(result)}\n`);
}

function isNonEmptyPath(value: string): boolean {
  return value.trim().length > 0;
}
