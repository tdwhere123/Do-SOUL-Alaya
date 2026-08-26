import { z } from "zod";

const Key = z.string().min(1);
const Finite = z.number().finite();
const Envelope = z.discriminatedUnion("state", [
  z.object({ state: z.literal("observed"), value: Finite }).strict(),
  z.object({ state: z.literal("observed_negative"), named_consumer: z.enum([
    "h_event", "h_temporal", "h_hidden", "calibrated_negative"
  ]) }).strict(),
  z.object({ state: z.literal("required_but_missing"), witnesses: z.object({
    query_requires: z.literal(true), applicable: z.literal(true),
    producer_available: z.literal(true), candidate_evaluated: z.literal(true),
    completeness_owner: Key, evaluation_exhausted: z.literal(true),
    proven_absence: z.literal(true)
  }).strict() }).strict(),
  z.object({ state: z.literal("not_applicable") }).strict(),
  z.object({ state: z.literal("producer_unavailable") }).strict(),
  z.object({ state: z.literal("not_observed"), reason: z.enum([
    "not_run", "truncated", "cap_exhausted", "frontier_exhausted",
    "unknown_completeness", "missing_rank", "missing_event_time",
    "unparseable_window", "missing_vector", "missing_authority", "absent_from_list"
  ]).optional() }).strict()
]);

const LexicalObservation = z.object({
  lineage: z.literal("lexical"), receipt: z.literal("fts.lexical.observe.v1"),
  correlation: z.literal("dup:lexical-family"), envelope: Envelope,
  domain: z.object({ lane_id: z.enum([
    "exact", "porter", "trigram", "object_key_porter", "object_key_trigram"
  ]), list_n: z.number().int().nonnegative(), status: z.enum([
    "empty", "complete", "truncated"
  ]), raw_key_kind: z.enum(["matched_token_count", "bm25_raw_rank"]) }).strict().nullable()
}).strict();
const EmbeddingObservation = z.object({
  lineage: z.literal("embedding"), receipt: z.literal("embed.observe.v1"),
  correlation: z.literal("dup:embed-max-v1"), envelope: Envelope,
  snapshot: z.object({ status: Envelope.options[0].shape.state.or(z.enum([
    "observed_negative", "required_but_missing", "not_applicable",
    "producer_unavailable", "not_observed"
  ])), value: Finite.nullable(), domain: z.object({
    provider_kind: Key, model_id: Key, dimensions: z.number().int().positive(),
    schema_version: z.number().int().nonnegative()
  }).strict().nullable(), content_hash: Key.nullable() }).strict()
}).strict();
const TemporalDomain = z.union([
  z.object({ kind: z.literal("window"), query_id: Key, start_ms: Finite,
    end_ms: Finite, decay_days: z.literal(90) }).strict(),
  z.object({ kind: z.literal("recency"), query_id: Key, now_iso: Key,
    decay_days: z.literal(365) }).strict()
]);
const TemporalObservation = z.object({
  lineage: z.literal("temporal"), receipt: z.literal("temporal.observe.v1"),
  correlation: z.literal("temporal.observe.v1"), envelope: Envelope,
  evaluator: z.object({ applicable: z.boolean(), parse_state: z.enum([
    "window", "unparseable_date_terms", "recency", "not_applicable"
  ]), clock_state: z.enum(["ok", "unusable"]), candidate_evaluated: z.boolean(),
  event_time: Key.nullable(), domain: TemporalDomain.nullable(), finite_value: Finite.nullable() }).strict()
}).strict();
const SubjectObservation = z.object({
  lineage: z.literal("subject_preference"), receipt: z.literal("subject.observe.v1"),
  correlation: z.literal("subject.observe.v1"), envelope: Envelope,
  domain: z.object({ query_id: Key, applicable_component_ids: z.array(z.enum([
    "preference", "self_reference"
  ])).readonly(), component_operator_ids: z.array(Key).readonly() }).strict(),
  components: z.array(z.object({ component_id: z.enum(["preference", "self_reference"]),
    operator_id: Key, authority_state: z.enum([
      "not_applicable", "disabled", "untrusted", "not_run", "evaluated"
    ]), envelope: Envelope }).strict()).readonly()
}).strict();

