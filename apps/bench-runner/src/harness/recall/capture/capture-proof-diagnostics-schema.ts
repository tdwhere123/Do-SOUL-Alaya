import { createHash } from "node:crypto";
import { digestRecallFieldIdentity } from "@do-soul/alaya-core";
import {
  compareCodeUnits,
  EvidenceFactFrameFormationCaptureSchema,
  verifyEvidenceFactFrameFormationCapture
} from "@do-soul/alaya-protocol";
import { z } from "zod";
import { OpenSemanticFactorCompositionStatusSchema } from
  "../semantic-factors/open-semantic-factor-diagnostics-schema.js";

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const identityGap = <Reason extends string>(reason: Reason) => z.object({
  status: z.literal("unavailable"),
  reason: z.literal(reason)
}).strict().readonly();
const ObservedKeysUnavailableSchema = identityGap("proof_absent");
// [] would claim a known-empty universe; core emits this unavailable coordinate instead.
const UniverseUnavailableSchema = identityGap("candidate_universe_not_proved");
const UnseenFrontierSchema = z.union([
  z.number().finite(),
  z.object({
    status: z.literal("unavailable"),
    reason: z.literal("producer_order_not_monotone")
  }).strict().readonly()
]);
const LexicalLaneIdSchema = z.enum([
  "exact",
  "porter",
  "trigram",
  "object_key_porter",
  "object_key_trigram"
]);
const LexicalListStatusSchema = z.enum(["empty", "complete", "truncated"]);
const LexicalRawKeyKindSchema = z.enum(["matched_token_count", "bm25_raw_rank"]);
const LexicalLaneRowSchema = z.object({
  candidate_key: z.string().min(1),
  raw_group_key: z.number().finite(),
  lane_index: z.number().int().nonnegative(),
  grouped_ordinal: z.number().finite(),
  observation_state: z.literal("observed")
}).strict().readonly();
const LexicalLaneCaptureSchema = z.object({
  lane_id: LexicalLaneIdSchema,
  raw_key_kind: LexicalRawKeyKindSchema,
  source_priority: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  applicability_source: z.literal("memory_fts_lane"),
  list_n: z.number().int().nonnegative(),
  requested_limit: z.number().int().nonnegative(),
  status: LexicalListStatusSchema,
  rows: z.array(LexicalLaneRowSchema).readonly(),
  unseen_upper_bound: UnseenFrontierSchema
}).strict().superRefine(refineLexicalLane).readonly();
const LexicalLaneHitSchema = z.object({
  lane_id: LexicalLaneIdSchema,
  raw_group_key: z.number().finite(),
  grouped_ordinal: z.number().finite(),
  lane_index: z.number().int().nonnegative()
}).strict().readonly();
const LexicalCandidateProvenanceSchema = z.object({
  candidate_key: z.string().min(1),
  lane_hits: z.array(LexicalLaneHitSchema).readonly(),
  admitted: z.boolean(),
  chosen_lane_id: LexicalLaneIdSchema.nullable(),
  chosen_normalized_rank: z.number().min(0).max(1).nullable(),
  post_merge_index: z.number().int().nonnegative().nullable(),
  discarded_lane_ids: z.array(LexicalLaneIdSchema).readonly()
}).strict().readonly();
const LexicalPostMergeRowSchema = z.object({
  candidate_key: z.string().min(1),
  normalized_rank: z.number().min(0).max(1),
  trigram_rank: z.number().min(0).max(1).optional(),
  object_key_rank: z.number().min(0).max(1).optional()
}).strict().readonly();
const LexicalProducerReceiptSchema = z.object({
  schema_version: z.literal(1),
  receipt_id: z.literal("alaya.recall.x0.lexical-raw-rank.v1"),
  producer_id: z.literal("alaya.storage.mergeKeywordSearchRows.v1"),
  query_run_id: z.string().min(1),
  merge_limit: z.number().int().nonnegative(),
  lanes: z.array(LexicalLaneCaptureSchema).readonly(),
  candidates: z.array(LexicalCandidateProvenanceSchema).readonly(),
  post_merge: z.array(LexicalPostMergeRowSchema).readonly()
}).strict().readonly();
const LexicalIdentitySchema = z.object({
  request_digest: z.union([DigestSchema, identityGap("request_not_sealed")]),
  workspace_id: z.union([z.string().min(1), identityGap("workspace_not_sealed")]),
  snapshot_digest: z.union([DigestSchema, identityGap("snapshot_not_sealed")])
}).strict().readonly();
const LexicalFieldPrefixSchema = z.enum(["lexical_relaxed", "lexical_expanded"]);
const LexicalCapturedProofSchema = z.object({
  schema_version: z.literal(1),
  proof_id: z.literal("alaya.recall.lexical-bound-proof.v1"),
  status: z.literal("captured"),
  receipt: LexicalProducerReceiptSchema,
  observed_candidate_keys: z.array(z.string().min(1)).readonly(),
  evaluated_universe: UniverseUnavailableSchema,
  field_prefix: LexicalFieldPrefixSchema,
  candidate_key_domain: z.literal("memory_object_id"),
  identity: LexicalIdentitySchema,
  proof_digest: DigestSchema
}).strict().superRefine(refineCapturedLexicalProof).readonly();
const LexicalAbsentProofSchema = z.object({
  schema_version: z.literal(1),
  proof_id: z.literal("alaya.recall.lexical-bound-proof.v1"),
  status: z.literal("proof_absent"),
  reason: z.literal("unavailable"),
  receipt: z.null(),
  observed_candidate_keys: ObservedKeysUnavailableSchema,
  evaluated_universe: UniverseUnavailableSchema,
  field_prefix: identityGap("field_prefix_not_sealed"),
  candidate_key_domain: identityGap("candidate_key_domain_not_sealed"),
  identity: LexicalIdentitySchema,
  proof_digest: DigestSchema
}).strict().superRefine(refineLexicalProofDigest).readonly();

