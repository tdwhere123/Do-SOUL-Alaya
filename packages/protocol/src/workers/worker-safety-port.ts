import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";
import { ToolCategorySchema } from "../tools/tool-spec.js";

export const WorkerBaselineLockSchema = z
  .object({
    lock_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    hard_constraint_refs: z.array(NonEmptyStringSchema).readonly(),
    denied_tool_categories: z.array(ToolCategorySchema).readonly(),
    hazard_object_refs: z.array(NonEmptyStringSchema).readonly(),
    hard_stop_refs: z.array(NonEmptyStringSchema).readonly(),
    assembled_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type WorkerBaselineLock = z.infer<typeof WorkerBaselineLockSchema>;

/**
 * Cross-package port for assembling Worker Baseline Safety constraints.
 * Defined in protocol so both core and soul can reference it without violating
 * the packages/core !-> packages/soul dependency constraint.
 */
export interface WorkerSafetyPort {
  readonly kind: string;

  /**
   * Assemble the baseline safety lock for a workspace.
   * Must throw when the underlying read-only query layer is unavailable.
   */
  assembleBaselineLock(workspaceId: string): Promise<WorkerBaselineLock>;
}
