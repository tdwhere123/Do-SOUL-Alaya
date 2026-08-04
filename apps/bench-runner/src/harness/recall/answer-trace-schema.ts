import { z } from "zod";

const TRACE_EPSILON = 1e-9;
const AGGREGATE_SHAPES = new Set(["count", "sum", "distinct_entities"]);

export const RecallAnswerShapeSchema = z.enum([
  "place",
  "duration",
  "count",
  "sum",
  "distinct_entities"
]);

export const RecallAnswerShapePlanSchema = z
  .object({
    schema_version: z.literal(1),
    status: z.enum(["high_confidence", "ambiguous", "unknown"]),
    shape: RecallAnswerShapeSchema.nullable(),
    target_terms: z.array(z.string()).readonly(),
    relation_terms: z.array(z.string()).readonly()
  })
  .strict()
  .superRefine((plan, context) => {
    const highConfidence = plan.status === "high_confidence";
    if (highConfidence && plan.shape === null) {
      addIssue(context, ["shape"], "high-confidence answer shape must be known");
    }
    if (highConfidence && plan.target_terms.length === 0) {
      addIssue(context, ["target_terms"], "high-confidence answer shape needs a target");
    }
    if (!highConfidence && (
      plan.shape !== null ||
      plan.target_terms.length > 0 ||
      plan.relation_terms.length > 0
    )) {
      addIssue(context, [], "ambiguous or unknown answer shape must be empty");
    }
  })
  .readonly();

const RecallCandidateAnswerSupportFieldsSchema = z
  .object({
    schema_version: z.literal(1),
    shape: RecallAnswerShapeSchema,
    status: z.enum([
      "compatible",
      "value_only",
      "unsupported",
      "observation_only",
      "ineligible"
    ]),
    eligible: z.boolean(),
    value_supported: z.boolean(),
    target_supported: z.boolean(),
    relation_supported: z.boolean(),
    matched_target_terms: z.array(z.string()).readonly(),
    matched_relation_terms: z.array(z.string()).readonly(),
    authority: z.object({
      schema_version: z.literal(1),
      provenance_status: z.enum(["verified_user_assertion", "unverified"]),
      subject_status: z.enum(["bound", "conflicted", "unknown"]),
      target_status: z.enum(["bound", "partial", "missing"]),
      relation_status: z.enum(["bound", "conflicted", "missing"]),
      event_status: z.enum(["asserted", "prospective", "negated", "reversed"]),
      time_status: z.enum(["not_requested", "compatible", "conflicted", "unknown"]),
      binding_status: z.enum(["unique", "missing_or_ambiguous"]),
      behavior_eligible: z.boolean(),
      evidence_ref: z.string().nullable()
    }).strict().readonly().optional()
  })
  .strict();

type CandidateAnswerSupportTrace = z.infer<
  typeof RecallCandidateAnswerSupportFieldsSchema
>;

export const RecallCandidateAnswerSupportSchema =
  RecallCandidateAnswerSupportFieldsSchema
  .superRefine((support, context) => {
    validateSupportFlags(support, context);
    validateSupportStatus(support, context);
    validateSupportAuthority(support, context);
  })
  .readonly();

export const RecallAnswerSupportObservationSchema = z
  .object({
    schema_version: z.literal(1),
    source_identity: z.string().min(1),
    support_identity: z.string().min(1).nullable(),
    evidence_ref: z.string().min(1),
    source_role: z.literal("user"),
    projection_kind: z.enum(["atomic_assertion", "turn_projection"]),
    provenance_status: z.enum([
      "verified_user_assertion",
      "verified_user_turn"
    ]),
    query_status: z.enum([
      "compatible",
      "value_only",
      "unsupported",
      "observation_only",
      "ineligible",
      "unresolved"
    ]),
    event_status: z.enum([
      "asserted",
      "prospective",
      "negated",
      "reversed",
      "unknown"
    ]),
    time_status: z.enum([
      "not_requested",
      "compatible",
      "conflicted",
      "unknown"
    ]),
    behavior_eligible: z.boolean()
  })
  .strict()
  .superRefine((observation, context) => {
    const atomic = observation.projection_kind === "atomic_assertion";
    const expectedProvenance = atomic
      ? "verified_user_assertion"
      : "verified_user_turn";
    if (observation.source_identity !== `evidence_ref:${observation.evidence_ref}`) {
      addIssue(
        context,
        ["source_identity"],
        "source identity must bind the declared evidence ref"
      );
    }
    if (observation.provenance_status !== expectedProvenance) {
      addIssue(
        context,
        ["provenance_status"],
        "projection kind and provenance must agree"
      );
    }
    if (atomic !== (observation.support_identity !== null)) {
      addIssue(
        context,
        ["support_identity"],
        "only atomic assertions may claim an answer-support identity"
      );
    }
    const behaviorEligible = atomic &&
      observation.support_identity !== null &&
      (
        observation.query_status === "compatible" ||
        observation.query_status === "value_only"
      ) &&
      observation.event_status === "asserted" &&
      (
        observation.time_status === "not_requested" ||
        observation.time_status === "compatible"
      );
    if (observation.behavior_eligible && !behaviorEligible) {
      addIssue(
        context,
        ["behavior_eligible"],
        "behavior eligibility requires compatible verified atomic support"
      );
    }
  })
  .readonly();