export const CaptureCandidateObservationSchema = z.object({
  h_gate: z.enum(["none", "event", "temporal", "hidden"]),
  lineages: z.object({ lexical: LexicalObservation.optional(),
    embedding: EmbeddingObservation.optional(), temporal: TemporalObservation.optional(),
    subject_preference: SubjectObservation.optional() }).strict()
}).strict().readonly();

const ObligationKey = z.object({ kind: z.enum([
  "entity", "relation", "time", "logical_object", "independent_evidence"
]), value: Key }).strict().readonly();
const Coordinate = z.enum(["available", "known_zero", "unavailable", "not_observed", "not_applicable"]);
const OsfStatus = z.enum(["composed", "no_match", "truncated", "rejected", "ineligible", "unavailable"]);
export const CaptureSetUtilitySchema = z.object({
  schema_version: z.literal(1), candidate_key: Key, object_key: Key,
  obligations: z.array(z.object({ key: ObligationKey, raw_atom_ids: z.array(Key).readonly(),
    availability: Coordinate, cover: Finite.min(0).max(1), evaluated: z.boolean() }).strict()).readonly(),
  matches: z.array(z.object({ obligation: ObligationKey, raw_atom_id: Key,
    attribution_kind: z.enum(["typed_query_atom", "typed_fact_frame"]),
    match_strength: Finite.min(0).max(1) }).strict()).readonly(),
  values: z.object({ status: OsfStatus, values: z.array(z.object({ variable_id: Key,
    semantic_identity: Key }).strict()).readonly() }).strict(),
  cid: z.union([z.object({ status: z.literal("unavailable") }).strict(),
    z.object({ status: z.literal("available"), cid: Key,
      grounding: z.enum(["content", "gist", "ref"]) }).strict()]),
  availability: z.object({ facility: z.enum(["not_applicable", "available",
    "partially_unavailable", "unavailable"]), values: OsfStatus,
    evidence_identity: z.enum(["available", "unavailable"]) }).strict()
}).strict().readonly();

const GStatus = z.object({ facility: z.enum(["not_applicable", "available",
  "partially_unavailable", "unavailable"]), values: OsfStatus,
  evidence_identity: z.enum(["available", "unavailable"]) }).strict();
export const CaptureDecisionSchema = z.object({
  schema_version: z.literal(1), candidate_key: Key,
  capture_reason: z.enum(["core_undominated", "cross_frontier_novelty"]),
  G: z.object({ unscaled_remainder: Finite.nonnegative(), Values_v: z.number().int().nonnegative(),
    evidence_novelty_redundancy: z.union([z.literal(0), z.literal(1)]) }).strict(),
  G_status: GStatus, named_novelty: z.object({ facility_keys: z.array(Key).readonly(),
    value_pairs: z.array(Key).readonly(), content_ids: z.array(Key).readonly() }).strict(),
  novelty_core_known_absence: z.array(z.object({ witness: z.enum([
    "facility", "values", "evidence_identity"
  ]), core_candidate_key: Key, status: z.literal("available_known_absent"), basis: Key }).strict()).readonly(),
  max_g_cohort: z.array(Key).readonly(), equal_g_dominance_rejects: z.array(z.object({
    candidate_key: Key, dominated_by: Key }).strict()).readonly(),
  deterministic_tail: z.literal("candidate_key_code_unit_ascending"),
  unresolved_pointwise_tradeoff: z.boolean(), h_gate: z.enum([
    "none", "event", "temporal", "hidden"
  ]), walk_reject: z.enum(["none", "duplicate_object", "dimension_limit", "max_total_tokens"]),
  static_frontier_index: z.number().int().positive().nullable()
}).strict().readonly();

export const CaptureRejectSchema = z.object({ candidate_key: Key, walk_reject: z.enum([
  "duplicate_object", "dimension_limit", "max_total_tokens"
]) }).strict().readonly();
export const CaptureFrontierSchema = z.object({ schema_version: z.literal(1),
  operator_id: z.literal("shadow.frontiers.peel_undominated.v1"),
  layers: z.array(z.object({ index: z.number().int().positive(),
    member_keys: z.array(Key).readonly() }).strict()).readonly() }).strict().readonly();
