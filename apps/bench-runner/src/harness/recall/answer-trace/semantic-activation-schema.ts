import { z } from "zod";
import {
  factSlotsHaveRequiredRoles,
  RecallFactKeyProjectionFormSchema,
  RecallFactSlotSchema
} from "./fact-key-provenance-schema.js";

const TRACE_EPSILON = 1e-9;

const CandidateActivationObservationSchema = z.object({
  channel: z.string().min(1),
  state: z.enum(["observed", "absent", "ineligible", "invalid"]),
  score: z.number().min(0).max(1).nullable()
}).strict().readonly();

export const CandidateActivationReceiptSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.string().min(1),
  state: z.enum(["observed", "absent", "ineligible", "invalid"]),
  score: z.number().min(0).max(1).nullable(),
  winner: z.object({
    channel: z.string().min(1),
    score: z.number().min(0).max(1)
  }).strict().readonly().nullable(),
  observations: z.array(CandidateActivationObservationSchema).readonly(),
  missing_channel_policy: z.literal("no_op")
}).strict().superRefine((receipt, context) => {
  const observed = receipt.state === "observed";
  if (observed !== (receipt.score !== null && receipt.winner !== null)) {
    addIssue(context, ["state"], "activation state must agree with winner and score");
  }
  if (!observed && (receipt.score !== null || receipt.winner !== null)) {
    addIssue(context, ["state"], "inactive activation cannot carry a score or winner");
  }
  if (receipt.winner !== null && !approximatelyEqual(
    receipt.winner.score,
    receipt.score ?? Number.NaN
  )) {
    addIssue(context, ["winner", "score"], "winner score must equal activation score");
  }
  validateActivationObservations(receipt, context);
}).readonly();

const EvidenceSemanticProjectionSchema = z.object({
  projection_id: z.number().int().positive().nullable(),
  projection_kind: z.enum(["owner", "fact_key"]),
  matched_fact_key_forms: z.array(RecallFactKeyProjectionFormSchema).readonly(),
  fact_slots: z.array(RecallFactSlotSchema).min(3).max(6).readonly().optional()
}).strict().superRefine((projection, context) => {
  const owner = projection.projection_kind === "owner";
  if (owner !== (projection.projection_id === null)) {
    addIssue(context, ["projection_id"], "projection kind and identity must agree");
  }
  if (owner && projection.matched_fact_key_forms.length > 0) {
    addIssue(context, ["matched_fact_key_forms"], "owner projection cannot carry forms");
  }
  if (owner && projection.fact_slots !== undefined) {
    addIssue(context, ["fact_slots"], "owner projection cannot carry fact slots");
  }
  if (projection.fact_slots !== undefined && !factSlotsHaveRequiredRoles(projection.fact_slots)) {
    addIssue(context, ["fact_slots"], "fact slots must contain subject, relation, and value");
  }
}).readonly();

const EvidenceSemanticObservationSchema = z.object({
  score: z.number().min(0).max(1),
  evidenceObjectId: z.string().min(1),
  documentIdentity: z.string().min(1),
  projection: EvidenceSemanticProjectionSchema.nullable()
}).strict().superRefine((observation, context) => {
  if (observation.projection?.projection_kind === "fact_key" &&
      observation.documentIdentity !==
        `fact_key:${String(observation.projection.projection_id)}`) {
    addIssue(context, ["documentIdentity"], "fact-key document identity must bind projection");
  }
  if (observation.projection === null &&
      observation.documentIdentity.startsWith("fact_key:")) {
    addIssue(context, ["projection"], "fact-key document requires projection provenance");
  }
}).readonly();

export const EvidenceSemanticActivationReceiptSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal("evidence_document_max_v1"),
  state: z.literal("observed"),
  score: z.number().min(0).max(1),
  winner: EvidenceSemanticObservationSchema,
  observations: z.array(EvidenceSemanticObservationSchema).min(1).readonly(),
  observation_completeness: z.enum(["complete", "winner_only_legacy"]),
  missing_channel_policy: z.literal("no_op")
}).strict().superRefine((receipt, context) => {
  if (!sameSemanticObservation(receipt.winner, receipt.observations[0]!)) {
    addIssue(context, ["winner"], "winner must be the first attributed observation");
  }
  if (!approximatelyEqual(receipt.score, receipt.winner.score)) {
    addIssue(context, ["score"], "semantic activation score must equal winner");
  }
  if (receipt.observation_completeness === "winner_only_legacy" &&
      receipt.observations.length !== 1) {
    addIssue(context, ["observations"], "legacy receipt may contain only its winner");
  }
  if (!semanticObservationsAreRanked(receipt.observations)) {
    addIssue(context, ["observations"], "semantic observations must be unique and ranked");
  }
}).readonly();

function validateActivationObservations(
  receipt: z.infer<typeof CandidateActivationReceiptSchema>,
  context: z.RefinementCtx
): void {
  const channels = new Set<string>();
  for (const observation of receipt.observations) {
    if (channels.has(observation.channel) ||
        (observation.state === "observed") !== (observation.score !== null)) {
      addIssue(context, ["observations"], "activation observations must be unique and stateful");
      return;
    }
    channels.add(observation.channel);
  }
  if (receipt.winner !== null && !receipt.observations.some((observation) =>
    observation.channel === receipt.winner!.channel &&
    observation.state === "observed" &&
    approximatelyEqual(observation.score ?? Number.NaN, receipt.winner!.score)
  )) {
    addIssue(context, ["winner"], "activation winner must bind an observed channel");
  }
}

function sameSemanticObservation(
  left: z.infer<typeof EvidenceSemanticObservationSchema>,
  right: z.infer<typeof EvidenceSemanticObservationSchema>
): boolean {
  return left.score === right.score &&
    left.evidenceObjectId === right.evidenceObjectId &&
    left.documentIdentity === right.documentIdentity &&
    sameSemanticProjection(left.projection, right.projection);
}

function sameSemanticProjection(
  left: z.infer<typeof EvidenceSemanticProjectionSchema> | null,
  right: z.infer<typeof EvidenceSemanticProjectionSchema> | null
): boolean {
  if (left === null || right === null) return left === right;
  return left.projection_id === right.projection_id &&
    left.projection_kind === right.projection_kind &&
    sameFactSlots(left.fact_slots, right.fact_slots) &&
    left.matched_fact_key_forms.length === right.matched_fact_key_forms.length &&
    left.matched_fact_key_forms.every((form, index) =>
      sameFactKeyForm(form, right.matched_fact_key_forms[index]!)
    );
}

function sameFactSlots(
  left: readonly z.infer<typeof RecallFactSlotSchema>[] | undefined,
  right: readonly z.infer<typeof RecallFactSlotSchema>[] | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((slot, index) =>
    slot.role === right[index]?.role && slot.text === right[index]?.text
  );
}

function sameFactKeyForm(
  left: z.infer<typeof RecallFactKeyProjectionFormSchema>,
  right: z.infer<typeof RecallFactKeyProjectionFormSchema>
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "complete") return true;
  if (right.kind === "complete") return false;
  return left.omitted_slot.slot_index === right.omitted_slot.slot_index &&
    left.omitted_slot.role === right.omitted_slot.role;
}

function semanticObservationsAreRanked(
  observations: readonly z.infer<typeof EvidenceSemanticObservationSchema>[]
): boolean {
  const identities = new Set<string>();
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    const identity = `${observation.evidenceObjectId}\u0000${observation.documentIdentity}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    if (index > 0 && compareSemanticObservations(
      observations[index - 1]!,
      observation
    ) > 0) return false;
  }
  return true;
}

function compareSemanticObservations(
  left: z.infer<typeof EvidenceSemanticObservationSchema>,
  right: z.infer<typeof EvidenceSemanticObservationSchema>
): number {
  if (left.score !== right.score) return right.score - left.score;
  const evidenceOrder = compareText(left.evidenceObjectId, right.evidenceObjectId);
  return evidenceOrder !== 0
    ? evidenceOrder
    : compareText(left.documentIdentity, right.documentIdentity);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= TRACE_EPSILON;
}

function addIssue(
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message });
}