export const LexicalBoundProofDiagnosticsSchema = z.union([
  LexicalCapturedProofSchema,
  LexicalAbsentProofSchema
]).readonly();
export const LexicalBoundProofsDiagnosticsSchema =
  z.array(LexicalBoundProofDiagnosticsSchema).min(1).readonly();

const ProvenanceUnavailableReasonSchema = z.enum([
  "certified_osf_receipt_absent",
  "certified_osf_producer_mismatch",
  "osf_formation_not_formed",
  "osf_composition_absent",
  "osf_composition_not_composed",
  "osf_composition_truncated",
  "osf_binding_not_attributed",
  "typed_fact_frame_receipt_absent",
  "typed_fact_frame_producer_absent",
  "typed_fact_frame_formation_unavailable",
  "typed_fact_frame_formation_ineligible",
  "typed_fact_frame_formation_rejected",
  "typed_fact_frame_query_producer_denied",
  "content_owned_excluded",
  "evidence_link_absent",
  "polarity_receipt_absent",
  "relation_validity_receipt_absent",
  "supersession_receipt_absent",
  "contradiction_receipt_absent"
]);
const ProvenanceUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  reason: ProvenanceUnavailableReasonSchema
}).strict().readonly();
const OsfBindingSchema = z.object({
  variable_id: z.string(),
  binding_identity: z.string(),
  semantic_identity: z.string(),
  evidence_id: z.string(),
  query_proposition_id: z.string().optional(),
  evidence_proposition_id: z.string().optional()
}).strict().readonly();
const TypedFactFrameSchema = z.object({
  capture: EvidenceFactFrameFormationCaptureSchema,
  evidence_id: z.string().min(1)
}).strict().superRefine((receipt, context) => {
  try {
    verifyEvidenceFactFrameFormationCapture(receipt.capture, sha256Hex);
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["capture"],
      message: error instanceof Error
        ? error.message
        : "invalid fact-frame formation capture"
    });
  }
}).readonly();
const PolarityReceiptSchema = z.object({
  producer_operator_id: z.string().min(1),
  polarity: z.enum(["positive", "negative"])
}).strict().readonly();
const RelationValidityReceiptSchema = z.object({
  producer_operator_id: z.string().min(1),
  validity: z.enum(["active", "expired", "unknown"])
}).strict().readonly();
const SupersessionReceiptSchema = z.object({
  producer_operator_id: z.string().min(1),
  standing: z.enum(["current", "superseded"]),
  superseding_assertion_id: z.string().optional()
}).strict().readonly();
const ContradictionReceiptSchema = z.object({
  producer_operator_id: z.string().min(1),
  standing: z.enum(["contradicted", "contradicting"]),
  counterpart_id: z.string().optional()
}).strict().readonly();
const available = <T extends z.ZodTypeAny>(value: T) => z.object({
  status: z.literal("available"),
  value
}).strict().readonly();
const coordinate = <T extends z.ZodTypeAny>(value: T) =>
  z.union([available(value), ProvenanceUnavailableSchema]).readonly();
