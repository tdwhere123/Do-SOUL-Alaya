import {
  GardenRole,
  GardenTier,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { ConsolidationPlanner } from "@do-soul/alaya-core";
import type { CreateGardenSchedulerRuntimeSupportInput } from "./scheduler-runtime-types.js";

export function createConsolidationCycleRunner(
  input: CreateGardenSchedulerRuntimeSupportInput
): Readonly<{
  runConsolidationCycleTask(task: Readonly<GardenTaskDescriptor>): Promise<void>;
}> {
  return {
    runConsolidationCycleTask: async (task) =>
      await runConsolidationCycleTask(input, task)
  };
}

async function runConsolidationCycleTask(
  input: CreateGardenSchedulerRuntimeSupportInput,
  task: Readonly<GardenTaskDescriptor>
): Promise<void> {
  const completedAt = new Date().toISOString();
  try {
    const skipAuditEntry = await resolveConsolidationSkipAuditEntry(input, task.workspace_id);
    if (skipAuditEntry !== null) {
      await reportConsolidationCompletion(input, task, completedAt, true, [skipAuditEntry], null);
      return;
    }
    const result = await runConsolidationPlan(input, task.workspace_id, completedAt);
    await reportConsolidationCompletion(
      input,
      task,
      completedAt,
      true,
      [`consolidation_cycle:fuse_${result.fuse_outcome}`],
      null
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await reportConsolidationCompletion(input, task, completedAt, false, [], errorMessage);
    input.warn("consolidation cycle task failed; continuing Garden background pass", {
      workspace_id: task.workspace_id,
      error: errorMessage
    });
  }
}

async function resolveConsolidationSkipAuditEntry(
  input: CreateGardenSchedulerRuntimeSupportInput,
  workspaceId: string
): Promise<string | null> {
  if (input.legacyTopologyMutationsEnabled !== true) {
    return "consolidation_deferred:temporal_assertion_provenance_required";
  }
  if (input.consolidationExecutor === null) {
    return "consolidation_skipped:no_durable_budget_table";
  }
  const soulConfig = await input.configService?.getSoulConfig?.(workspaceId);
  return soulConfig !== undefined && !soulConfig.memory_consolidation_enabled
    ? "consolidation_skipped:memory_consolidation_disabled"
    : null;
}

async function runConsolidationPlan(
  input: CreateGardenSchedulerRuntimeSupportInput,
  workspaceId: string,
  completedAt: string
): Promise<Awaited<ReturnType<NonNullable<CreateGardenSchedulerRuntimeSupportInput["consolidationExecutor"]>["runCycle"]>>> {
  if (input.consolidationExecutor === null) {
    throw new Error("consolidation executor unavailable");
  }
  const planner = new ConsolidationPlanner({
    pathRelationRepo: input.pathRelationRepo,
    now: () => completedAt
  });
  const plan = await planner.planCycle(workspaceId);
  return await input.consolidationExecutor.runCycle({
    triggerSource: "native_surface_drift",
    plan
  });
}

async function reportConsolidationCompletion(
  input: CreateGardenSchedulerRuntimeSupportInput,
  task: Readonly<GardenTaskDescriptor>,
  completedAt: string,
  success: boolean,
  auditEntries: readonly string[],
  errorMessage: string | null
): Promise<void> {
  await input.gardenScheduler.reportCompletion({
    task_id: task.task_id,
    task_kind: task.task_kind,
    role: GardenRole.LIBRARIAN,
    tier: GardenTier.TIER_2,
    workspace_id: task.workspace_id,
    success,
    objects_affected: [],
    audit_entries: [...auditEntries],
    error_message: errorMessage,
    completed_at: completedAt
  });
}
