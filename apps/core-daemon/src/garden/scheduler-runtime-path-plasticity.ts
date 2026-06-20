import { randomUUID } from "node:crypto";
import { GardenTaskKind, GardenTier } from "@do-soul/alaya-protocol";
import {
  createPathPlasticityWatermarkRegistry,
  type PathPlasticityWatermarkRegistry
} from "./path-plasticity-runtime.js";
import type { CreateGardenSchedulerRuntimeSupportInput } from "./scheduler-runtime-types.js";

export function createPathPlasticityRuntimeSupport(
  input: CreateGardenSchedulerRuntimeSupportInput
): Readonly<{
  enqueuePathPlasticityForAllWorkspaces(): Promise<void>;
  markPathPlasticityProcessed(params: {
    readonly workspaceId: string;
    readonly processedThroughIso: string;
    readonly processedAuditEventId?: string | null;
  }): void;
  pathPlasticityPendingPort: {
    clearPendingWorkspace(workspaceId: string): void;
  };
}> {
  const pendingPathPlasticityWorkspaces = new Set<string>();
  const watermark = createRuntimePathPlasticityWatermark(input);
  return {
    enqueuePathPlasticityForAllWorkspaces: async () =>
      await enqueuePathPlasticityForAllWorkspaces(
        input,
        pendingPathPlasticityWorkspaces,
        watermark
      ),
    markPathPlasticityProcessed: (params) =>
      markPathPlasticityProcessed(watermark, params),
    pathPlasticityPendingPort: {
      clearPendingWorkspace(workspaceId: string): void {
        pendingPathPlasticityWorkspaces.delete(workspaceId);
      }
    }
  };
}

function createRuntimePathPlasticityWatermark(
  input: CreateGardenSchedulerRuntimeSupportInput
): PathPlasticityWatermarkRegistry {
  return createPathPlasticityWatermarkRegistry({
    ...(input.pathPlasticityWatermarkRepo === undefined
      ? {}
      : { watermarkRepo: input.pathPlasticityWatermarkRepo })
  });
}

function markPathPlasticityProcessed(
  watermark: PathPlasticityWatermarkRegistry,
  params: {
    readonly workspaceId: string;
    readonly processedThroughIso: string;
    readonly processedAuditEventId?: string | null;
  }
): void {
  watermark.markProcessed(
    params.workspaceId,
    params.processedThroughIso,
    params.processedAuditEventId ?? null,
    new Date().toISOString()
  );
}

async function enqueuePathPlasticityForAllWorkspaces(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>,
  watermark: PathPlasticityWatermarkRegistry
): Promise<void> {
  const workspaces = await input.workspaceRepo.list();
  const nowIso = new Date().toISOString();
  let enqueuedCount = 0;

  for (const workspace of workspaces) {
    const enqueued = enqueuePathPlasticityWorkspace(
      input,
      pendingWorkspaces,
      watermark,
      workspace.workspace_id,
      nowIso
    );
    enqueuedCount += enqueued ? 1 : 0;
  }

  if (enqueuedCount > 0) {
    input.requestBacklogTelemetryCapture(`enqueue:${GardenTaskKind.PATH_PLASTICITY_UPDATE}`);
  }
}

function enqueuePathPlasticityWorkspace(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>,
  watermark: PathPlasticityWatermarkRegistry,
  workspaceId: string,
  nowIso: string
): boolean {
  if (pendingWorkspaces.has(workspaceId)) {
    return false;
  }
  const targetObjectRefs = [watermark.getSince(workspaceId, nowIso), nowIso];
  pendingWorkspaces.add(workspaceId);
  try {
    input.gardenScheduler.enqueue({
      task_id: randomUUID(),
      task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
      required_tier: GardenTier.TIER_2,
      workspace_id: workspaceId,
      run_id: null,
      target_object_refs: targetObjectRefs,
      priority: 10,
      created_at: nowIso
    });
    return true;
  } catch (error) {
    pendingWorkspaces.delete(workspaceId);
    throw error;
  }
}
