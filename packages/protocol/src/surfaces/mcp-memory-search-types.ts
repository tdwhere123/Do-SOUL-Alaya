import { z } from "zod";
import { SOURCE_SEMANTIC_PROOF_OBJECT_KIND } from "../recall/conditional-field/index-view.js";
import { QuestionTimeIntervalSchema } from "../recall/conditional-field/question-time.js";
import { CaptureExecutionSchema } from "../recall/selection/capture/capture-execution.js";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedLabelSchema,
  BoundedQuerySchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";
import { MemoryDimensionSchema } from "../memory/memory-entry.js";
import { ScopeClassSchema } from "../memory/object-kind.js";
import { ClaimLifecycleStateSchema } from "../memory/claim-form.js";
import {
  SourceDisclosurePageSlotSchema,
  SourceDisclosureSchema,
  decodePageSourceDisclosure,
  sourceDisclosure,
  type SourceDisclosure
} from "../recall/source-disclosure.js";
import { HostDependencyExposureSchema } from "../conversation/host-dependency-exposure.js";
import { PathGovernanceClassSchema } from "../relations/path-relation.js";
import {
  RecallBudgetStateSchema,
  SourceLookupReasonsSchema,
  RecallScoreFactorsSchema
} from "../recall/recall-candidate.js";
import { StagedWarningArraySchema } from "../governance/staged-warning.js";
import {
  ContinuationSchema,
  InformationIndexSchema,
  OrderStatusSchema,
  PagePurposeSchema,
  PayloadContinuationRequestSchema,
  ProductUpdateSchema
} from "../recall/conditional-field/index-view.js";
import {
  AssociationCapContractSchema,
  ClaimDemandSchema,
  EVIDENCE_CONDITION_LIMITS,
  EvidenceConditionSchema,
  EnumerationPolicySchema,
  QueryInterpretationProposalSchema,
  ResultKindViewSchema
} from "../recall/conditional-field/query.js";
import {
  ConditionalFieldIdSchema,
  Sha256DigestSchema
} from "../recall/conditional-field/common.js";
import {
  RecallTargetKindSchema,
  RecallTargetRefSchema,
  SourceEvidenceRootKindSchema
} from "../recall/conditional-field/product-identity.js";

export const SoulMemorySearchDegradationReasonSchema = z.enum([
  "recall_explainability_partial",
  "warm_cascade_engaged",
  "cold_cascade_engaged",
  // Embedding was intended; leave MCP degradation_reason non-null for these failures.
  "provider_missing",
  "provider_unavailable",
  "provider_failed",
  "no_stored_vectors"
]);