// Empty available lists would encode known-zero; core emits unavailable instead.
const nonemptyListCoordinate = <T extends z.ZodTypeAny>(item: T) =>
  coordinate(z.array(item).min(1).readonly());
const CandidateOsfProvenanceSchema = z.object({
  status: z.enum(["certified", "unavailable"]),
  reason: ProvenanceUnavailableReasonSchema.nullable(),
  formation_status: z.enum([
    "formed",
    "ineligible",
    "unavailable",
    "rejected",
    "absent"
  ]),
  completeness_present: z.boolean(),
  composition_status: z.union([
    OpenSemanticFactorCompositionStatusSchema,
    z.literal("absent")
  ]),
  producer_operator_id: z.string().nullable(),
  bindings: nonemptyListCoordinate(OsfBindingSchema)
}).strict().superRefine(refineCandidateOsf).readonly();
const CandidatePropositionProvenanceSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal("candidate_proposition_provenance_v1"),
  candidate_key: z.string().min(1),
  osf: CandidateOsfProvenanceSchema,
  typed_fact_frames: nonemptyListCoordinate(TypedFactFrameSchema),
  evidence_links: nonemptyListCoordinate(z.string().min(1)),
  polarity: coordinate(PolarityReceiptSchema),
  relation_validity: coordinate(RelationValidityReceiptSchema),
  supersession: coordinate(SupersessionReceiptSchema),
  contradiction: coordinate(ContradictionReceiptSchema)
}).strict().readonly();

export const CandidatePropositionProvenanceDiagnosticsSchema = z
  .record(z.string().min(1), CandidatePropositionProvenanceSchema)
  .superRefine(refineProvenanceRecordKeys)
  .readonly();

function lexicalRankingKeysAreMonotone(
  rows: readonly Readonly<{ readonly raw_group_key: number }>[],
  kind: "matched_token_count" | "bm25_raw_rank"
): boolean {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!.raw_group_key;
    const next = rows[index]!.raw_group_key;
    if (kind === "bm25_raw_rank" && next < previous) return false;
    if (kind === "matched_token_count" && next > previous) return false;
  }
  return true;
}

