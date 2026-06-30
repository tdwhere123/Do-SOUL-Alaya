import { z } from "zod";
import {
  BoundedIdSchema,
  BoundedLabelSchema,
  BoundedReasonSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";
import { WorkerRunStateSchema } from "../runtime/runtime-run.js";
import { GovernanceSubjectSchema } from "../soul/governance-subject.js";
import { ToolAffectedPathsSchema } from "../tools/tool-affected-path.js";

const toolWorkerEventTypeValues = [
  "tool.intent.created",
  "tool.intent.approved",
  "tool.intent.denied",
  "tool_call.started",
  "tool_call.completed",
  "worker.state_changed",
  "governance_spam_fault"
] as const;

export const ToolWorkerEventType = {
  TOOL_INTENT_CREATED: "tool.intent.created",
  TOOL_INTENT_APPROVED: "tool.intent.approved",
  TOOL_INTENT_DENIED: "tool.intent.denied",
  TOOL_CALL_STARTED: "tool_call.started",
  TOOL_CALL_COMPLETED: "tool_call.completed",
  WORKER_STATE_CHANGED: "worker.state_changed",
  GOVERNANCE_SPAM_FAULT: "governance_spam_fault"
} as const;

export const ToolWorkerEventTypeSchema = z.enum(toolWorkerEventTypeValues);
export const ToolIntentRequestedBySchema = z.enum(["principal", "worker"]);
export const ToolCallCompletedStatusKindSchema = z.enum(["success", "error", "denied"]);
export const WorkerStateChangedStateSchema = z.enum(["active", "suspended", "completed", "aborted", "frozen"]);
export const WorkerStateChangedSuspendReasonSchema = z.enum([
  "lease_cascade",
  "native_surface_drift",
  "node_fuse",
  "obligation_violation"
]);

export const ToolIntentCreatedPayloadSchema = z
  .object({
    executionId: BoundedIdSchema,
    toolId: BoundedLabelSchema,
    requestedBy: ToolIntentRequestedBySchema,
    requestingRunId: BoundedIdSchema,
    nodeId: BoundedIdSchema.optional(),
    governanceSubject: GovernanceSubjectSchema
  })
  .strict()
  .readonly();

export const ToolIntentApprovedPayloadSchema = z
  .object({
    executionId: BoundedIdSchema,
    governanceDecisionRef: BoundedIdSchema,
    matchedClaimRefs: z.array(BoundedIdSchema).readonly(),
    matchedSlotRefs: z.array(BoundedIdSchema).readonly(),
    requiresRedCard: z.boolean()
  })
  .strict()
  .readonly();

export const ToolIntentDeniedPayloadSchema = z
  .object({
    executionId: BoundedIdSchema,
    governanceDecisionRef: BoundedIdSchema,
    explanationSummary: BoundedReasonSchema,
    hardConstraintsPresent: z.boolean()
  })
  .strict()
  .readonly();

export const ToolCallStartedPayloadSchema = z
  .object({
    toolCallId: BoundedIdSchema,
    workerId: BoundedIdSchema.optional(),
    toolId: BoundedLabelSchema,
    inputSummary: BoundedReasonSchema
  })
  .strict()
  .readonly();

export const ToolCallCompletedPayloadSchema = z
  .object({
    toolCallId: BoundedIdSchema,
    statusKind: ToolCallCompletedStatusKindSchema,
    outputSummary: BoundedReasonSchema.optional(),
    durationMs: NonNegativeIntSchema,
    affected_paths: ToolAffectedPathsSchema.nullable().optional()
  })
  .strict()
  .readonly();

export const WorkerStateChangedPayloadSchema = z
  .object({
    workerId: BoundedIdSchema,
    state: WorkerStateChangedStateSchema,
    previousState: WorkerRunStateSchema,
    suspendReason: WorkerStateChangedSuspendReasonSchema.optional(),
    returnedObjectRefs: z.array(BoundedIdSchema).readonly().optional(),
    abortReason: BoundedReasonSchema.optional(),
    rollbackAttempted: z.boolean().optional(),
    panicSource: BoundedLabelSchema.optional(),
    panicSummary: BoundedReasonSchema.optional()
  })
  .strict()
  .readonly()
  .superRefine((payload, context) => {
    if (payload.state !== "suspended" && payload.suspendReason !== undefined) {
      context.addIssue({
        code: "custom",
        message: "suspendReason is only allowed when state is suspended",
        path: ["suspendReason"]
      });
    }
  });

export const GovernanceSpamFaultPayloadSchema = z
  .object({
    runId: BoundedIdSchema,
    nodeId: BoundedIdSchema,
    faultSummary: BoundedReasonSchema
  })
  .strict()
  .readonly();

const toolWorkerPayloadSchemas = {
  [ToolWorkerEventType.TOOL_INTENT_CREATED]: ToolIntentCreatedPayloadSchema,
  [ToolWorkerEventType.TOOL_INTENT_APPROVED]: ToolIntentApprovedPayloadSchema,
  [ToolWorkerEventType.TOOL_INTENT_DENIED]: ToolIntentDeniedPayloadSchema,
  [ToolWorkerEventType.TOOL_CALL_STARTED]: ToolCallStartedPayloadSchema,
  [ToolWorkerEventType.TOOL_CALL_COMPLETED]: ToolCallCompletedPayloadSchema,
  [ToolWorkerEventType.WORKER_STATE_CHANGED]: WorkerStateChangedPayloadSchema,
  [ToolWorkerEventType.GOVERNANCE_SPAM_FAULT]: GovernanceSpamFaultPayloadSchema
} as const;

export function createToolWorkerEventObjectSchema<T extends keyof typeof toolWorkerPayloadSchemas>(
  type: T,
  payloadSchema: (typeof toolWorkerPayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const ToolIntentCreatedEventObjectSchema = createToolWorkerEventObjectSchema(
  ToolWorkerEventType.TOOL_INTENT_CREATED,
  ToolIntentCreatedPayloadSchema
);
const ToolIntentApprovedEventObjectSchema = createToolWorkerEventObjectSchema(
  ToolWorkerEventType.TOOL_INTENT_APPROVED,
  ToolIntentApprovedPayloadSchema
);
const ToolIntentDeniedEventObjectSchema = createToolWorkerEventObjectSchema(
  ToolWorkerEventType.TOOL_INTENT_DENIED,
  ToolIntentDeniedPayloadSchema
);
const ToolCallStartedEventObjectSchema = createToolWorkerEventObjectSchema(
  ToolWorkerEventType.TOOL_CALL_STARTED,
  ToolCallStartedPayloadSchema
);
const ToolCallCompletedEventObjectSchema = createToolWorkerEventObjectSchema(
  ToolWorkerEventType.TOOL_CALL_COMPLETED,
  ToolCallCompletedPayloadSchema
);
const WorkerStateChangedEventObjectSchema = createToolWorkerEventObjectSchema(
  ToolWorkerEventType.WORKER_STATE_CHANGED,
  WorkerStateChangedPayloadSchema
);
const GovernanceSpamFaultEventObjectSchema = createToolWorkerEventObjectSchema(
  ToolWorkerEventType.GOVERNANCE_SPAM_FAULT,
  GovernanceSpamFaultPayloadSchema
);

export const ToolIntentCreatedEventSchema = ToolIntentCreatedEventObjectSchema.readonly();
export const ToolIntentApprovedEventSchema = ToolIntentApprovedEventObjectSchema.readonly();
export const ToolIntentDeniedEventSchema = ToolIntentDeniedEventObjectSchema.readonly();
export const ToolCallStartedEventSchema = ToolCallStartedEventObjectSchema.readonly();
export const ToolCallCompletedEventSchema = ToolCallCompletedEventObjectSchema.readonly();
export const WorkerStateChangedEventSchema = WorkerStateChangedEventObjectSchema.readonly();
export const GovernanceSpamFaultEventSchema = GovernanceSpamFaultEventObjectSchema.readonly();

export const ToolWorkerEventUnionSchema = z
  .discriminatedUnion("type", [
    ToolIntentCreatedEventObjectSchema,
    ToolIntentApprovedEventObjectSchema,
    ToolIntentDeniedEventObjectSchema,
    ToolCallStartedEventObjectSchema,
    ToolCallCompletedEventObjectSchema,
    WorkerStateChangedEventObjectSchema,
    GovernanceSpamFaultEventObjectSchema
  ])
  .readonly();

export const ToolWorkerEventSchema = ToolWorkerEventUnionSchema;

export type ToolWorkerEventPayloadMap = {
  [K in keyof typeof toolWorkerPayloadSchemas]: z.infer<(typeof toolWorkerPayloadSchemas)[K]>;
};

export function parseToolWorkerEventPayload<T extends keyof typeof toolWorkerPayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): ToolWorkerEventPayloadMap[T] {
  const schema = toolWorkerPayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase A1 event type: ${String(type)}`);
  }

  return schema.parse(payload) as ToolWorkerEventPayloadMap[T];
}

export type ToolWorkerEventTypeValue = z.infer<typeof ToolWorkerEventTypeSchema>;
export type ToolIntentRequestedBy = z.infer<typeof ToolIntentRequestedBySchema>;
export type ToolCallCompletedStatusKind = z.infer<typeof ToolCallCompletedStatusKindSchema>;
export type WorkerStateChangedState = z.infer<typeof WorkerStateChangedStateSchema>;
export type WorkerStateChangedSuspendReason = z.infer<typeof WorkerStateChangedSuspendReasonSchema>;
export type ToolIntentCreatedPayload = z.infer<typeof ToolIntentCreatedPayloadSchema>;
export type ToolIntentApprovedPayload = z.infer<typeof ToolIntentApprovedPayloadSchema>;
export type ToolIntentDeniedPayload = z.infer<typeof ToolIntentDeniedPayloadSchema>;
export type ToolCallStartedPayload = z.infer<typeof ToolCallStartedPayloadSchema>;
export type ToolCallCompletedPayload = z.infer<typeof ToolCallCompletedPayloadSchema>;
export type WorkerStateChangedPayload = z.infer<typeof WorkerStateChangedPayloadSchema>;
export type GovernanceSpamFaultPayload = z.infer<typeof GovernanceSpamFaultPayloadSchema>;
export type ToolWorkerEvent = z.infer<typeof ToolWorkerEventUnionSchema>;
