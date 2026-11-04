import { z } from "zod";
import { CandidateMemorySignalContentSchema } from "../signals/candidate-memory-signal.js";
import { BoundedIdSchema, BoundedJsonObjectSchema, BoundedLabelSchema, BoundedReasonSchema, IsoDatetimeStringSchema, NonNegativeIntSchema, boundedJsonObjectSchema } from "../shared/schema-primitives.js";
import { EdgeClassifyVerdictSchema } from "../garden/garden-tier.js";
import { SOURCE_STATEMENT_LIMITS } from "../garden/source-statements.js";

const GARDEN_COMPLETE_CANDIDATE_SIGNAL_MAX = 64;
const GARDEN_COMPLETE_EXTRACTED_PROPOSAL_MAX = 32;
// A valid turn digest can contain 50 excerpts plus up to 1000 delivered IDs;
// JSON escaping can expand each UTF-16 code unit to six characters.
export const GARDEN_TASK_PAYLOAD_MAX_CHARS = 7_000_000;
const GardenTaskPayloadSchema = boundedJsonObjectSchema(GARDEN_TASK_PAYLOAD_MAX_CHARS);

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
    payload: GardenTaskPayloadSchema
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
    payload: GardenTaskPayloadSchema
  })
  .strict()
  .readonly();

// The garden.complete_task result envelope is the discriminated result type
// for the two host-worker task kinds:
//   - SOURCE_STATEMENT_SESSION reports recorded `source_statement_responses`. The shared
//     session receiver validates text/relation siblings; the daemon owns all binding.
//     Other candidate-signal tasks retain their explicit content-only ingress.
//   - EDGE_CLASSIFY reports `edge_verdict` (the supports/derives_from/none
//     pair judgement). The daemon refines the existing heuristic path with the
//     verdict; a "none"/below-floor verdict refines nothing and the inline
//     heuristic verdict stands.
// invariant: exactly one result shape is meaningful per task kind. The handler
// rejects candidate_signals on SOURCE_STATEMENT_SESSION and source_statement_responses
// on other task kinds, so a host cannot smuggle
// the wrong result type into a claimed task.
export const GardenTaskResultEnvelopeSchema = z
  .object({
    source_statement_responses: z.array(z.object({
      chunk_index: NonNegativeIntSchema,
      raw_json: z.string().max(SOURCE_STATEMENT_LIMITS.responseBytes)
    }).strict().readonly()).max(SOURCE_STATEMENT_LIMITS.requestMessages)
      .refine(rows => rows.reduce((bytes, row) => bytes + new TextEncoder().encode(row.raw_json).length, 0) <= 4 * 1024 * 1024,
        "statement responses exceed completion capacity").readonly().optional(),
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
    events_appended: NonNegativeIntSchema,
    failed_candidate_signals_count: NonNegativeIntSchema.optional(),
    unknown_candidate_signals_count: NonNegativeIntSchema.optional()
  })
  .strict()
  .readonly();