function refineLexicalLane(
  lane: {
    readonly list_n: number;
    readonly requested_limit: number;
    readonly status: "empty" | "complete" | "truncated";
    readonly raw_key_kind: "matched_token_count" | "bm25_raw_rank";
    readonly rows: readonly {
      readonly grouped_ordinal: number;
      readonly raw_group_key: number;
    }[];
    readonly unseen_upper_bound: number | Readonly<{ readonly status: "unavailable" }>;
  },
  context: z.RefinementCtx
): void {
  if (lane.list_n !== lane.rows.length) {
    context.addIssue({ code: "custom", path: ["list_n"], message: "lane list_n must equal rows" });
  }
  const expected = lane.list_n === 0
    ? "empty"
    : lane.list_n >= lane.requested_limit ? "truncated" : "complete";
  if (lane.status !== expected) {
    context.addIssue({ code: "custom", path: ["status"], message: "lane status does not match closure" });
  }
  if ((lane.status === "empty" || lane.status === "complete") && lane.unseen_upper_bound !== 0) {
    context.addIssue({
      code: "custom",
      path: ["unseen_upper_bound"],
      message: "closed lane frontier must be zero"
    });
  }
  if (lane.status !== "truncated") return;
  const monotone = lexicalRankingKeysAreMonotone(lane.rows, lane.raw_key_kind);
  if (typeof lane.unseen_upper_bound === "number") {
    const last = lane.rows.at(-1)?.grouped_ordinal;
    if (!monotone || last === undefined || lane.unseen_upper_bound !== last) {
      context.addIssue({
        code: "custom",
        path: ["unseen_upper_bound"],
        message: "truncated numeric frontier must equal the last grouped_ordinal on monotone keys"
      });
    }
    return;
  }
  if (monotone) {
    context.addIssue({
      code: "custom",
      path: ["unseen_upper_bound"],
      message: "truncated frontier hid a proved bound"
    });
  }
}

function refineCapturedLexicalProof(
  proof: {
    readonly proof_digest: string;
    readonly field_prefix: "lexical_relaxed" | "lexical_expanded";
    readonly observed_candidate_keys: readonly string[];
    readonly receipt: {
      readonly query_run_id: string;
      readonly merge_limit: number;
      readonly lanes: readonly {
        readonly rows: readonly { readonly candidate_key: string }[];
      }[];
    };
  },
  context: z.RefinementCtx
): void {
  refineLexicalProofDigest(proof, context);
  const expected = uniqueSortedKeys(
    proof.receipt.lanes.flatMap((lane) => lane.rows.map((row) => row.candidate_key))
  );
  if (!sameStringList(proof.observed_candidate_keys, expected)) {
    context.addIssue({
      code: "custom",
      path: ["observed_candidate_keys"],
      message: "observed_candidate_keys must match unique sorted lane rows"
    });
  }
  if (proof.receipt.query_run_id !==
      `memory.keyword.${proof.field_prefix}.depth:${proof.receipt.merge_limit}`) {
    context.addIssue({
      code: "custom",
      path: ["receipt", "query_run_id"],
      message: "query_run_id must bind the sealed lexical field prefix and depth"
    });
  }
}

function refineLexicalProofDigest(
  proof: { readonly proof_digest: string },
  context: z.RefinementCtx
): void {
  const { proof_digest, ...body } = proof;
  if (proof_digest !== digestRecallFieldIdentity(body)) {
    context.addIssue({ code: "custom", message: "lexical bound proof digest mismatch" });
  }
}

function refineCandidateOsf(
  osf: {
    readonly status: "certified" | "unavailable";
    readonly reason: string | null;
    readonly bindings: { readonly status: "available" | "unavailable" };
  },
  context: z.RefinementCtx
): void {
  if (osf.status === "certified") {
    if (osf.reason !== null || osf.bindings.status !== "available") {
      context.addIssue({
        code: "custom",
        message: "certified OSF must have available bindings and a null reason"
      });
    }
    return;
  }
  if (osf.reason === null || osf.bindings.status !== "unavailable") {
    context.addIssue({
      code: "custom",
      message: "unavailable OSF must name a reason and unavailable bindings"
    });
  }
}

function refineProvenanceRecordKeys(
  map: Readonly<Record<string, { readonly candidate_key: string }>>,
  context: z.RefinementCtx
): void {
  for (const [key, row] of Object.entries(map)) {
    if (row.candidate_key !== key) {
      context.addIssue({
        code: "custom",
        path: [key, "candidate_key"],
        message: "provenance record key must equal candidate_key"
      });
    }
  }
}

function uniqueSortedKeys(keys: readonly string[]): readonly string[] {
  return [...new Set(keys)].sort(compareCodeUnits);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
