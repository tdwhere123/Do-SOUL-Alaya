import { z } from "zod";
import { LongMemEvalQuestionDiagnosticSchema } from "../../diagnostics/schema/diagnostics-schema.js";
import type {
  EmbeddingSupplementRuntimeProvenance,
  LocalCrossEncoderRuntimeProvenance
} from "../embedding/local-onnx.js";
import { embeddingInputIdentityForSchemaVersion } from "../../../harness/strict-treatment-config.js";
import { assertBiEncoderTreatmentActive } from "../../../harness/embedding/embedding-treatment-activation.js";
import { RecallTokenEconomySchema } from "../../../harness/recall/recall-diagnostics-schema.js";
import {
  writeGzipChunks,
  type StreamedArtifactIdentity
} from "../../diagnostics/artifacts/artifact-gzip-stream.js";
import { RecallEvalDiagnosticsSummaryAccumulator } from
  "./diagnostics/recall-eval-diagnostics-summary.js";

export const RECALL_EVAL_DIAGNOSTICS_FILENAME =
  "recall-eval-diagnostics.json";
export const RECALL_EVAL_DIAGNOSTICS_GZIP_FILENAME =
  `${RECALL_EVAL_DIAGNOSTICS_FILENAME}.gz`;

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
const WarmupLatencySummarySchema = z.object({
  measured_question_count: z.number().int().nonnegative(),
  total_ms: z.number().nonnegative(),
  mean_ms: z.number().nonnegative(),
  max_ms: z.number().nonnegative()
}).strict();

export const RecallEvalDiagnosticsQuestionSchema = z.object({
  question_id: z.string().min(1),
  latency_ms: z.number().nonnegative(),
  first_tier: z.enum(["hot", "warm", "cold"]),
  degradation_reason: z.string().min(1).nullable(),
  recall_token_economy: RecallTokenEconomySchema.nullable(),
  diagnostics: LongMemEvalQuestionDiagnosticSchema,
  document_embedding_warmup: DocumentWarmupSchema.nullable(),
  query_embedding_warmup: QueryWarmupSchema.nullable(),
  document_embedding_warmup_latency_ms:
    z.number().nonnegative().nullable().default(null)
}).strict().readonly();

const LegacyRecallEvalDiagnosticsQuestionSchema = z.object({
  question_id: z.string().min(1),
  diagnostics: LongMemEvalQuestionDiagnosticSchema,
  document_embedding_warmup: DocumentWarmupSchema.nullable(),
  query_embedding_warmup: QueryWarmupSchema.nullable()
}).strict().readonly();

