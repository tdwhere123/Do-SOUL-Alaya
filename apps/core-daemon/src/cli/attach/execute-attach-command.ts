import { ALAYA_SYSEXITS, type AlayaCliResult } from "../bridge.js";
import {
  applyProfileMutationPlan,
  buildAttachProfileMutationPlan,
  confirmProfileMutation,
  renderProfileMutationPreview,
  type ProfileMutationApplyOptions,
  type ProfileMutationAuditWriter,
  type ProfileMutationConfirmIo,
  type ProfileMutationFs
} from "../../attach/index.js";

export interface TrustStateRecorderPort {
  recordInstalled(agent_target: string): Promise<void>;
  recordConfigured(agent_target: string): Promise<void>;
}

export interface AttachCommandContext extends ProfileMutationConfirmIo {
  readonly env: NodeJS.ProcessEnv;
  readonly stderr: NodeJS.WritableStream;
  readonly jsonRequested?: boolean;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
}

export interface AttachCommandDeps {
  readonly fs?: ProfileMutationFs;
  readonly auditWriter?: ProfileMutationAuditWriter;
  readonly trustStateRecorder?: TrustStateRecorderPort;
  readonly nowIso?: () => string;
  readonly confirm?: (io: ProfileMutationConfirmIo) => Promise<boolean>;
}

type AttachTarget = Parameters<typeof buildAttachProfileMutationPlan>[0];

export async function executeAttachCommand(
  target: AttachTarget,
  successMessage: string,
  ctx: AttachCommandContext,
  deps: AttachCommandDeps
): Promise<AlayaCliResult> {
  const applyOptions = buildApplyOptions(deps);

  try {
    const plan = await buildAttachProfileMutationPlan(target, {
      env: ctx.env,
      fs: deps.fs
    });
    return await applyAttachPlan(target, successMessage, plan, ctx, deps, applyOptions);
  } catch (error) {
    return reportAttachError(ctx.stderr, error);
  }
}

export function reportAttachError(stderr: NodeJS.WritableStream, error: unknown): AlayaCliResult {
  if (error instanceof Error && "exitCode" in error && typeof error.exitCode === "number") {
    stderr.write(`${error.message}\n`);
    return { exitCode: error.exitCode };
  }

  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return { exitCode: ALAYA_SYSEXITS.CANTCREAT };
}

function buildApplyOptions(deps: AttachCommandDeps): ProfileMutationApplyOptions {
  return {
    fs: deps.fs,
    auditWriter: deps.auditWriter,
    allowConflicts: true,
    nowIso: deps.nowIso
  };
}

async function applyAttachPlan(
  target: AttachTarget,
  successMessage: string,
  plan: Awaited<ReturnType<typeof buildAttachProfileMutationPlan>>,
  ctx: AttachCommandContext,
  deps: AttachCommandDeps,
  applyOptions: ProfileMutationApplyOptions
): Promise<AlayaCliResult> {
  writeAttachPreview(ctx, plan);
  if (!plan.operations.some((operation) => operation.changed)) {
    return createNoChangeResult(target, ctx);
  }
  if (ctx.dryRun === true) {
    return createDryRunResult(target, plan);
  }
  if (!(await confirmAttachExecution(ctx, deps))) {
    return createCanceledResult(target, ctx);
  }

  const result = await applyProfileMutationPlan(plan, applyOptions);
  await recordAttachTrust(target, result.changed, deps.trustStateRecorder);
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write(`${successMessage}\n`);
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: {
      ok: true,
      target,
      changed: result.changed,
      changed_paths: result.auditRow?.changed_paths ?? []
    }
  };
}

function writeAttachPreview(
  ctx: AttachCommandContext,
  plan: Awaited<ReturnType<typeof buildAttachProfileMutationPlan>>
): void {
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write(renderProfileMutationPreview(plan));
  }
}

function createNoChangeResult(target: AttachTarget, ctx: AttachCommandContext): AlayaCliResult {
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write(`${target} profile already up to date\n`);
  }
  return { exitCode: ALAYA_SYSEXITS.OK, json: { ok: true, target, changed: false } };
}

function createDryRunResult(
  target: AttachTarget,
  plan: Awaited<ReturnType<typeof buildAttachProfileMutationPlan>>
): AlayaCliResult {
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

async function confirmAttachExecution(
  ctx: AttachCommandContext,
  deps: AttachCommandDeps
): Promise<boolean> {
  if (ctx.yes === true) {
    return true;
  }
  const confirm = deps.confirm ?? confirmProfileMutation;
  return await confirm(ctx);
}

function createCanceledResult(target: AttachTarget, ctx: AttachCommandContext): AlayaCliResult {
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write("canceled\n");
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: { ok: true, target, changed: false, canceled: true }
  };
}

async function recordAttachTrust(
  target: AttachTarget,
  changed: boolean,
  trustStateRecorder?: TrustStateRecorderPort
): Promise<void> {
  if (!changed || trustStateRecorder === undefined) {
    return;
  }
  await trustStateRecorder.recordInstalled(target);
  await trustStateRecorder.recordConfigured(target);
}
