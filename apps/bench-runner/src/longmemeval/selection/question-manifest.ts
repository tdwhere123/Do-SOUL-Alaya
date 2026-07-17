import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { computeLongMemEvalQuestionIdDigest } from "@do-soul/alaya-eval";
import { z } from "zod";
import type { LongMemEvalQuestion, LongMemEvalVariant } from "../ingestion/dataset.js";
import {
  classifyLongMemEvalDatasetCohort,
  type LongMemEvalDatasetCohort
} from "./dataset-cohort.js";

export const QUESTION_MANIFEST_SCHEMA_VERSION = 1;
export const QUESTION_MANIFEST_ALGORITHM_VERSION =
  "hamilton-joint-strata-json-tuple-sha256-nul-preimage-dataset-order-v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const QuestionIdSchema = z.string().min(1).refine((value) => !value.includes("\0"), {
  message: "question ids must not contain NUL"
});
const JointQuotaSchema = z.object({
  question_type: z.string().min(1),
  answerability: z.enum(["answerable", "abstention"]),
  count: z.number().int().nonnegative()
}).strict();

export const QuestionManifestSchema = z.object({
  schema_version: z.literal(QUESTION_MANIFEST_SCHEMA_VERSION),
  variant: z.enum(["longmemeval_oracle", "longmemeval_s", "longmemeval_m"]),
  dataset_sha256: z.string().regex(SHA256_PATTERN),
  algorithm_version: z.literal(QUESTION_MANIFEST_ALGORITHM_VERSION),
  target_count: z.number().int().positive(),
  question_ids: z.array(QuestionIdSchema),
  joint_quotas: z.array(JointQuotaSchema),
  type_quotas: z.record(z.string(), z.number().int().nonnegative()),
  abstention_count: z.number().int().nonnegative(),
  selected_id_digest: z.string().regex(SHA256_PATTERN)
}).strict();

export type QuestionManifest = z.infer<typeof QuestionManifestSchema>;
type Answerability = LongMemEvalDatasetCohort;
type Stratum = {
  readonly key: string;
  readonly questionType: string;
  readonly answerability: Answerability;
  readonly questions: LongMemEvalQuestion[];
};

export function createStratifiedQuestionManifest(input: {
  readonly variant: LongMemEvalVariant;
  readonly datasetSha256: string;
  readonly questions: readonly LongMemEvalQuestion[];
  readonly targetCount: number;
}): QuestionManifest {
  validateGenerationInput(input);
  const strata = buildStrata(input.questions);
  const allocations = allocateHamilton(strata, input.targetCount, input.questions.length);
  const selectedIds = new Set<string>();
  for (const stratum of strata) {
    const count = allocations.get(stratum.key) ?? 0;
    for (const question of rankStratum(stratum, input.datasetSha256).slice(0, count)) {
      selectedIds.add(question.question_id);
    }
  }
  const questionIds = input.questions
    .filter((question) => selectedIds.has(question.question_id))
    .map((question) => question.question_id);
  return {
    schema_version: QUESTION_MANIFEST_SCHEMA_VERSION,
    variant: input.variant,
    dataset_sha256: input.datasetSha256,
    algorithm_version: QUESTION_MANIFEST_ALGORITHM_VERSION,
    target_count: input.targetCount,
    question_ids: questionIds,
    joint_quotas: strata.map((stratum) => ({
      question_type: stratum.questionType,
      answerability: stratum.answerability,
      count: allocations.get(stratum.key) ?? 0
    })),
    type_quotas: aggregateTypeQuotas(strata, allocations),
    abstention_count: strata.reduce(
      (total, stratum) =>
        total +
        (stratum.answerability === "abstention"
          ? allocations.get(stratum.key) ?? 0
          : 0),
      0
    ),
    selected_id_digest: computeQuestionIdDigest(questionIds)
  };
}

export function parseQuestionManifest(raw: unknown): QuestionManifest {
  const result = QuestionManifestSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`question manifest schema invalid: ${detail}`);
  }
  return result.data;
}

