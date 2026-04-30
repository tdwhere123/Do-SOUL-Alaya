import { ALAYA_SYSEXITS, type AlayaCliResult } from "./bridge.js";
import {
  applyProfileMutationPlan,
  buildAttachProfileMutationPlan,
  confirmProfileMutation,
  renderProfileMutationPreview,
  type ProfileMutationApplyOptions,
  type ProfileMutationAuditWriter,
  type ProfileMutationConfirmIo,
  type ProfileMutationFs
} from "../profile-mutation.js";

export interface TrustStateRecorderPort {
  recordInstalled(agent_target: string): Promise<void>;
  recordConfigured(agent_target: string): Promise<void>;
}

export interface AttachCodexCommandContext extends ProfileMutationConfirmIo {
  readonly env: NodeJS.ProcessEnv;
  readonly stderr: NodeJS.WritableStream;
  readonly jsonRequested?: boolean;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
}

export interface AttachCodexCommandDeps {
  readonly fs?: ProfileMutationFs;
  readonly auditWriter?: ProfileMutationAuditWriter;
  readonly trustStateRecorder?: TrustStateRecorderPort;
  readonly nowIso?: () => string;
  readonly confirm?: (io: ProfileMutationConfirmIo) => Promise<boolean>;
}

export interface AttachCodexCommandSpec {
  readonly target: "codex";
  readonly description: string;
  execute(ctx: AttachCodexCommandContext): Promise<AlayaCliResult>;
}

export function createAttachCodexCommandSpec(deps: AttachCodexCommandDeps = {}): AttachCodexCommandSpec {
  return {
    target: "codex",
    description: "Attach Alaya MCP + /alaya-inspect to Codex profile files.",
    execute: async (ctx) => await executeAttachCodex(ctx, deps)
  };
}

async function executeAttachCodex(
  ctx: AttachCodexCommandContext,
  deps: AttachCodexCommandDeps
): Promise<AlayaCliResult> {
  const confirm = deps.confirm ?? confirmProfileMutation;
  const applyOptions: ProfileMutationApplyOptions = {
    fs: deps.fs,
    auditWriter: deps.auditWriter,
    allowConflicts: true,
    nowIso: deps.nowIso
  };

  try {
    const plan = await buildAttachProfileMutationPlan("codex", {
      env: ctx.env,
      fs: deps.fs
    });
    const hasChanges = plan.operations.some((operation) => operation.changed);
    if (ctx.jsonRequested !== true) {
      ctx.stdout.write(renderProfileMutationPreview(plan));
    }

    if (!hasChanges) {
      if (ctx.jsonRequested !== true) {
        ctx.stdout.write("codex profile already up to date\n");
      }
      return { exitCode: ALAYA_SYSEXITS.OK, json: { ok: true, target: "codex", changed: false } };
    }

    if (ctx.dryRun === true) {
      return {
        exitCode: ALAYA_SYSEXITS.OK,
        json: {
          ok: true,
          target: "codex",
          changed: false,
          dry_run: true,
          changed_paths: plan.operations.filter((operation) => operation.changed).map((operation) => operation.path)
        }
      };
    }

    if (ctx.yes !== true && !(await confirm(ctx))) {
      if (ctx.jsonRequested !== true) {
        ctx.stdout.write("canceled\n");
      }
      return { exitCode: ALAYA_SYSEXITS.OK, json: { ok: true, target: "codex", changed: false, canceled: true } };
    }

    const result = await applyProfileMutationPlan(plan, applyOptions);
    if (result.changed) {
      await deps.trustStateRecorder?.recordInstalled("codex");
      await deps.trustStateRecorder?.recordConfigured("codex");
    }
    if (ctx.jsonRequested !== true) {
      ctx.stdout.write("attached codex profile\n");
    }
    return {
      exitCode: ALAYA_SYSEXITS.OK,
      json: {
        ok: true,
        target: "codex",
        changed: result.changed,
        changed_paths: result.auditRow?.changed_paths ?? []
      }
    };
  } catch (error) {
    return reportAttachError(ctx.stderr, error);
  }
}

function reportAttachError(stderr: NodeJS.WritableStream, error: unknown): AlayaCliResult {
  if (error instanceof Error && "exitCode" in error && typeof error.exitCode === "number") {
    stderr.write(`${error.message}\n`);
    return { exitCode: error.exitCode };
  }

  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return { exitCode: ALAYA_SYSEXITS.CANTCREAT };
}
