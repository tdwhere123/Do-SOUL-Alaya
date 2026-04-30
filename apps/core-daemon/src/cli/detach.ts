import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "./bridge.js";
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
  type ProfileMutationFs
} from "../profile-mutation.js";

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
    ctx.stderr.write(`${parseResult.message}\n`);
    return {
      exitCode: ALAYA_SYSEXITS.USAGE,
      json: {
        ok: false,
        supported_targets: SUPPORTED_PROFILE_TARGETS
      }
    };
  }

  const target = parseProfileTarget(parseResult.target);
  if (target === undefined) {
    ctx.stderr.write(`unsupported detach target: ${parseResult.target}\n`);
    return {
      exitCode: ALAYA_SYSEXITS.USAGE,
      json: {
        ok: false,
        supported_targets: SUPPORTED_PROFILE_TARGETS
      }
    };
  }

  const applyOptions: ProfileMutationApplyOptions = {
    fs: deps.fs,
    auditWriter: deps.auditWriter,
    allowConflicts: true,
    nowIso: deps.nowIso
  };
  const confirm = deps.confirm ?? confirmProfileMutation;

  try {
    const plan = await buildDetachProfileMutationPlan(target, { env: ctx.env, fs: deps.fs });
    const hasChanges = plan.operations.some((operation) => operation.changed);
    if (!hasChanges) {
      if (ctx.jsonRequested !== true) {
        ctx.stdout.write("nothing to detach\n");
      }
      return { exitCode: ALAYA_SYSEXITS.OK, json: { ok: true, target, changed: false } };
    }

    if (ctx.jsonRequested !== true) {
      ctx.stdout.write(renderProfileMutationPreview(plan));
    }
    if (parseResult.dryRun) {
      return {
        exitCode: ALAYA_SYSEXITS.OK,
        json: {
          ok: true,
          target,
          changed: false,
          dry_run: true,
          changed_paths: plan.operations.filter((operation) => operation.changed).map((operation) => operation.path)
        }
      };
    }

    if (!parseResult.yes && !(await confirm(ctx))) {
      if (ctx.jsonRequested !== true) {
        ctx.stdout.write("canceled\n");
      }
      return { exitCode: ALAYA_SYSEXITS.OK, json: { ok: true, target, changed: false, canceled: true } };
    }

    const result = await applyProfileMutationPlan(plan, applyOptions);
    if (ctx.jsonRequested !== true) {
      ctx.stdout.write(`detached ${target}\n`);
    }
    return {
      exitCode: ALAYA_SYSEXITS.OK,
      json: {
        ok: true,
        target,
        changed: result.changed,
        changed_paths: result.auditRow?.changed_paths ?? [],
        records: result.auditRow?.records ?? []
      }
    };
  } catch (error) {
    return reportDetachError(ctx.stderr, error);
  }
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