export function applyQuestionManifest(
  questions: readonly LongMemEvalQuestion[],
  manifest: QuestionManifest,
  expected: { readonly variant: LongMemEvalVariant; readonly datasetSha256: string }
): LongMemEvalQuestion[] {
  validateManifestBinding(manifest, expected);
  const datasetById = indexQuestions(questions, "dataset");
  const manifestIds = indexIds(manifest.question_ids, "question manifest");
  if (manifest.question_ids.length !== manifest.target_count) {
    throw new Error("question manifest target_count does not match question_ids length");
  }
  for (const id of manifestIds) {
    if (!datasetById.has(id)) throw new Error(`question manifest contains unknown id: ${id}`);
  }
  if (computeQuestionIdDigest(manifest.question_ids) !== manifest.selected_id_digest) {
    throw new Error("question manifest selected-ID digest mismatch");
  }
  const selected = questions.filter((question) => manifestIds.has(question.question_id));
  validateManifestQuotas(questions, selected, manifest);
  return selected;
}

export async function loadQuestionManifestSelection(input: {
  readonly manifestPath: string;
  readonly questions: readonly LongMemEvalQuestion[];
  readonly variant: LongMemEvalVariant;
  readonly datasetSha256: string;
}): Promise<LongMemEvalQuestion[]> {
  const manifestRaw = await readFile(input.manifestPath, "utf8");
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestRaw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`question manifest JSON invalid: ${detail}`);
  }
  return applyQuestionManifest(input.questions, parseQuestionManifest(decoded), {
    variant: input.variant,
    datasetSha256: input.datasetSha256
  });
}

export const computeQuestionIdDigest = computeLongMemEvalQuestionIdDigest;

function validateGenerationInput(input: {
  readonly datasetSha256: string;
  readonly questions: readonly LongMemEvalQuestion[];
  readonly targetCount: number;
}): void {
  if (!SHA256_PATTERN.test(input.datasetSha256)) throw new Error("dataset SHA-256 is invalid");
  if (
    !Number.isInteger(input.targetCount) ||
    input.targetCount <= 0 ||
    input.targetCount > input.questions.length
  ) {
    throw new Error("target count must be a positive integer no larger than the dataset");
  }
  indexQuestions(input.questions, "dataset");
}

function buildStrata(questions: readonly LongMemEvalQuestion[]): Stratum[] {
  const byKey = new Map<string, Stratum>();
  for (const question of questions) {
    const answerability = classifyLongMemEvalDatasetCohort(question);
    const key = stratumKey(question.question_type, answerability);
    const existing = byKey.get(key);
    if (existing !== undefined) existing.questions.push(question);
    else {
      byKey.set(key, {
        key,
        questionType: question.question_type,
        answerability,
        questions: [question]
      });
    }
  }
  return [...byKey.values()].sort((left, right) => bytewiseCompare(left.key, right.key));
}

function allocateHamilton(
  strata: readonly Stratum[],
  targetCount: number,
  datasetCount: number
): ReadonlyMap<string, number> {
  const allocated = new Map<string, number>();
  const remainders: Array<{ readonly key: string; readonly remainder: number }> = [];
  let floorTotal = 0;
  for (const stratum of strata) {
    const numerator = stratum.questions.length * targetCount;
    const floor = Math.floor(numerator / datasetCount);
    floorTotal += floor;
    allocated.set(stratum.key, floor);
    remainders.push({ key: stratum.key, remainder: numerator % datasetCount });
  }
  remainders.sort(
    (left, right) =>
      right.remainder - left.remainder || bytewiseCompare(left.key, right.key)
  );
  for (const entry of remainders.slice(0, targetCount - floorTotal)) {
    allocated.set(entry.key, (allocated.get(entry.key) ?? 0) + 1);
  }
  return allocated;
}

function rankStratum(stratum: Stratum, datasetSha256: string): LongMemEvalQuestion[] {
  return [...stratum.questions].sort((left, right) => {
    const leftHash = selectionHash(datasetSha256, stratum.key, left.question_id);
    const rightHash = selectionHash(datasetSha256, stratum.key, right.question_id);
    return (
      bytewiseCompare(leftHash, rightHash) ||
      bytewiseCompare(left.question_id, right.question_id)
    );
  });
}

function selectionHash(datasetSha256: string, stratum: string, questionId: string): string {
  return createHash("sha256")
    .update(
      [
        datasetSha256,
        QUESTION_MANIFEST_ALGORITHM_VERSION,
        stratum,
        questionId
      ].join("\0"),
      "utf8"
    )
    .digest("hex");
}

