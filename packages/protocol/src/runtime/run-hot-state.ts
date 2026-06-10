import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { RunStateSchema } from "./run.js";
import {
  GovernanceSpamFaultPayloadSchema,
  ToolCallCompletedStatusKindSchema,
  WorkerStateChangedStateSchema,
  WorkerStateChangedSuspendReasonSchema
} from "../events/tool-worker.js";
import { WorkerIntegrationStatusPayloadSchema } from "../events/worker-runtime.js";
import { SoulInteractionRiskLevelSchema } from "../events/file-approval.js";

const engineStatusValues = ["idle", "streaming", "error"] as const;

export const EngineStatus = {
  IDLE: "idle",
  STREAMING: "streaming",
  ERROR: "error"
} as const;

export const EngineStatusSchema = z.enum(engineStatusValues);

const RunHotStateObjectSchema = z.object({
  run_id: NonEmptyStringSchema,
  run_state: RunStateSchema,
  active_surface_id: NonEmptyStringSchema.nullable(),
  last_message_at: IsoDatetimeStringSchema.nullable(),
  engine_status: EngineStatusSchema,
  updated_at: IsoDatetimeStringSchema
});

export const RunHotStateSchema = RunHotStateObjectSchema.readonly();

export const RunSnapshotSurfaceApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);

export const RunSnapshotSurfaceWorkerStateSchema = z
  .object({
    worker_id: NonEmptyStringSchema,
    status: WorkerStateChangedStateSchema,
    suspend_reason: WorkerStateChangedSuspendReasonSchema.optional()
  })
  .strict()
  .readonly();

export const RunSnapshotSurfaceToolStateSchema = z
  .object({
    tool_call_id: NonEmptyStringSchema,
    worker_id: NonEmptyStringSchema.nullable(),
    tool_id: NonEmptyStringSchema,
    input_summary: NonEmptyStringSchema,
    status_kind: ToolCallCompletedStatusKindSchema.or(z.literal("running")),
    output_summary: z.string().nullable(),
    duration_ms: NonNegativeIntSchema.nullable()
  })
  .strict()
  .readonly();

export const RunSnapshotSurfaceApprovalSchema = z
  .object({
    approval_id: NonEmptyStringSchema,
    message_id: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    risk_level: SoulInteractionRiskLevelSchema.optional(),
    status: RunSnapshotSurfaceApprovalStatusSchema,
    resolved_at: IsoDatetimeStringSchema.optional()
  })
  .strict()
  .readonly();

export const RunSnapshotSurfaceStateSchema = z
  .object({
    workers: z.array(RunSnapshotSurfaceWorkerStateSchema).readonly().optional(),
    worker_integration_statuses: z.array(WorkerIntegrationStatusPayloadSchema).readonly().optional(),
    tools: z.array(RunSnapshotSurfaceToolStateSchema).readonly().optional(),
    governance_fault: GovernanceSpamFaultPayloadSchema.nullable().optional(),
    approvals: z.array(RunSnapshotSurfaceApprovalSchema).readonly().optional()
  })
  .strict()
  .readonly();

export const RunSnapshotSchema = RunHotStateObjectSchema.extend({
  bootstrap_control_plane_cutoff_event_id: NonEmptyStringSchema.nullable(),
  surface_state: RunSnapshotSurfaceStateSchema
}).readonly();

export type EngineStatus = z.infer<typeof EngineStatusSchema>;
export type RunHotState = z.infer<typeof RunHotStateSchema>;
export type RunSnapshotSurfaceApprovalStatus = z.infer<typeof RunSnapshotSurfaceApprovalStatusSchema>;
export type RunSnapshotSurfaceWorkerState = z.infer<typeof RunSnapshotSurfaceWorkerStateSchema>;
export type RunSnapshotSurfaceToolState = z.infer<typeof RunSnapshotSurfaceToolStateSchema>;
export type RunSnapshotSurfaceApproval = z.infer<typeof RunSnapshotSurfaceApprovalSchema>;
export type RunSnapshotSurfaceState = z.infer<typeof RunSnapshotSurfaceStateSchema>;
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
