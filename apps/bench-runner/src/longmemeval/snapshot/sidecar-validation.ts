import { z } from "zod";
import { normalizeCompileSeedSourceTime } from "../ingestion/source-time.js";
import type { LongMemEvalSnapshotSidecarFile } from "../snapshot.js";

const NonEmptyStringSchema = z.string().min(1).refine(
  (value) => value.trim() === value,
  "must not contain surrounding whitespace"
);
const SidecarEntrySchema = z.object({
  objectId: NonEmptyStringSchema,
  objectKind: z.enum(["memory_entry", "synthesis_capsule"]),
  sessionId: NonEmptyStringSchema,
  hasAnswer: z.boolean()
}).strict();
const SeedDropReasonsSchema = z.object({
  candidate_absent: z.number().int().nonnegative(),
  materialization_drop: z.number().int().nonnegative()
}).strict();
const SnapshotQuestionSchema = z.object({
  questionId: NonEmptyStringSchema,
  question: NonEmptyStringSchema,
  questionDate: NonEmptyStringSchema,
  answerSessionIds: z.array(NonEmptyStringSchema),
  sidecar: z.array(SidecarEntrySchema),
  workspaceId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
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