const memorySearchResultFields = {
  object_id: NonEmptyStringSchema.optional(),
  object_kind: NonEmptyStringSchema,
  target: RecallTargetRefSchema,
  // Not ranking authority. Delivery order is the parent `results` array.
  // Do not re-sort on this field or score_factors.relevance.
  relevance_score: z.number().min(0).max(1),
  content_preview: NonEmptyStringSchema,
  // Absent on historical results; display text never proves payload availability.
  payload_available: z.boolean().optional(),
  semantic_dependencies: HostDependencyExposureSchema.optional(),
  evidence_pointers: z.array(NonEmptyStringSchema).readonly(),
  hypothesis_id: NonEmptyStringSchema.optional(),
  program_state: NonEmptyStringSchema.optional(),
  time_state: NonEmptyStringSchema.optional(),
  output_binding: NonEmptyStringSchema.optional(),
  source_lookup_reasons: SourceLookupReasonsSchema.optional(),
  // Diagnostic-only prose. Agents must not branch on its wording or use it
  // as a ranking key. The information index owns association and ordering.
  selection_reason: BoundedReasonSchema,
  source_channels: z.array(BoundedLabelSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
  // Public numeric explainability API for soul.recall consumers.
  score_factors: RecallScoreFactorsSchema,
  budget_state: RecallBudgetStateSchema,
  pending_incomplete: z.boolean().optional(),
  unfinishedness_bias: z.number().min(0).max(1).optional(),
  // invariant: optional governance warnings forwarded from the
  // RecallCandidate. Older agents that do not understand the field
  // simply skip it; soul.resolve-aware agents and the Inspector
  // Health Inbox branch on the listed kind / severity / policy.
  // see also: staged-warning.ts (schema),
  // recall-candidate.ts (producer-side field).
  staged_warnings: StagedWarningArraySchema.optional()
} as const;

function refineMemorySearchResultTarget(
  value: Readonly<{
    object_id?: string;
    object_kind: string;
    target: z.infer<typeof RecallTargetRefSchema>;
  }>,
  context: z.RefinementCtx
): "memory_entry" | "source_evidence" {
  if (value.target.kind === "memory_entry") {
    if (value.object_id !== value.target.object_id) {
      context.addIssue({
        code: "custom",
        path: ["object_id"],
        message: "memory_entry object_id must match target.object_id"
      });
    }
    if (value.object_kind !== "memory_entry") {
      context.addIssue({
        code: "custom",
        path: ["object_kind"],
        message: "memory_entry target requires object_kind memory_entry"
      });
    }
    return "memory_entry";
  }
  if (value.object_id !== undefined) {
    // Source-record-only products have no memory object identity.
    context.addIssue({
      code: "custom",
      path: ["object_id"],
      message: "source_evidence must not fill object_id"
    });
  }
  if (value.object_kind !== "source_evidence" && value.object_kind !== SOURCE_SEMANTIC_PROOF_OBJECT_KIND) {
    context.addIssue({
      code: "custom",
      path: ["object_kind"],
      message: "source_evidence target requires object_kind source_evidence or semantic_proof"
    });
  }
  return "source_evidence";
}

export const MemorySearchResultSchema = z
  .object({
    ...memorySearchResultFields,
    source_disclosure: SourceDisclosureSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const kind = refineMemorySearchResultTarget(value, context);
    if (kind !== "source_evidence") return;
    if (value.source_disclosure === undefined) {
      context.addIssue({ code: "custom", path: ["source_disclosure"], message: "source result requires disclosure" });
    } else if (sourceDisclosure(value.source_disclosure).proof_use.kind !== (value.object_kind === SOURCE_SEMANTIC_PROOF_OBJECT_KIND ? "conditional_support" : "source_only")) {
      context.addIssue({ code: "custom", path: ["source_disclosure", "proof_use"], message: "disclosure must match delivered proof kind" });
    }
  })
  .readonly();

export const MemorySearchPageResultWireSchema = z
  .object({
    ...memorySearchResultFields,
    source_disclosure: SourceDisclosurePageSlotSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const kind = refineMemorySearchResultTarget(value, context);
    if (kind === "source_evidence" && value.source_disclosure === undefined) {
      context.addIssue({ code: "custom", path: ["source_disclosure"], message: "source result requires disclosure" });
    }
  })
  .readonly();

export const SoulActiveConstraintGovernanceStateSchema = z
  .object({
    claim_status: ClaimLifecycleStateSchema.nullable(),
    governance_class: PathGovernanceClassSchema.nullable(),
    source_channels: z.array(BoundedLabelSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export const SoulActiveConstraintSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    content: NonEmptyStringSchema,
    dimension: MemoryDimensionSchema,
    scope_class: ScopeClassSchema,
    governance_state: SoulActiveConstraintGovernanceStateSchema
  })
  .strict()
  .readonly();

export const RecallTimeFieldSchema = z.enum(["created_at", "last_used_at"]);

export const SoulRecallTokenizerHintSchema = z.enum([
  "cl100k",
  "o200k",
  "approx_chars_per_token"
]);

export const SoulRecallHostContextSchema = z
  .object({
    tokenizer_hint: SoulRecallTokenizerHintSchema.optional()
  })
  .strict()
  .readonly();

/** Caller-ergonomic closed UTC calendar-day range (`YYYY-MM-DD`); invalid dates degrade safely at admission. */
export const CallerQuestionTimeIntervalSchema = z
  .object({
    start: z.string().min(1).max(64),
    end: z.string().min(1).max(64)
  })
  .strict()
  .readonly();

export const CallerQuestionTimeSchema = z
  .object({
    intervals: z.array(CallerQuestionTimeIntervalSchema).min(1).max(32).readonly()
  })
  .strict()
  .readonly();

export const CallerEvidenceConditionSchema = z
  .object({
    statement: z.string().min(1).max(EVIDENCE_CONDITION_LIMITS.max_characters),
    speaker: z.enum(["user", "assistant"]),
    anchors: z
      .array(z.string().min(1).max(EVIDENCE_CONDITION_LIMITS.max_anchor_characters))
      .max(EVIDENCE_CONDITION_LIMITS.max_anchors)
      .readonly()
  })
  .strict()
  .readonly();

/** Optional caller-formed recall coordinates bound server-side without caller sha256 or clock duplication. */
export const CallerQueryCoordinatesSchema = z
  .object({
    question_time: CallerQuestionTimeSchema.optional(),
    evidence_conditions: z
      .array(CallerEvidenceConditionSchema)
      .min(1)
      .max(EVIDENCE_CONDITION_LIMITS.max_conditions)
      .readonly()
      .optional(),
    evidence_relation: z.literal("derived").optional()
  })
  .strict()
  .readonly();
export type CallerQueryCoordinates = z.infer<typeof CallerQueryCoordinatesSchema>;

/** Workspace-omitted source target handle for opening a member_index root via soul.open_pointer. */
export const SourceOpenTargetSchema = z
  .object({
    root_kind: SourceEvidenceRootKindSchema,
    root_id: ConditionalFieldIdSchema,
    source_version: ConditionalFieldIdSchema,
    content_digest: Sha256DigestSchema,
    evidence_object_id: ConditionalFieldIdSchema.nullable().optional()
  })
  .strict()
  .readonly();
export type SourceOpenTarget = z.infer<typeof SourceOpenTargetSchema>;

const SoulMemorySearchRequestShape = z
  .object({
    query: BoundedQuerySchema,
    scope_class: ScopeClassSchema.nullable().default(null),
    dimension: MemoryDimensionSchema.nullable().default(null),
    domain_tags: z.array(BoundedLabelSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().nullable().default(null),
    // Page budget for the information index, not a ranking tau.
    max_results: NonNegativeIntSchema.max(1000).default(10),
    // Compiler hints for the ordinary-language query; not global associated-item predicates.
    since: IsoDatetimeStringSchema.nullable().optional(),
    until: IsoDatetimeStringSchema.nullable().optional(),
    time_field: RecallTimeFieldSchema.optional(),
    host_context: SoulRecallHostContextSchema.optional(),
    /** @deprecated Ignored by Recall; hosts capture messages with soul.capture_host_session. */
    recent_turn: BoundedQuerySchema.optional(),
    // Maps to the query interpretation clock.
    source_observed_at: IsoDatetimeStringSchema.optional(),
    active_constraints_cap: NonNegativeIntSchema.max(50).optional(),
    // Resume a previously issued index page. Identity must match query/snapshot/result.
    continuation: ContinuationSchema.optional(),
    // The live ordinary route is native query navigation. The legacy values stay
    // parseable for historical readers but are rejected by live execution.
    enumeration_policy: EnumerationPolicySchema.default("native_query"),
    result_kind_view: ResultKindViewSchema.default("mixed"),
    query_coordinates: CallerQueryCoordinatesSchema.optional(),
    interpretation_proposal: QueryInterpretationProposalSchema.optional(),
    payload_continuation: PayloadContinuationRequestSchema.optional(),
    protocol_version: NonNegativeIntSchema.min(1).optional(),
    supported_result_kinds: z.array(RecallTargetKindSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    supports_source_evidence: z.boolean().optional(),
    supports_product_updates: z.boolean().optional(),
    cap_contracts: z.array(AssociationCapContractSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    claim_demands: z.array(ClaimDemandSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.since !== null &&
      value.since !== undefined &&
      value.until !== null &&
      value.until !== undefined &&
      Date.parse(value.since) > Date.parse(value.until)
    ) {
      context.addIssue({
        code: "custom",
        path: ["since"],
        message: "since must be less than or equal to until."
      });
    }
    // Associative is not a shared D2 default; missing contracts are incompatible.
    if (
      value.enumeration_policy === "associative" &&
      (value.cap_contracts === undefined || value.cap_contracts.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["cap_contracts"],
        message:
          "associative enumeration requires declared cap_contracts; absence is incompatible, not a shared default."
      });
    }
  })
  .readonly();

type SoulMemorySearchInput = z.input<typeof SoulMemorySearchRequestShape>;
export const SoulMemorySearchRequestSchema = z.preprocess<unknown, typeof SoulMemorySearchRequestShape, SoulMemorySearchInput>((raw: unknown, context) => {
  if (!isPlainRecord(raw)) return raw;
  if (raw.interpretation_proposal !== undefined) {
    if (raw.query_coordinates !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["query_coordinates"],
        message: "query_coordinates and interpretation_proposal cannot both be provided."
      });
      return z.NEVER;
    }
    return raw;
  }
  const { question_time, evidence_conditions, evidence_relation, query_coordinates, ...request } = raw;
  const coordinates = recoverCallerCoordinates(query_coordinates);
  return coordinates === undefined ? request : { ...request, query_coordinates: coordinates };
}, SoulMemorySearchRequestShape);

function recoverCallerCoordinates(raw: unknown): CallerQueryCoordinates | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const intervals = isPlainRecord(raw.question_time)
    ? recoverBoundedItems(raw.question_time.intervals, QuestionTimeIntervalSchema, 32) : [];
  const conditions = recoverBoundedItems(raw.evidence_conditions, callerEvidenceConditionIngress,
    EVIDENCE_CONDITION_LIMITS.max_conditions);
  const relation = raw.evidence_relation === "derived" ? raw.evidence_relation : undefined;
  if (intervals.length === 0 && conditions.length === 0 && relation === undefined) return undefined;
  return {
    ...(intervals.length === 0 ? {} : { question_time: { intervals } }),
    ...(conditions.length === 0 ? {} : { evidence_conditions: conditions }),
    ...(relation === undefined ? {} : { evidence_relation: relation })
  };
}

const callerEvidenceConditionIngress = z.preprocess((raw: unknown) => {
  if (!isPlainRecord(raw) || !Array.isArray(raw.anchors)) return undefined;
  const anchors = recoverBoundedItems(raw.anchors, EvidenceConditionSchema.unwrap().shape.anchors.unwrap().element,
    EVIDENCE_CONDITION_LIMITS.max_anchors);
  // Only an explicit empty array denotes an intentionally unanchored condition.
  if (raw.anchors.length > 0 && anchors.length === 0) return undefined;
  return { statement: raw.statement, speaker: raw.speaker, anchors };
}, CallerEvidenceConditionSchema);

function recoverBoundedItems<T>(raw: unknown, schema: z.ZodType<T>, limit: number): T[] {
  if (!Array.isArray(raw)) return [];
  const retained: T[] = [];
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    if (parsed.success) retained.push(parsed.data);
    if (retained.length === limit) break;
  }
  return retained;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** First page only: one source-bound line per further member after the ranked results (pool members
 * not on this page, then roots refused only by the nomination limit). A line is an interpretation of the
 * listed statements, never ranking evidence; `statement_ids` or `source_target` open with soul.open_pointer. */
export const RecallMemberIndexLineSchema = z
  .object({
    label: z.string().regex(/^R\d{2,3}$/u),
    root_id: NonEmptyStringSchema,
    date: z.string().max(64).nullable(),
    line: z.string().max(4096),
    producer: z.enum(["source-statements-v1", "first-message"]),
    statement_ids: z.array(NonEmptyStringSchema).max(64).readonly(),
    in_pool: z.boolean(),
    source_target: SourceOpenTargetSchema.optional()
  })
  .strict()
  .readonly();
export type RecallMemberIndexLine = z.infer<typeof RecallMemberIndexLineSchema>;

const soulMemorySearchResponseCommonFields = {
  delivery_id: NonEmptyStringSchema,
  // Additive response marker for sibling consumers. Older daemons omit it;
  // newer ones emit the current protocol value without changing the rest of
  // the recall payload shape.
  protocol_version: NonNegativeIntSchema.min(1).optional(),
  active_constraints: z.array(SoulActiveConstraintSchema).readonly().optional(),
  active_constraints_count: NonNegativeIntSchema.nullable().optional(),
  active_constraints_completeness: z.enum(["complete", "incomplete"]).optional(),
  total_count: NonNegativeIntSchema,
  degradation_reason: SoulMemorySearchDegradationReasonSchema.nullable().optional(),
  /** @deprecated Historical response reader only; current delivery uses index. */
  delivery_path: z.enum(["legacy", "canonical"]).optional(),
  /** @deprecated Historical response reader only. Live ranking ignores this field. Keep parseable in 0.3.x; do not delete until a protocol major after the compatibility ledger expires. */
  ranking_authority: z.enum(["prefix_sk", "select_gamma"]).optional(),
  capture_identity: z.object({
    algorithm_id: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    digest: NonEmptyStringSchema
  }).strict().readonly().optional(),
  capture_execution: CaptureExecutionSchema.optional(),
  index: InformationIndexSchema.optional(),
  order_status: OrderStatusSchema.optional(),
  page_purpose: PagePurposeSchema.optional(),
  product_updates: z.array(ProductUpdateSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
  member_index: z.array(RecallMemberIndexLineSchema).max(128).readonly().optional()
} as const;

const DecodedSoulMemorySearchResponseSchema = z
  .object({
    ...soulMemorySearchResponseCommonFields,
    results: z.array(MemorySearchResultSchema).readonly()
  })
  .strict()
  .readonly();

export const SoulMemorySearchResponseWireSchema = z
  .object({
    ...soulMemorySearchResponseCommonFields,
    results: z.array(MemorySearchPageResultWireSchema).readonly()
  })
  .strict()
  .superRefine((response, context) => {
    let anchor: SourceDisclosure | undefined;
    for (let index = 0; index < response.results.length; index++) {
      const row = response.results[index]!;
      const slot = row.source_disclosure;
      if (slot === undefined) continue;
      if (anchor === undefined && !Array.isArray(slot)) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "source_disclosure"],
          message: "first disclosed row on page must carry a full source disclosure tuple"
        });
        return;
      }
      try {
        const decoded = decodePageSourceDisclosure(slot, anchor);
        anchor ??= decoded;
        if (row.target.kind === "source_evidence") {
          const expected = row.object_kind === SOURCE_SEMANTIC_PROOF_OBJECT_KIND
            ? "conditional_support"
            : "source_only";
          if (sourceDisclosure(decoded).proof_use.kind !== expected) {
            context.addIssue({
              code: "custom",
              path: ["results", index, "source_disclosure", "proof_use"],
              message: "disclosure must match delivered proof kind"
            });
          }
        }
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "source_disclosure"],
          message: error instanceof Error ? error.message : "invalid page source disclosure"
        });
      }
    }
  })
  .readonly();

