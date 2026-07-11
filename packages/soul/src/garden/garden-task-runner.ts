import type {
  GardenRoleValue,
  GardenTaskDescriptor,
  GardenTaskKindValue,
  GardenTaskResult,
  GardenTierValue
} from "@do-soul/alaya-protocol";

export type GardenTaskHandler = (
  task: GardenTaskDescriptor,
  completedAt: string
) => Promise<GardenTaskResult>;

export interface GardenTaskResultContext {
  readonly role: GardenRoleValue;
  readonly tier: GardenTierValue;
}

export function formatGardenTaskError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export function createGardenSuccessResult(
  ctx: GardenTaskResultContext,
  task: GardenTaskDescriptor,
  completedAt: string,
  objectIds: readonly string[],
  auditEntries: readonly string[]
): GardenTaskResult {
  return {
    task_id: task.task_id,
    task_kind: task.task_kind,
    role: ctx.role,
    tier: ctx.tier,
    workspace_id: task.workspace_id,
    success: true,
    objects_affected: [...objectIds],
    audit_entries: [...auditEntries],
    error_message: null,
    completed_at: completedAt
  };
}

export function createGardenFailureResult(
  ctx: GardenTaskResultContext,
  task: GardenTaskDescriptor,
  completedAt: string,
  error: unknown
): GardenTaskResult {
  return {
    task_id: task.task_id,
    task_kind: task.task_kind,
    role: ctx.role,
    tier: ctx.tier,
    workspace_id: task.workspace_id,
    success: false,
    objects_affected: [],
    audit_entries: [],
    error_message: error instanceof Error ? error.message : String(error),
    completed_at: completedAt
  };
}

export async function safeRunGardenTask(input: {
  readonly roleLabel: string;
  readonly task: GardenTaskDescriptor;
  readonly completedAt: string;
  // Handlers map must cover every GardenTaskKind the role may dispatch; an
  // unregistered kind throws at runtime (no compile-time exhaustiveness here).
  readonly handlers: ReadonlyMap<GardenTaskKindValue, GardenTaskHandler>;
  readonly createFailureResult: (
    task: GardenTaskDescriptor,
    completedAt: string,
    error: unknown
  ) => GardenTaskResult;
  readonly reportCompletion: (result: GardenTaskResult) => Promise<void>;
}): Promise<GardenTaskResult> {
  try {
    const handler = input.handlers.get(input.task.task_kind);
    if (handler === undefined) {
      throw new Error(`${input.roleLabel} does not handle task kind: ${input.task.task_kind}`);
    }
    return await handler(input.task, input.completedAt);
  } catch (error) {
    const result = input.createFailureResult(input.task, input.completedAt, error);
    // A reportCompletion failure must not mask the original task error.
    try {
      await input.reportCompletion(result);
    } catch (reportError) {
      process.emitWarning(`[${input.roleLabel}] reportCompletion failed for failed task`, {
        code: "ALAYA_GARDEN_REPORT_COMPLETION_FAILED",
        detail: JSON.stringify({
          task_id: input.task.task_id,
          task_kind: input.task.task_kind,
          workspace_id: input.task.workspace_id,
          task_error: formatGardenTaskError(error),
          report_error: formatGardenTaskError(reportError)
        })
      });
    }
    return result;
  }
}