function aggregateTypeQuotas(
  strata: readonly Stratum[],
  allocations: ReadonlyMap<string, number>
): Record<string, number> {
  const quotas: Record<string, number> = {};
  for (const stratum of strata) {
    quotas[stratum.questionType] =
      (quotas[stratum.questionType] ?? 0) +
      (allocations.get(stratum.key) ?? 0);
  }
  return Object.fromEntries(
    Object.entries(quotas).sort(([left], [right]) =>
      bytewiseCompare(left, right)
    )
  );
}

function validateManifestBinding(
  manifest: QuestionManifest,
  expected: { readonly variant: LongMemEvalVariant; readonly datasetSha256: string }
): void {
  if (manifest.variant !== expected.variant) {
    throw new Error(
      `question manifest variant mismatch: expected ${expected.variant}`
    );
  }
  if (manifest.dataset_sha256 !== expected.datasetSha256) {
    throw new Error("question manifest dataset SHA-256 mismatch");
  }
}

function validateManifestQuotas(
  dataset: readonly LongMemEvalQuestion[],
  selected: readonly LongMemEvalQuestion[],
  manifest: QuestionManifest
): void {
  const datasetStrata = buildStrata(dataset);
  const actualJoint = new Map<string, number>(
    datasetStrata.map((stratum) => [stratum.key, 0] as const)
  );
  const actualTypes: Record<string, number> = Object.fromEntries(
    [...new Set(dataset.map((question) => question.question_type))]
      .map((questionType) => [questionType, 0])
  );
  let abstentions = 0;
  for (const question of selected) {
    const answerability = classifyLongMemEvalDatasetCohort(question);
    const key = stratumKey(question.question_type, answerability);
    actualJoint.set(key, (actualJoint.get(key) ?? 0) + 1);
    actualTypes[question.question_type] = (actualTypes[question.question_type] ?? 0) + 1;
    if (answerability === "abstention") abstentions += 1;
  }
  const expectedJoint = new Map<string, number>();
  for (const quota of manifest.joint_quotas) {
    const key = stratumKey(quota.question_type, quota.answerability);
    if (expectedJoint.has(key)) throw new Error(`question manifest duplicate joint quota: ${key}`);
    expectedJoint.set(key, quota.count);
  }
  const datasetJointKeys = new Set(datasetStrata.map((stratum) => stratum.key));
  assertExactKeySet(expectedJoint.keys(), datasetJointKeys, "joint quota");
  if (!mapsEqual(actualJoint, expectedJoint)) {
    throw new Error("question manifest joint quotas do not match selected questions");
  }
  const datasetTypeKeys = new Set(dataset.map((question) => question.question_type));
  assertExactKeySet(Object.keys(manifest.type_quotas), datasetTypeKeys, "type quota");
  if (!recordsEqual(actualTypes, manifest.type_quotas)) {
    throw new Error("question manifest type quotas do not match selected questions");
  }
  if (abstentions !== manifest.abstention_count) {
    throw new Error("question manifest abstention count does not match selected questions");
  }
}

function assertExactKeySet(
  actual: Iterable<string>,
  expected: ReadonlySet<string>,
  label: string
): void {
  const actualSet = new Set(actual);
  if (
    actualSet.size !== expected.size ||
    [...actualSet].some((key) => !expected.has(key))
  ) {
    throw new Error(`question manifest ${label} key set does not match dataset`);
  }
}

function indexQuestions(
  questions: readonly LongMemEvalQuestion[],
  label: string
): Map<string, LongMemEvalQuestion> {
  const indexed = new Map<string, LongMemEvalQuestion>();
  for (const question of questions) {
    if (question.question_id.includes("\0")) {
      throw new Error(`${label} contains a question id with NUL`);
    }
    if (indexed.has(question.question_id)) {
      throw new Error(
        `${label} contains duplicate question id: ${question.question_id}`
      );
    }
    indexed.set(question.question_id, question);
  }
  return indexed;
}

function indexIds(ids: readonly string[], label: string): Set<string> {
  const indexed = new Set<string>();
  for (const id of ids) {
    if (indexed.has(id)) throw new Error(`${label} contains duplicate question id: ${id}`);
    indexed.add(id);
  }
  return indexed;
}

function stratumKey(questionType: string, answerability: Answerability): string {
  return JSON.stringify([questionType, answerability]);
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function mapsEqual(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key) || right.get(key) !== value) return false;
  }
  return true;
}

function recordsEqual(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || right[key] !== left[key]) return false;
  }
  return true;
}
