import { z } from "zod";
import { LongMemEvalQuestionDiagnosticSchema } from "../diagnostics-schema.js";
import type {
  EmbeddingSupplementRuntimeProvenance,
  LocalCrossEncoderRuntimeProvenance
} from "./local-onnx.js";
import { embeddingInputIdentityForSchemaVersion } from "../../harness/strict-treatment-config.js";
import { assertBiEncoderTreatmentActive } from "../../harness/embedding-treatment-activation.js";

export const RECALL_EVAL_DIAGNOSTICS_FILENAME =
  "recall-eval-diagnostics.json";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const DocumentWarmupSchema = z.object({
  status: z.enum(["not_requested", "ready"]),
  expected_count: z.number().int().nonnegative(),
  ready_count: z.number().int().nonnegative(),
  ready_rate: z.number().min(0).max(1),
  pass_count: z.number().int().nonnegative(),
  missing_object_ids: z.array(z.string()).readonly(),
  provider_kind: z.string().nullable(),
  model_id: z.string().nullable(),
  schema_version: z.number().int().positive().nullable(),
  d2q_input: z.enum(["raw_content", "content_plus_hq"]).nullable()
}).strict().readonly();
const QueryWarmupSchema = z.object({
  status: z.enum(["not_requested", "ready"]),
  requested_count: z.number().int().nonnegative(),
  ready_count: z.number().int().nonnegative(),
  cache_hit_count: z.number().int().nonnegative(),
  provider_requested_count: z.number().int().nonnegative(),
  missing_count: z.number().int().nonnegative(),
  provider_kind: z.string().nullable(),
  model_id: z.string().nullable(),
  schema_version: z.number().int().positive().nullable(),
  d2q_input: z.enum(["raw_content", "content_plus_hq"]).nullable(),
  last_error: z.string().optional()
}).strict().readonly();
const BiIdentitySchema = z.union([
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true), provider_kind: z.literal("local_onnx"),
    effective_model_id: z.string().min(1), model_artifact_sha256: Sha256Schema,
    effective_schema_version: z.number().int().positive(),
    d2q_input: z.enum(["raw_content", "content_plus_hq"])
  }).strict(),
  z.object({
    enabled: z.literal(true), provider_kind: z.literal("openai"),
    effective_model_id: z.string().min(1), effective_schema_version: z.literal(1),
    d2q_input: z.literal("raw_content")
  }).strict()
]);
const CrossIdentitySchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true), provider_kind: z.literal("local_onnx_cross_encoder"),
    effective_model_id: z.string().min(1), model_artifact_sha256: Sha256Schema
  }).strict()
]);
const ExactCountsSchema = z.object({
  expected_count: z.number().int().nonnegative(),
  ready_count: z.number().int().nonnegative(),
  not_ready_count: z.number().int().nonnegative()
}).strict();

export const RecallEvalDiagnosticsEvidenceSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("recall_eval_diagnostics"),
  runtime: z.object({
    embedding_supplement: BiIdentitySchema,
    answer_rerank: CrossIdentitySchema
  }).strict(),
  summary: z.object({
    question_count: z.number().int().nonnegative(),
    document_embedding_cache: ExactCountsSchema,
    query_embedding_cache: ExactCountsSchema.extend({
      requested_count: z.number().int().nonnegative()
    }).strict(),
    provider_states: z.object({
      total: z.number().int().nonnegative(), provider_returned: z.number().int().nonnegative(),
      provider_pending: z.number().int().nonnegative(), provider_failed: z.number().int().nonnegative(),
      provider_not_requested: z.number().int().nonnegative(), unknown: z.number().int().nonnegative()
    }).strict(),
    answer_rerank_status_counts: z.object({
      returned: z.number().int().nonnegative(), not_applicable: z.number().int().nonnegative(),
      not_requested: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
      unavailable: z.number().int().nonnegative()
    }).strict(),
    answer_rerank_scores: z.object({
      expected_count: z.number().int().nonnegative(),
      scored_count: z.number().int().nonnegative()
    }).strict(),
    embedding_identity: z.object({
      provider_kind: z.string().nullable(), model_id: z.string().nullable(),
      schema_version: z.number().int().positive().nullable(), consistent: z.literal(true)
    }).strict()
  }).strict(),
  questions: z.array(z.object({
    question_id: z.string().min(1),
    diagnostics: LongMemEvalQuestionDiagnosticSchema,
    document_embedding_warmup: DocumentWarmupSchema.nullable(),
    query_embedding_warmup: QueryWarmupSchema.nullable()
  }).strict()).readonly()
}).strict();

export type RecallEvalDiagnosticsEvidence = z.infer<
  typeof RecallEvalDiagnosticsEvidenceSchema
>;

type EvidenceQuestionInput = Readonly<{
  questionId: string;
  diagnostics: z.infer<typeof LongMemEvalQuestionDiagnosticSchema>;
  embeddingWarmup: z.infer<typeof DocumentWarmupSchema> | null;
  queryEmbeddingWarmup: z.infer<typeof QueryWarmupSchema> | null;
}>;