const RecallDeepHeadTraceFieldsSchema = z
  .object({
    lexical_agreement: z.number().min(0).max(1),
    evidence_agreement: z.number().min(0).max(1),
    resolved_evidence: z.number().min(0).max(1),
    embedding_signal: z.number().min(0).max(1).nullable(),
    fusion_baseline_used: z.boolean(),
    resolved_score: z.number().min(0).max(1).nullable(),
    score_source: z.enum([
      "cross_encoder",
      "cross_encoder_unscored",
      "embedding_evidence",
      "fusion_embedding_evidence",
      "fusion_evidence",
      "evidence_only",
      "inactive"
    ])
  })
  .strict();

type DeepHeadTrace = z.infer<typeof RecallDeepHeadTraceFieldsSchema>;

export const RecallDeepHeadTraceSchema = RecallDeepHeadTraceFieldsSchema
  .superRefine((trace, context) => {
    const recomposedEvidence = Math.max(
      trace.lexical_agreement,
      trace.evidence_agreement
    );
    if (!approximatelyEqual(trace.resolved_evidence, recomposedEvidence)) {
      addIssue(context, ["resolved_evidence"], "resolved evidence does not recompose");
    }
    validateDeepHeadSource(trace, context);
  })
  .readonly();

function validateSupportFlags(
  support: CandidateAnswerSupportTrace,
  context: z.RefinementCtx
): void {
  const targetMatched = support.matched_target_terms.length > 0;
  if (support.target_supported !== targetMatched) {
    addIssue(context, ["target_supported"], "target flag must match target terms");
  }
  if (!support.relation_supported && support.matched_relation_terms.length > 0) {
    addIssue(context, ["matched_relation_terms"], "unsupported relation cannot match terms");
  }
}

function validateSupportStatus(
  support: CandidateAnswerSupportTrace,
  context: z.RefinementCtx
): void {
  const aggregate = AGGREGATE_SHAPES.has(support.shape);
  const allSupported = support.value_supported &&
    support.target_supported &&
    support.relation_supported;
  const valid = support.status === "compatible"
    ? support.eligible && !aggregate && allSupported
    : support.status === "value_only"
      ? support.eligible && !aggregate && support.value_supported && !allSupported
      : support.status === "unsupported"
        ? support.eligible && !aggregate && !support.value_supported
        : support.status === "observation_only"
          ? support.eligible && aggregate && !support.value_supported
          : !support.eligible;
  if (!valid) addIssue(context, ["status"], "answer-support state is inconsistent");
}

function validateSupportAuthority(
  support: CandidateAnswerSupportTrace,
  context: z.RefinementCtx
): void {
  const authority = support.authority;
  if (authority === undefined) return;
  const verified = authority.provenance_status === "verified_user_assertion";
  if (verified !== (authority.evidence_ref !== null)) {
    addIssue(context, ["authority", "evidence_ref"], "verified authority needs one evidence ref");
  }
  if (AGGREGATE_SHAPES.has(support.shape) || !support.eligible) {
    addIssue(context, ["authority"], "authority is scalar and eligible-memory only");
    return;
  }
  const behaviorEligible = support.value_supported &&
    verified &&
    authority.subject_status === "bound" &&
    authority.target_status === "bound" &&
    authority.relation_status === "bound" &&
    authority.event_status === "asserted" &&
    authority.binding_status === "unique" &&
    (authority.time_status === "not_requested" || authority.time_status === "compatible");
  if (authority.behavior_eligible !== behaviorEligible) {
    addIssue(context, ["authority", "behavior_eligible"], "authority state is inconsistent");
  }
}

function validateDeepHeadSource(
  trace: DeepHeadTrace,
  context: z.RefinementCtx
): void {
  const resolved = trace.resolved_score;
  const valid = trace.score_source === "inactive"
    ? resolved === null &&
      trace.embedding_signal === null &&
      !trace.fusion_baseline_used &&
      trace.resolved_evidence === 0
    : trace.score_source === "cross_encoder"
      ? resolved !== null && !trace.fusion_baseline_used
      : trace.score_source === "cross_encoder_unscored"
        ? resolved === 0 && !trace.fusion_baseline_used
        : validateLightweightSource(trace);
  if (!valid) addIssue(context, ["score_source"], "deep-head source is inconsistent");
}

function validateLightweightSource(
  trace: DeepHeadTrace
): boolean {
  if (trace.resolved_score === null) return false;
  if (trace.score_source === "fusion_embedding_evidence") {
    return trace.embedding_signal !== null && trace.fusion_baseline_used;
  }
  if (trace.score_source === "embedding_evidence") {
    return trace.embedding_signal !== null &&
      !trace.fusion_baseline_used &&
      approximatelyEqual(
        trace.resolved_score,
        probabilisticOr(trace.embedding_signal, trace.resolved_evidence)
      );
  }
  if (trace.score_source === "fusion_evidence") {
    return trace.embedding_signal === null && trace.fusion_baseline_used;
  }
  return trace.score_source === "evidence_only" &&
    trace.embedding_signal === null &&
    !trace.fusion_baseline_used &&
    approximatelyEqual(trace.resolved_score, trace.resolved_evidence);
}

function probabilisticOr(left: number, right: number): number {
  return left + right - left * right;
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
