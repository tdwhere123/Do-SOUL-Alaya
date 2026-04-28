import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import { WorkerRunStateSchema } from "../runtime-run.js";
import { GovernanceSubjectSchema } from "../soul/governance-subject.js";
import { ToolAffectedPathsSchema } from "../tool-affected-path.js";

const phaseA1EventTypeValues = [
  "tool.intent.created",
  "tool.intent.approved",
  "tool.intent.denied",
  "tool_call.started",
  "tool_call.completed",
  "worker.state_changed",
  "governance_spam_fault"
] as const;

export const PhaseA1EventType = {
  TOOL_INTENT_CREATED: "tool.intent.created",
  TOOL_INTENT_APPROVED: "tool.intent.approved",
  TOOL_INTENT_DENIED: "tool.intent.denied",
  TOOL_CALL_STARTED: "tool_call.started",
  TOOL_CALL_COMPLETED: "tool_call.completed",
  WORKER_STATE_CHANGED: "worker.state_changed",
  GOVERNANCE_SPAM_FAULT: "governance_spam_fault"
} as const;

export const PhaseA1EventTypeSchema = z.enum(phaseA1EventTypeValues);
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
    executionId: NonEmptyStringSchema,
    toolId: NonEmptyStringSchema,
    requestedBy: ToolIntentRequestedBySchema,
    requestingRunId: NonEmptyStringSchema,
    nodeId: NonEmptyStringSchema.optional(),
    governanceSubject: GovernanceSubjectSchema
  })
  .strict()
  .readonly();

export const ToolIntentApprovedPayloadSchema = z
  .object({
    executionId: NonEmptyStringSchema,
    governanceDecisionRef: NonEmptyStringSchema,
    matchedClaimRefs: z.array(NonEmptyStringSchema).readonly(),
    matchedSlotRefs: z.array(NonEmptyStringSchema).readonly(),
    requiresRedCard: z.boolean()
  })
  .strict()
  .readonly();

export const ToolIntentDeniedPayloadSchema = z
  .object({
    executionId: NonEmptyStringSchema,
    governanceDecisionRef: NonEmptyStringSchema,
    explanationSummary: NonEmptyStringSchema,
    hardConstraintsPresent: z.boolean()
  })
  .strict()
  .readonly();

export const ToolCallStartedPayloadSchema = z
  .object({
    toolCallId: NonEmptyStringSchema,
    workerId: NonEmptyStringSchema.optional(),
    toolId: NonEmptyStringSchema,
    inputSummary: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export const ToolCallCompletedPayloadSchema = z
  .object({
    toolCallId: NonEmptyStringSchema,
    statusKind: ToolCallCompletedStatusKindSchema,
    outputSummary: z.string().optional(),
    durationMs: NonNegativeIntSchema,
    affected_paths: ToolAffectedPathsSchema.nullable().optional()
  })
  .strict()
  .readonly();

export const WorkerStateChangedPayloadSchema = z
  .object({
    workerId: NonEmptyStringSchema,
    state: WorkerStateChangedStateSchema,
    previousState: WorkerRunStateSchema,
    suspendReason: WorkerStateChangedSuspendReasonSchema.optional(),
    returnedObjectRefs: z.array(NonEmptyStringSchema).readonly().optional(),
    abortReason: NonEmptyStringSchema.optional(),
    rollbackAttempted: z.boolean().optional(),
    panicSource: NonEmptyStringSchema.optional(),
    panicSummary: NonEmptyStringSchema.optional()
  })
  .strict()
  .readonly()
  .superRefine((payload, context) => {
    if (payload.state !== "suspended" && payload.suspendReason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "suspendReason is only allowed when state is suspended",
        path: ["suspendReason"]
      });
    }
  });

export const GovernanceSpamFaultPayloadSchema = z
  .object({
    runId: NonEmptyStringSchema,
    nodeId: NonEmptyStringSchema,
    faultSummary: NonEmptyStringSchema
  })
  .strict()
  .readonly();

