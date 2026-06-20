import { z } from "zod";
import { CandidateMemorySignalContentSchema } from "../signals/candidate-memory-signal.js";
import { BoundedIdSchema, BoundedJsonObjectSchema, BoundedLabelSchema, BoundedReasonSchema, IsoDatetimeStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { EdgeClassifyVerdictSchema } from "./garden-tier.js";

const GARDEN_COMPLETE_CANDIDATE_SIGNAL_MAX = 64;
const GARDEN_COMPLETE_EXTRACTED_PROPOSAL_MAX = 32;

export const GardenMcpWorkerRoleSchema = z.enum([
  "janitor",
  "auditor",
  "librarian",
  "host_worker"
]);

export const GardenListPendingTasksRequestSchema = z
  .object({
    role: GardenMcpWorkerRoleSchema.optional(),
    limit: z.number().int().min(1).max(50).default(10)
  })
  .strict()
  .readonly();

export const GardenPendingTaskSnapshotSchema = z
  .object({
    task_id: BoundedIdSchema,
    role: BoundedLabelSchema,
    kind: BoundedLabelSchema,
    created_at: IsoDatetimeStringSchema,
    payload: BoundedJsonObjectSchema
  })
  .strict()
  .readonly();

export const GardenListPendingTasksResponseSchema = z
  .object({
    tasks: z.array(GardenPendingTaskSnapshotSchema).readonly()
  })
  .strict()
  .readonly();

export const GardenClaimTaskRequestSchema = z
  .object({
    task_id: BoundedIdSchema
  })
  .strict()
  .readonly();

export const GardenClaimTaskResponseSchema = z
  .object({
    status: z.enum(["claimed", "already_claimed"]),
    task_id: BoundedIdSchema,
    role: BoundedLabelSchema,
    kind: BoundedLabelSchema,
    payload: BoundedJsonObjectSchema
  })
  .strict()
  .readonly();

// The garden.complete_task result envelope is the discriminated result type
// for the two host-worker task kinds:
//   - POST_TURN_EXTRACT reports `candidate_signals` (anchor-free CONTENT-ONLY
//     shape; the daemon binds workspace_id / run_id / surface_id / source from
//     trusted MCP context + the claimed task row, and Garden-originated
//     extraction has no prior recall delivery to attribute).
//   - EDGE_CLASSIFY reports `edge_verdict` (the supports/derives_from/none
//     pair judgement). The daemon refines the existing heuristic path with the
//     verdict; a "none"/below-floor verdict refines nothing and the inline
//     heuristic verdict stands.
// invariant: exactly one result shape is meaningful per task kind. The handler
// rejects a candidate_signals envelope on an EDGE_CLASSIFY task and an
// edge_verdict envelope on a POST_TURN_EXTRACT task, so a host cannot smuggle
// the wrong result type into a claimed task.
export const GardenTaskResultEnvelopeSchema = z
  .object({
    candidate_signals: z
      .array(CandidateMemorySignalContentSchema)
      .max(GARDEN_COMPLETE_CANDIDATE_SIGNAL_MAX)
      .readonly()
      .optional(),
    edge_verdict: EdgeClassifyVerdictSchema.optional(),
    extracted_proposals: z
      .array(BoundedJsonObjectSchema)
      .max(GARDEN_COMPLETE_EXTRACTED_PROPOSAL_MAX)
      .readonly()
      .optional(),
    notes: BoundedReasonSchema.optional()
  })
  .strict()
  .readonly();

export const GardenCompleteTaskRequestSchema = z
  .object({
    task_id: BoundedIdSchema,
    status: z.enum(["completed", "failed"]),
    result_envelope: GardenTaskResultEnvelopeSchema.optional(),
    last_error_text: BoundedReasonSchema.optional()
  })
  .strict()
  .readonly();

export const GardenCompleteTaskResponseSchema = z
  .object({
    task_id: BoundedIdSchema,
    status: z.enum(["completed", "failed"]),
    events_appended: NonNegativeIntSchema
  })
  .strict()
  .readonly();
