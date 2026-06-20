import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "../bridge.js";
import {
  applyProfileMutationPlan,
  buildDetachProfileMutationPlan,
  confirmProfileMutation,
  parseProfileTarget,
  renderProfileMutationPreview,
  SUPPORTED_PROFILE_TARGETS,
  type ProfileMutationApplyOptions,
  type ProfileMutationAuditWriter,
  type ProfileMutationConfirmIo,
  type ProfileMutationFs,
  type ProfileTarget
} from "../../attach/index.js";

export interface DetachCommandDeps {
  readonly fs?: ProfileMutationFs;
  readonly auditWriter?: ProfileMutationAuditWriter;
  readonly nowIso?: () => string;
  readonly confirm?: (io: ProfileMutationConfirmIo) => Promise<boolean>;
}

export function createDetachCommandSpec(deps: DetachCommandDeps = {}): AlayaSubcommandSpec<readonly string[]> {
  return {
    name: "detach",
    description: "Detach Alaya MCP + /alaya-inspect from a supported agent profile.",
    argsSchema: stringListArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => await executeDetach(ctx, args, deps)
  };
}

function stringListArgsSchema(): AlayaCliArgsSchema<readonly string[]> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "Expected a string argument list." }] }
        };
      }

      return { success: true, data: input };
    }
  };
}

async function executeDetach(
  ctx: AlayaCliContext,
  args: readonly string[],
  deps: DetachCommandDeps
): Promise<AlayaCliResult> {
  const parseResult = parseDetachArgs(args);
  if (!parseResult.ok) {
    return reportDetachUsage(ctx.stderr, parseResult.message);
  }
  const target = parseProfileTarget(parseResult.target);
  if (target === undefined) {
    return reportDetachUsage(ctx.stderr, `unsupported detach target: ${parseResult.target}`);
  }

  return await executeDetachPlan(ctx, deps, parseResult, target);
}

async function executeDetachPlan(
  ctx: AlayaCliContext,
  deps: DetachCommandDeps,
  args: Readonly<{ ok: true; target: string; yes: boolean; dryRun: boolean }>,
  target: ProfileTarget
): Promise<AlayaCliResult> {
  const applyOptions: ProfileMutationApplyOptions = {
    fs: deps.fs,
    auditWriter: deps.auditWriter,
    allowConflicts: false,
    nowIso: deps.nowIso
  };
  const confirm = deps.confirm ?? confirmProfileMutation;

  try {
    const plan = await buildDetachProfileMutationPlan(target, { env: ctx.env, fs: deps.fs });
    const searchedPaths = [...plan.paths.slashPathCandidates];
    const conflictOperations = plan.operations.filter((operation) => operation.conflict !== undefined);
    if (conflictOperations.length > 0) {
      return reportDetachConflicts(ctx.stderr, target, searchedPaths, conflictOperations);
    }
    const hasChanges = plan.operations.some((operation) => operation.changed);
    if (!hasChanges) {
      return reportNoDetachChanges(ctx, target, searchedPaths);
    }

    if (ctx.jsonRequested !== true) {
      ctx.stdout.write(renderProfileMutationPreview(plan));
    }
    if (args.dryRun) {
      return reportDetachDryRun(target, searchedPaths, plan.operations);
    }

    if (!args.yes && !(await confirm(ctx))) {
      return reportDetachCanceled(ctx, target, searchedPaths);
    }

    const result = await applyProfileMutationPlan(plan, applyOptions);
    return reportDetachApplied(ctx, target, searchedPaths, result);
  } catch (error) {
    return reportDetachError(ctx.stderr, error);
  }
}

function reportDetachUsage(stderr: NodeJS.WritableStream, message: string): AlayaCliResult {
  stderr.write(`${message}\n`);
  return {
    exitCode: ALAYA_SYSEXITS.USAGE,
    json: {
      ok: false,
      supported_targets: SUPPORTED_PROFILE_TARGETS
    }
  };
}

function reportDetachConflicts(
  stderr: NodeJS.WritableStream,
  target: ProfileTarget,
  searchedPaths: readonly string[],
  conflictOperations: readonly Readonly<{
    readonly path: string;
    readonly conflict?: Readonly<{ readonly message: string; readonly existingCommand: string | null }>;
  }>[]
): AlayaCliResult {
  const message = conflictOperations
    .map((operation) => operation.conflict!.message)
    .join("; ");
  stderr.write(`${message}\n`);
  return {
    exitCode: ALAYA_SYSEXITS.NOPERM,
    json: {
      ok: false,
      target,
      changed: false,
      searched: searchedPaths,
      conflicts: conflictOperations.map((operation) => ({
        path: operation.path,
        message: operation.conflict!.message,
        existing_command: operation.conflict!.existingCommand
      }))
    }
  };
}

function reportNoDetachChanges(
  ctx: AlayaCliContext,
  target: ProfileTarget,
  searchedPaths: readonly string[]
): AlayaCliResult {
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write("nothing to detach\n");
    ctx.stdout.write(`searched paths: ${searchedPaths.join(", ")}\n`);
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: { ok: true, target, changed: false, searched: searchedPaths }
  };
}

function reportDetachDryRun(
  target: ProfileTarget,
  searchedPaths: readonly string[],
  operations: readonly { readonly changed: boolean; readonly path: string }[]
): AlayaCliResult {
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: {
      ok: true,
      target,
      changed: false,
      dry_run: true,
      searched: searchedPaths,
      changed_paths: operations.filter((operation) => operation.changed).map((operation) => operation.path)
    }
  };
}

function reportDetachCanceled(
  ctx: AlayaCliContext,
  target: ProfileTarget,
  searchedPaths: readonly string[]
): AlayaCliResult {
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write("canceled\n");
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: { ok: true, target, changed: false, canceled: true, searched: searchedPaths }
  };
}

function reportDetachApplied(
  ctx: AlayaCliContext,
  target: ProfileTarget,
  searchedPaths: readonly string[],
  result: Awaited<ReturnType<typeof applyProfileMutationPlan>>
): AlayaCliResult {
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write(`detached ${target}\n`);
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: {
      ok: true,
      target,
      changed: result.changed,
      searched: searchedPaths,
      changed_paths: result.auditRow?.changed_paths ?? [],
      records: result.auditRow?.records ?? []
    }
  };
}

function parseDetachArgs(args: readonly string[]):
  | Readonly<{ ok: true; target: string; yes: boolean; dryRun: boolean }>
  | Readonly<{ ok: false; message: string }> {
  let yes = false;
  let dryRun = false;
  const positional: string[] = [];

  for (const token of args) {
    if (token === "--yes") {
      yes = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token.startsWith("-")) {
      return { ok: false, message: `unknown detach option: ${token}` };
    }
    positional.push(token);
  }

  if (positional.length === 0) {
    return {
      ok: false,
      message: `missing detach target; supported targets: ${SUPPORTED_PROFILE_TARGETS.join(", ")}`
    };
  }
  if (positional.length > 1) {
    return { ok: false, message: "detach accepts exactly one target." };
  }

  return {
    ok: true,
    target: positional[0]!,
    yes,
    dryRun
  };
}

function reportDetachError(stderr: NodeJS.WritableStream, error: unknown): AlayaCliResult {
  if (error instanceof Error && "exitCode" in error && typeof error.exitCode === "number") {
    stderr.write(`${error.message}\n`);
    return { exitCode: error.exitCode };
  }
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return { exitCode: ALAYA_SYSEXITS.CANTCREAT };
}