export function buildRecallEvalDiagnosticsEvidence(input: {
  readonly questions: readonly EvidenceQuestionInput[];
  readonly embeddingSupplement: EmbeddingSupplementRuntimeProvenance;
  readonly answerRerank: LocalCrossEncoderRuntimeProvenance;
}): RecallEvalDiagnosticsEvidence {
  const questions = input.questions.map(normalizeQuestion);
  assertEmbeddingIdentity(questions, input.embeddingSupplement);
  assertCrossIdentity(questions, input.answerRerank);
  return RecallEvalDiagnosticsEvidenceSchema.parse({
    schema_version: 1,
    kind: "recall_eval_diagnostics",
    runtime: {
      embedding_supplement: input.embeddingSupplement,
      answer_rerank: input.answerRerank
    },
    summary: buildSummary(questions, input.embeddingSupplement),
    questions
  });
}

export function renderRecallEvalDiagnosticsEvidence(
  evidence: RecallEvalDiagnosticsEvidence
): string {
  return `${JSON.stringify(RecallEvalDiagnosticsEvidenceSchema.parse(evidence), null, 2)}\n`;
}

function normalizeQuestion(question: EvidenceQuestionInput) {
  const diagnostics = LongMemEvalQuestionDiagnosticSchema.parse(question.diagnostics);
  if (question.questionId !== diagnostics.question_id) {
    throw new Error("recall-eval diagnostics question identity drift");
  }
  return {
    question_id: question.questionId,
    diagnostics,
    document_embedding_warmup: DocumentWarmupSchema.nullable().parse(question.embeddingWarmup),
    query_embedding_warmup: QueryWarmupSchema.nullable().parse(question.queryEmbeddingWarmup)
  };
}

type WarmupSummary = ReturnType<typeof normalizeQuestion>["document_embedding_warmup"] |
  ReturnType<typeof normalizeQuestion>["query_embedding_warmup"];

function assertEmbeddingIdentity(
  questions: readonly ReturnType<typeof normalizeQuestion>[],
  identity: EmbeddingSupplementRuntimeProvenance
): void {
  for (const question of questions) {
    const summaries = [question.document_embedding_warmup, question.query_embedding_warmup];
    if (!identity.enabled) {
      assertDisabledEmbeddingEvidence(question, summaries);
      continue;
    }
    assertEnabledEmbeddingEvidence(question, identity, summaries);
  }
}

function assertDisabledEmbeddingEvidence(
  question: ReturnType<typeof normalizeQuestion>,
  summaries: readonly WarmupSummary[]
): void {
  const diagnostics = question.diagnostics;
  const workspaceWork = diagnostics.embedding_workspace_scanned_count !== undefined ||
    diagnostics.embedding_workspace_truncated !== undefined ||
    diagnostics.embedding_workspace_provider_kind !== undefined ||
    diagnostics.embedding_workspace_model_id !== undefined ||
    diagnostics.embedding_workspace_schema_version !== undefined;
  const scored = diagnostics.candidates.some((candidate) => {
    const score = candidate.score_factors.embedding_similarity;
    return typeof score === "number" && score > 0;
  });
  if (summaries.some((summary) => summary !== null) || workspaceWork || scored ||
    diagnostics.provider_state !== "provider_not_requested") {
    throw new Error("embedding identity drift: disabled run produced embedding work");
  }
}

function assertEnabledEmbeddingEvidence(
  question: ReturnType<typeof normalizeQuestion>,
  identity: Extract<EmbeddingSupplementRuntimeProvenance, { readonly enabled: true }>,
  summaries: readonly WarmupSummary[]
): void {
  const diagnostics = question.diagnostics;
  const inputIdentity = embeddingInputIdentityForSchemaVersion(
    identity.effective_schema_version
  );
  if (identity.d2q_input !== inputIdentity.d2q_input) {
    throw new Error("embedding identity drift: D2Q input does not match effective schema");
  }
  assertWorkspaceIdentityIfPresent(diagnostics, identity);
  for (const summary of summaries) {
    if (summary === null || summary.provider_kind !== identity.provider_kind ||
      summary.model_id !== identity.effective_model_id || summary.status !== "ready" ||
      summary.schema_version !== inputIdentity.schema_version ||
      summary.d2q_input !== inputIdentity.d2q_input ||
      summary.ready_count !== ("expected_count" in summary
        ? summary.expected_count
        : summary.requested_count)) {
      throw new Error("embedding identity drift: warmup does not match effective runtime");
    }
  }
  assertBiEncoderTreatmentActive({
    providerState: diagnostics.provider_state,
    providerDegradationReason: diagnostics.provider_degradation_reason,
    embeddingSimilarities: diagnostics.candidates.map((candidate) => {
      const similarity = candidate.score_factors.embedding_similarity;
      return typeof similarity === "number" ? similarity : undefined;
    }),
    workspaceScannedCount: diagnostics.embedding_workspace_scanned_count,
    workspaceTruncated: diagnostics.embedding_workspace_truncated,
    workspaceProviderKind: diagnostics.embedding_workspace_provider_kind,
    workspaceModelId: diagnostics.embedding_workspace_model_id,
    workspaceSchemaVersion: diagnostics.embedding_workspace_schema_version
  });
}

