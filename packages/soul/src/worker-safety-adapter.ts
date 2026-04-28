import {
  WorkerBaselineLockSchema,
  type WorkerBaselineLock,
  type WorkerSafetyPort
} from "@do-soul/alaya-protocol";
import type { SoulWorkerSafetyReader } from "./worker-safety-reader.js";

export interface SoulWorkerSafetyAdapterDependencies {
  readonly reader: Pick<
    SoulWorkerSafetyReader,
    | "listStrictClaimRefs"
    | "listActiveHazardObjectRefs"
    | "listGlobalDeniedCategories"
    | "listHardStopRefs"
  >;
  readonly now?: () => string;
}

/**
 * Implements WorkerSafetyPort with read-only SOUL projections only.
 * Reader failures intentionally propagate so Core can fail closed.
 */
export class SoulWorkerSafetyAdapter implements WorkerSafetyPort {
  public readonly kind = "soul-worker-safety-adapter";

  public constructor(private readonly dependencies: SoulWorkerSafetyAdapterDependencies) {}

  public async assembleBaselineLock(workspaceId: string): Promise<WorkerBaselineLock> {
    const [hardConstraintRefs, hazardObjectRefs, deniedToolCategories, hardStopRefs] = await Promise.all([
      this.dependencies.reader.listStrictClaimRefs(workspaceId),
      this.dependencies.reader.listActiveHazardObjectRefs(workspaceId),
      this.dependencies.reader.listGlobalDeniedCategories(),
      this.dependencies.reader.listHardStopRefs(workspaceId)
    ]);

    return WorkerBaselineLockSchema.parse({
      lock_id: crypto.randomUUID(),
      workspace_id: workspaceId,
      hard_constraint_refs: hardConstraintRefs,
      denied_tool_categories: deniedToolCategories,
      hazard_object_refs: hazardObjectRefs,
      hard_stop_refs: hardStopRefs,
      assembled_at: this.dependencies.now?.() ?? new Date().toISOString()
    });
  }
}