export const RecallEvalDiagnosticsEvidenceV2Schema = z.object({
  schema_version: z.literal(2),
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
    document_embedding_warmup_latency_ms: WarmupLatencySummarySchema.default({
      measured_question_count: 0,
      total_ms: 0,
      mean_ms: 0,
      max_ms: 0
    }),
    provider_states: z.object({
      total: z.number().int().nonnegative(), provider_returned: z.number().int().nonnegative(),
      provider_pending: z.number().int().nonnegative(), provider_failed: z.number().int().nonnegative(),
      provider_not_requested: z.number().int().nonnegative(),
      query_embedding_unusable: z.number().int().nonnegative().default(0),
      unknown: z.number().int().nonnegative()
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
  questions: z.array(RecallEvalDiagnosticsQuestionSchema).readonly()
}).strict();

export const RecallEvalDiagnosticsEvidenceV1Schema =
  RecallEvalDiagnosticsEvidenceV2Schema.extend({
    schema_version: z.literal(1),
    questions: z.array(LegacyRecallEvalDiagnosticsQuestionSchema).readonly()
  }).strict();

export const RecallEvalDiagnosticsEvidenceSchema = z.discriminatedUnion(
  "schema_version",
  [RecallEvalDiagnosticsEvidenceV1Schema, RecallEvalDiagnosticsEvidenceV2Schema]
);

export type RecallEvalDiagnosticsEvidence = z.infer<
  typeof RecallEvalDiagnosticsEvidenceSchema
>;
export type RecallEvalDiagnosticsEvidenceV2 = z.infer<
  typeof RecallEvalDiagnosticsEvidenceV2Schema
>;
export type RecallEvalDiagnosticsQuestion = z.infer<
  typeof RecallEvalDiagnosticsQuestionSchema
>;

type EvidenceQuestionInput = Readonly<{
  questionId: string;
  latencyMs: number;
  firstTier: "hot" | "warm" | "cold";
  degradationReason: string | null;
  recallTokenEconomy: z.infer<typeof RecallTokenEconomySchema> | null;
  diagnostics: z.infer<typeof LongMemEvalQuestionDiagnosticSchema>;
  embeddingWarmup: z.infer<typeof DocumentWarmupSchema> | null;
  queryEmbeddingWarmup: z.infer<typeof QueryWarmupSchema> | null;
  documentEmbeddingWarmupLatencyMs?: number | null;
}>;

export function buildRecallEvalDiagnosticsEvidence(input: {
  readonly questions: readonly EvidenceQuestionInput[];
  readonly embeddingSupplement: EmbeddingSupplementRuntimeProvenance;
  readonly answerRerank: LocalCrossEncoderRuntimeProvenance;
}): RecallEvalDiagnosticsEvidenceV2 {
  const accumulator = new RecallEvalDiagnosticsSummaryAccumulator();
  const questions = input.questions.map((question) => {
    const normalized = normalizeRecallEvalDiagnosticsQuestion(question);
    accumulator.add(normalized);
    return normalized;
  });
  assertEmbeddingIdentity(questions, input.embeddingSupplement);
  const summary = accumulator.build(input.embeddingSupplement);
  assertCrossIdentity(questions, input.answerRerank, summary.answer_rerank_scores);
  const header = buildRecallEvalDiagnosticsHeader({
    summary,
    embeddingSupplement: input.embeddingSupplement,
    answerRerank: input.answerRerank
  });
  return RecallEvalDiagnosticsEvidenceV2Schema.parse({
    ...header,
    questions
  });
}

export function renderRecallEvalDiagnosticsEvidence(
  evidence: RecallEvalDiagnosticsEvidence
): string {
  return `${JSON.stringify(RecallEvalDiagnosticsEvidenceSchema.parse(evidence), null, 2)}\n`;
}

export async function writeRecallEvalDiagnosticsGzipStream(
  artifactPath: string,
  evidence: RecallEvalDiagnosticsEvidence
): Promise<StreamedArtifactIdentity> {
  const parsed = RecallEvalDiagnosticsEvidenceSchema.parse(evidence);
  if (parsed.schema_version === 1) {
    return writeGzipChunks(artifactPath, renderLegacyRecallEvalDiagnosticsChunks(parsed));
  }
  return writeRecallEvalDiagnosticsGzipFromQuestions(
    artifactPath,
    parsed,
    fromQuestions(parsed.questions)
  );
}

async function* renderLegacyRecallEvalDiagnosticsChunks(
  evidence: z.infer<typeof RecallEvalDiagnosticsEvidenceV1Schema>
): AsyncGenerator<string> {
  yield `{"schema_version":${evidence.schema_version}`;
  yield `,"kind":${JSON.stringify(evidence.kind)}`;
  yield `,"runtime":${JSON.stringify(evidence.runtime)}`;
  yield `,"summary":${JSON.stringify(evidence.summary)}`;
  yield `,"questions":[`;
  for (let index = 0; index < evidence.questions.length; index += 1) {
    yield index === 0 ? "" : ",";
    yield JSON.stringify(evidence.questions[index]);
  }
  yield "]}\n";
}

export async function writeRecallEvalDiagnosticsGzipFromQuestions(
  artifactPath: string,
  header: Omit<RecallEvalDiagnosticsEvidenceV2, "questions">,
  questions: AsyncIterable<RecallEvalDiagnosticsQuestion>
): Promise<StreamedArtifactIdentity> {
  return writeGzipChunks(artifactPath, renderRecallEvalDiagnosticsChunks(header, questions));
}

async function* renderRecallEvalDiagnosticsChunks(
  evidence: Omit<RecallEvalDiagnosticsEvidenceV2, "questions">,
  questions: AsyncIterable<RecallEvalDiagnosticsQuestion>
): AsyncGenerator<string> {
  yield `{"schema_version":${evidence.schema_version}`;
  yield `,"kind":${JSON.stringify(evidence.kind)}`;
  yield `,"runtime":${JSON.stringify(evidence.runtime)}`;
  yield `,"summary":${JSON.stringify(evidence.summary)}`;
  yield `,"questions":[`;
  let first = true;
  for await (const question of questions) {
    yield first ? "" : ",";
    yield JSON.stringify(RecallEvalDiagnosticsQuestionSchema.parse(question));
    first = false;
  }
  yield "]}\n";
}

export function normalizeRecallEvalDiagnosticsQuestion(
  question: EvidenceQuestionInput
): RecallEvalDiagnosticsQuestion {
  const diagnostics = LongMemEvalQuestionDiagnosticSchema.parse(question.diagnostics);
  if (question.questionId !== diagnostics.question_id) {
    throw new Error("recall-eval diagnostics question identity drift");
  }
  return {
    question_id: question.questionId,
    latency_ms: question.latencyMs,
    first_tier: question.firstTier,
    degradation_reason: question.degradationReason,
    recall_token_economy: RecallTokenEconomySchema.nullable().parse(
      question.recallTokenEconomy
    ),
    diagnostics,
    document_embedding_warmup: DocumentWarmupSchema.nullable().parse(question.embeddingWarmup),
    query_embedding_warmup: QueryWarmupSchema.nullable().parse(question.queryEmbeddingWarmup),
    document_embedding_warmup_latency_ms:
      question.documentEmbeddingWarmupLatencyMs ?? null
  };
}

type WarmupSummary = RecallEvalDiagnosticsQuestion["document_embedding_warmup"] |
  RecallEvalDiagnosticsQuestion["query_embedding_warmup"];

function assertEmbeddingIdentity(
  questions: readonly RecallEvalDiagnosticsQuestion[],
  identity: EmbeddingSupplementRuntimeProvenance
): void {
  for (const question of questions) {
    assertRecallEvalDiagnosticsQuestionRuntime(question, identity);
  }
}

export function assertRecallEvalDiagnosticsQuestionRuntime(
  question: RecallEvalDiagnosticsQuestion,
  identity: EmbeddingSupplementRuntimeProvenance
): void {
  const summaries = [question.document_embedding_warmup, question.query_embedding_warmup];
  if (!identity.enabled) {
    assertDisabledEmbeddingEvidence(question, summaries);
    return;
  }
  assertEnabledEmbeddingEvidence(question, identity, [
    question.document_embedding_warmup,
    ...(question.query_embedding_warmup === null
      ? []
      : [question.query_embedding_warmup])
  ]);
}

function assertDisabledEmbeddingEvidence(
  question: RecallEvalDiagnosticsQuestion,
  summaries: readonly WarmupSummary[]
): void {
  const diagnostics = question.diagnostics;
  const workspaceWork = diagnostics.embedding_workspace_scanned_count !== undefined ||
    diagnostics.embedding_workspace_truncated !== undefined ||
    diagnostics.embedding_workspace_provider_kind !== undefined ||
    diagnostics.embedding_workspace_model_id !== undefined ||
    diagnostics.embedding_workspace_schema_version !== undefined;
  const scored = diagnostics.candidates.some(
    (candidate) => "embedding_similarity" in candidate.score_factors
  );
  if (summaries.some((summary) => summary !== null) || workspaceWork || scored ||
    diagnostics.provider_state !== "provider_not_requested") {
    throw new Error("embedding identity drift: disabled run produced embedding work");
  }
}

function assertEnabledEmbeddingEvidence(
  question: RecallEvalDiagnosticsQuestion,
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
  diagnostics: RecallEvalDiagnosticsQuestion["diagnostics"],
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
  questions: readonly RecallEvalDiagnosticsQuestion[],
  identity: LocalCrossEncoderRuntimeProvenance,
  scores: Readonly<{ expected_count: number; scored_count: number }>
): void {
  for (const question of questions) {
    assertRecallEvalDiagnosticsCrossQuestion(question, identity);
  }
  assertRecallEvalDiagnosticsCrossScores(scores, identity);
}

export function assertRecallEvalDiagnosticsCrossQuestion(
  question: RecallEvalDiagnosticsQuestion,
  identity: LocalCrossEncoderRuntimeProvenance
): void {
  const status = question.diagnostics.answer_rerank_status;
  const matches = identity.enabled
    ? status === "returned" || status === "not_applicable"
    : status === "not_requested";
  if (!matches) throw new Error("answer rerank identity drift in recall-eval diagnostics");
}

export function assertRecallEvalDiagnosticsCrossScores(
  scores: Readonly<{ expected_count: number; scored_count: number }>,
  identity: LocalCrossEncoderRuntimeProvenance
): void {
  if (identity.enabled && (scores.expected_count === 0 ||
      scores.scored_count !== scores.expected_count)) {
    throw new Error("answer rerank activation produced no complete cross-encoder scores");
  }
  if (!identity.enabled && (scores.expected_count !== 0 || scores.scored_count !== 0)) {
    throw new Error("disabled answer rerank produced cross-encoder scores");
  }
}

export function buildRecallEvalDiagnosticsHeader(input: {
  readonly summary: RecallEvalDiagnosticsEvidenceV2["summary"];
  readonly embeddingSupplement: EmbeddingSupplementRuntimeProvenance;
  readonly answerRerank: LocalCrossEncoderRuntimeProvenance;
}): Omit<RecallEvalDiagnosticsEvidenceV2, "questions"> {
  const { questions: _questions, ...header } = RecallEvalDiagnosticsEvidenceV2Schema.parse({
    schema_version: 2,
    kind: "recall_eval_diagnostics",
    runtime: {
      embedding_supplement: input.embeddingSupplement,
      answer_rerank: input.answerRerank
    },
    summary: input.summary,
    questions: []
  });
  return header;
}

async function* fromQuestions(
  questions: readonly RecallEvalDiagnosticsQuestion[]
): AsyncGenerator<RecallEvalDiagnosticsQuestion> {
  yield* questions;
}