function assertWorkspaceIdentityIfPresent(
  diagnostics: ReturnType<typeof normalizeQuestion>["diagnostics"],
  identity: Extract<EmbeddingSupplementRuntimeProvenance, { readonly enabled: true }>
): void {
  const fields = [
    diagnostics.embedding_workspace_scanned_count,
    diagnostics.embedding_workspace_truncated,
    diagnostics.embedding_workspace_provider_kind,
    diagnostics.embedding_workspace_model_id,
    diagnostics.embedding_workspace_schema_version
  ];
  if (fields.every((field) => field === undefined)) return;
  const matches = diagnostics.embedding_workspace_scanned_count !== undefined &&
    diagnostics.embedding_workspace_scanned_count > 0 &&
    diagnostics.embedding_workspace_truncated === false &&
    diagnostics.embedding_workspace_provider_kind === identity.provider_kind &&
    diagnostics.embedding_workspace_model_id === identity.effective_model_id &&
    diagnostics.embedding_workspace_schema_version === identity.effective_schema_version;
  if (!matches) {
    throw new Error("embedding identity drift: workspace scan does not match effective runtime");
  }
}

function assertCrossIdentity(
  questions: readonly ReturnType<typeof normalizeQuestion>[],
  identity: LocalCrossEncoderRuntimeProvenance
): void {
  for (const question of questions) {
    const status = question.diagnostics.answer_rerank_status;
    const matches = identity.enabled
      ? status === "returned" || status === "not_applicable"
      : status === "not_requested";
    if (!matches) throw new Error("answer rerank identity drift in recall-eval diagnostics");
  }
  const scores = sumCrossScores(questions);
  if (identity.enabled && (scores.expected_count === 0 ||
      scores.scored_count !== scores.expected_count)) {
    throw new Error("answer rerank activation produced no complete cross-encoder scores");
  }
  if (!identity.enabled && (scores.expected_count !== 0 || scores.scored_count !== 0)) {
    throw new Error("disabled answer rerank produced cross-encoder scores");
  }
}

function buildSummary(
  questions: readonly ReturnType<typeof normalizeQuestion>[],
  identity: EmbeddingSupplementRuntimeProvenance
) {
  return {
    question_count: questions.length,
    document_embedding_cache: sumDocumentReadiness(questions),
    query_embedding_cache: sumQueryReadiness(questions),
    provider_states: countProviderStates(questions),
    answer_rerank_status_counts: countCrossStatuses(questions),
    answer_rerank_scores: sumCrossScores(questions),
    embedding_identity: {
      provider_kind: identity.enabled ? identity.provider_kind : null,
      model_id: identity.enabled ? identity.effective_model_id : null,
      schema_version: identity.enabled ? identity.effective_schema_version : null,
      consistent: true as const
    }
  };
}

function sumCrossScores(questions: readonly ReturnType<typeof normalizeQuestion>[]) {
  return questions.reduce((total, question) => ({
    expected_count: total.expected_count +
      (question.diagnostics.answer_rerank_expected_count ?? 0),
    scored_count: total.scored_count +
      (question.diagnostics.answer_rerank_scored_count ?? 0)
  }), { expected_count: 0, scored_count: 0 });
}

function sumDocumentReadiness(questions: readonly ReturnType<typeof normalizeQuestion>[]) {
  const rows = questions.flatMap((question) =>
    question.document_embedding_warmup === null ? [] : [question.document_embedding_warmup]
  );
  const expected = rows.reduce((sum, row) => sum + row.expected_count, 0);
  const ready = rows.reduce((sum, row) => sum + row.ready_count, 0);
  return { expected_count: expected, ready_count: ready, not_ready_count: expected - ready };
}

function sumQueryReadiness(questions: readonly ReturnType<typeof normalizeQuestion>[]) {
  const rows = questions.flatMap((question) =>
    question.query_embedding_warmup === null ? [] : [question.query_embedding_warmup]
  );
  const requested = rows.reduce((sum, row) => sum + row.requested_count, 0);
  const ready = rows.reduce((sum, row) => sum + row.ready_count, 0);
  return {
    expected_count: requested, requested_count: requested,
    ready_count: ready, not_ready_count: requested - ready
  };
}

function countProviderStates(questions: readonly ReturnType<typeof normalizeQuestion>[]) {
  const counts = {
    total: questions.length, provider_returned: 0, provider_pending: 0,
    provider_failed: 0, provider_not_requested: 0, unknown: 0
  };
  for (const question of questions) counts[question.diagnostics.provider_state]++;
  return counts;
}

function countCrossStatuses(questions: readonly ReturnType<typeof normalizeQuestion>[]) {
  const counts = { returned: 0, not_applicable: 0, not_requested: 0, failed: 0, unavailable: 0 };
  for (const question of questions) {
    const status = question.diagnostics.answer_rerank_status;
    if (status === null) counts.unavailable++;
    else counts[status]++;
  }
  return counts;
}