const phaseA1PayloadSchemas = {
  [PhaseA1EventType.TOOL_INTENT_CREATED]: ToolIntentCreatedPayloadSchema,
  [PhaseA1EventType.TOOL_INTENT_APPROVED]: ToolIntentApprovedPayloadSchema,
  [PhaseA1EventType.TOOL_INTENT_DENIED]: ToolIntentDeniedPayloadSchema,
  [PhaseA1EventType.TOOL_CALL_STARTED]: ToolCallStartedPayloadSchema,
  [PhaseA1EventType.TOOL_CALL_COMPLETED]: ToolCallCompletedPayloadSchema,
  [PhaseA1EventType.WORKER_STATE_CHANGED]: WorkerStateChangedPayloadSchema,
  [PhaseA1EventType.GOVERNANCE_SPAM_FAULT]: GovernanceSpamFaultPayloadSchema
} as const;

export function createPhaseA1EventObjectSchema<T extends keyof typeof phaseA1PayloadSchemas>(
  type: T,
  payloadSchema: (typeof phaseA1PayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const ToolIntentCreatedEventObjectSchema = createPhaseA1EventObjectSchema(
  PhaseA1EventType.TOOL_INTENT_CREATED,
  ToolIntentCreatedPayloadSchema
);
const ToolIntentApprovedEventObjectSchema = createPhaseA1EventObjectSchema(
  PhaseA1EventType.TOOL_INTENT_APPROVED,
  ToolIntentApprovedPayloadSchema
);
const ToolIntentDeniedEventObjectSchema = createPhaseA1EventObjectSchema(
  PhaseA1EventType.TOOL_INTENT_DENIED,
  ToolIntentDeniedPayloadSchema
);
const ToolCallStartedEventObjectSchema = createPhaseA1EventObjectSchema(
  PhaseA1EventType.TOOL_CALL_STARTED,
  ToolCallStartedPayloadSchema
);
const ToolCallCompletedEventObjectSchema = createPhaseA1EventObjectSchema(
  PhaseA1EventType.TOOL_CALL_COMPLETED,
  ToolCallCompletedPayloadSchema
);
const WorkerStateChangedEventObjectSchema = createPhaseA1EventObjectSchema(
  PhaseA1EventType.WORKER_STATE_CHANGED,
  WorkerStateChangedPayloadSchema
);
const GovernanceSpamFaultEventObjectSchema = createPhaseA1EventObjectSchema(
  PhaseA1EventType.GOVERNANCE_SPAM_FAULT,
  GovernanceSpamFaultPayloadSchema
);

export const ToolIntentCreatedEventSchema = ToolIntentCreatedEventObjectSchema.readonly();
export const ToolIntentApprovedEventSchema = ToolIntentApprovedEventObjectSchema.readonly();
export const ToolIntentDeniedEventSchema = ToolIntentDeniedEventObjectSchema.readonly();
export const ToolCallStartedEventSchema = ToolCallStartedEventObjectSchema.readonly();
export const ToolCallCompletedEventSchema = ToolCallCompletedEventObjectSchema.readonly();
export const WorkerStateChangedEventSchema = WorkerStateChangedEventObjectSchema.readonly();
export const GovernanceSpamFaultEventSchema = GovernanceSpamFaultEventObjectSchema.readonly();

export const PhaseA1EventUnionSchema = z
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

export const PhaseA1EventSchema = PhaseA1EventUnionSchema;

export type PhaseA1EventPayloadMap = {
  [K in keyof typeof phaseA1PayloadSchemas]: z.infer<(typeof phaseA1PayloadSchemas)[K]>;
};

export function parsePhaseA1EventPayload<T extends keyof typeof phaseA1PayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): PhaseA1EventPayloadMap[T] {
  const schema = phaseA1PayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase A1 event type: ${String(type)}`);
  }

  return schema.parse(payload) as PhaseA1EventPayloadMap[T];
}

export type PhaseA1EventTypeValue = z.infer<typeof PhaseA1EventTypeSchema>;
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
export type PhaseA1Event = z.infer<typeof PhaseA1EventUnionSchema>;
