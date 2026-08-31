import { z } from "zod";
import { normalizeCompileSeedSourceTime } from "../../datasets/longmemeval/ingestion/source-time.js";
import type { LongMemEvalSnapshotSidecarFile } from "./materialize.js";

const NonEmptyStringSchema = z.string().min(1).refine(
  (value) => value.trim() === value,
  "must not contain surrounding whitespace"
);
const CountSchema = z.number().int().nonnegative();
const SourceRoundSchema = z.object({
  sessionIndex: CountSchema,
  roundIndex: CountSchema,
  sessionId: NonEmptyStringSchema,
  hasAnswer: z.boolean()
}).strict();
const SidecarEntrySchema = z.object({
  objectId: NonEmptyStringSchema,
  objectKind: z.enum(["memory_entry", "evidence_capsule", "synthesis_capsule"]),
  sessionId: NonEmptyStringSchema,
  hasAnswer: z.boolean(),
  sourceRounds: z.array(SourceRoundSchema).optional()
}).strict();
const SeedDropReasonsSchema = z.object({
  candidate_absent: z.number().int().nonnegative(),
  materialization_drop: z.number().int().nonnegative()
}).strict();
const AnswersWithFormationSchema = z.object({
  coRelevantPairs: CountSchema,
  keptPairs: CountSchema,
  admitted: CountSchema
}).strict();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SeedBindingSchema = z.object({
  objectId: NonEmptyStringSchema,
  signalId: NonEmptyStringSchema,
  evidenceId: NonEmptyStringSchema.nullable()
}).strict();
const DirectEvidenceBindingSchema = z.object({
  signalId: NonEmptyStringSchema,
  evidenceId: NonEmptyStringSchema
}).strict();
const ExtractionShardSchema = z.object({
  cacheKey: Sha256Schema,
  rawJsonSha256: Sha256Schema,
  rawSignalCount: CountSchema,
  draftCount: CountSchema
}).strict();
const SemanticSupplementShardSchema = z.object({
  semanticSupplementReceiptSha256: Sha256Schema,
  receiptEntrySha256: Sha256Schema,
  sidecarProjectionSha256: Sha256Schema,
  primaryCacheKey: Sha256Schema,
  sourceCacheKey: Sha256Schema,
  sourceRawJsonSha256: Sha256Schema,
  primaryRawJsonSha256: Sha256Schema,
  selectedRawJsonSha256: Sha256Schema,
  sourceCorpusIdentity: Sha256Schema,
  anchorAssertionIds: z.array(z.number().int().positive()).nonempty(),
  sourceObservationSha256s: z.array(Sha256Schema).nonempty(),
  occurrenceCount: z.number().int().positive(),
  rawSignalCount: CountSchema,
  draftCount: CountSchema
}).strict();
const SeedRoundSchema = z.object({
  sessionIndex: CountSchema,
  roundIndex: CountSchema,
  sessionId: NonEmptyStringSchema,
  contentSha256: Sha256Schema,
  hasAnswer: z.boolean(),
  extractionSource: z.enum(["cache", "live", "fallback"]),
  cacheKey: Sha256Schema.nullable(),
  rawJsonSha256: Sha256Schema.nullable(),
  rawSignalCount: CountSchema.nullable(),
  draftCount: CountSchema.nullable(),
  extractionShards: z.array(ExtractionShardSchema).nonempty().optional(),
  semanticSupplementShards: z.array(SemanticSupplementShardSchema).nonempty().optional(),
  factsProduced: CountSchema,
  parseDropped: CountSchema,
  compileOverflowDropped: CountSchema,
  candidateAbsent: CountSchema,
  materializationDrop: CountSchema,
  memoryObjectIds: z.array(NonEmptyStringSchema),
  memoryBindings: z.array(SeedBindingSchema).optional(),
  directEvidenceBindings: z.array(DirectEvidenceBindingSchema).optional()
}).strict();
const SnapshotQuestionSchema = z.object({
  questionId: NonEmptyStringSchema,
  question: NonEmptyStringSchema,
  questionDate: NonEmptyStringSchema,
  answerSessionIds: z.array(NonEmptyStringSchema),
  sidecar: z.array(SidecarEntrySchema),
  seedRounds: z.array(SeedRoundSchema).optional(),
  workspaceId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  answersWithFormation: AnswersWithFormationSchema.optional(),
  answerSeedDropReasons: SeedDropReasonsSchema.optional()
}).strict();
const SnapshotSidecarSchema = z.object({
  schema_version: z.number().int(),
  variant: NonEmptyStringSchema,
  questions: z.array(SnapshotQuestionSchema)
}).strict();

export function parseSnapshotSidecar(
  value: unknown,
  filePath: string,
  expectedVersion: number
): LongMemEvalSnapshotSidecarFile {
  assertCanonicalQuestionDates(value, filePath);
  const parsed = SnapshotSidecarSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`recall-eval snapshot sidecar at ${filePath} is malformed: ${detail}`);
  }
  if (parsed.data.schema_version !== expectedVersion) {
    throw new Error(`recall-eval snapshot sidecar at ${filePath} has unsupported schema_version`);
  }
  return parsed.data;
}

function assertCanonicalQuestionDates(value: unknown, filePath: string): void {
  if (!isRecord(value) || !Array.isArray(value.questions)) return;
  for (const [index, question] of value.questions.entries()) {
    if (!isRecord(question) || !("questionDate" in question)) {
      throw new Error(`snapshot sidecar at ${filePath} question ${index} missing questionDate`);
    }
    if (typeof question.questionDate !== "string") {
      throw new Error(`snapshot sidecar at ${filePath} question ${index} has invalid questionDate`);
    }
    const normalized = normalizeCompileSeedSourceTime(question.questionDate);
    if (normalized === undefined) {
      throw new Error(`snapshot sidecar at ${filePath} question ${index} has invalid questionDate`);
    }
    if (normalized !== question.questionDate) {
      throw new Error(`snapshot sidecar at ${filePath} question ${index} requires normalized ISO questionDate`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