function decodePageDisclosures(
  response: z.output<typeof SoulMemorySearchResponseWireSchema>
): z.input<typeof DecodedSoulMemorySearchResponseSchema> {
  let anchor: SourceDisclosure | undefined;
  const results = response.results.map((row) => {
    if (row.source_disclosure === undefined) return row;
    const decoded = decodePageSourceDisclosure(row.source_disclosure, anchor);
    anchor ??= decoded;
    return { ...row, source_disclosure: decoded };
  });
  return { ...response, results };
}

export const SoulMemorySearchResponseSchema = SoulMemorySearchResponseWireSchema
  .transform(decodePageDisclosures)
  .pipe(DecodedSoulMemorySearchResponseSchema);

export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;
export type MemorySearchPageResultWire = z.infer<typeof MemorySearchPageResultWireSchema>;
export type SoulActiveConstraintGovernanceState = z.infer<typeof SoulActiveConstraintGovernanceStateSchema>;
export type SoulActiveConstraint = z.infer<typeof SoulActiveConstraintSchema>;
export type SoulMemorySearchDegradationReason = z.infer<typeof SoulMemorySearchDegradationReasonSchema>;
export type SoulRecallTokenizerHint = z.infer<typeof SoulRecallTokenizerHintSchema>;
export type SoulRecallHostContext = z.infer<typeof SoulRecallHostContextSchema>;
export type SoulMemorySearchRequest = z.output<typeof SoulMemorySearchRequestSchema>;
export type SoulMemorySearchResponseWire = z.infer<typeof SoulMemorySearchResponseWireSchema>;
export type SoulMemorySearchResponse = z.infer<typeof SoulMemorySearchResponseSchema>;
