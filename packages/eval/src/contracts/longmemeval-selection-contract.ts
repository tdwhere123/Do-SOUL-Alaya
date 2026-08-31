import { createHash } from "node:crypto";
import { z, type RefinementCtx } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const LongMemEvalSelectionCohortSchema = z.enum(["answerable", "abstention"]);
export type LongMemEvalSelectionCohort = z.infer<
  typeof LongMemEvalSelectionCohortSchema
>;

export const LongMemEvalSelectionContractIdentitySchema = z.object({
  schema_version: z.literal(1),
  dataset_sha256: Sha256Schema,
  selected_id_digest: Sha256Schema,
  selected_count: z.number().int().nonnegative(),
  expected_cohort_counts: z.object({
    answerable: z.number().int().nonnegative(),
    abstention: z.number().int().nonnegative()
  }).strict(),
  cohort_assignment_digest: Sha256Schema
}).strict().superRefine((selection, context) => {
  const counts = selection.expected_cohort_counts;
  if (counts.answerable + counts.abstention !== selection.selected_count) {
    context.addIssue({ code: "custom", message: "selection cohort counts must conserve" });
  }
});

export type LongMemEvalSelectionContractIdentity = z.infer<
  typeof LongMemEvalSelectionContractIdentitySchema
>;

export interface LongMemEvalSelectionAssignment {
  readonly question_id: string;
  readonly dataset_cohort: LongMemEvalSelectionCohort;
}

export interface LongMemEvalQuestionIdValidationError {
  readonly code: "empty" | "nul" | "duplicate";
  readonly message: string;
}

export interface LongMemEvalSelectionContract
  extends LongMemEvalSelectionContractIdentity {
  readonly assignments: readonly LongMemEvalSelectionAssignment[];
}

interface LongMemEvalSelectionPayload {
  readonly dataset: { readonly checksum_sha256?: string };
  readonly evaluated_count: number;
  readonly selection_contract?: LongMemEvalSelectionContractIdentity;
  readonly kpi: {
    readonly per_scenario: readonly {
      readonly id: string;
      readonly measurement_cohort?: "answerable" | "dataset_declared_abstention";
    }[];
  };
}

export function createLongMemEvalSelectionContractIdentity(input: {
  readonly datasetSha256: string;
  readonly assignments: readonly LongMemEvalSelectionAssignment[];
}): LongMemEvalSelectionContractIdentity {
  const assignments = input.assignments.map((assignment) => ({ ...assignment }));
  assertUniqueQuestionIds(assignments.map((row) => row.question_id));
  const counts = countCohorts(assignments);
  return LongMemEvalSelectionContractIdentitySchema.parse({
    schema_version: 1,
    dataset_sha256: input.datasetSha256,
    selected_id_digest: computeLongMemEvalQuestionIdDigest(
      assignments.map((row) => row.question_id)
    ),
    selected_count: assignments.length,
    expected_cohort_counts: counts,
    cohort_assignment_digest: computeLongMemEvalCohortAssignmentDigest(assignments)
  });
}

export function computeLongMemEvalQuestionIdDigest(
  questionIds: readonly string[]
): string {
  assertUniqueQuestionIds(questionIds);
  return createHash("sha256").update(questionIds.join("\0"), "utf8").digest("hex");
}

export function computeLongMemEvalCohortAssignmentDigest(
  assignments: readonly LongMemEvalSelectionAssignment[]
): string {
  const preimage = assignments
    .map((row) => JSON.stringify([row.question_id, row.dataset_cohort]))
    .join("\0");
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

export function longMemEvalSelectionContractAllowsEligibility(
  payload: LongMemEvalSelectionPayload
): boolean {
  return payload.selection_contract !== undefined &&
    findLongMemEvalSelectionBindingError(payload) === null;
}

export function validateLongMemEvalSelectionContract(
  payload: LongMemEvalSelectionPayload,
  context: RefinementCtx
): void {
  if (payload.selection_contract === undefined) return;
  const error = findLongMemEvalSelectionBindingError(payload);
  if (error !== null) {
    context.addIssue({ code: "custom", message: error, path: ["selection_contract"] });
  }
}

export function findLongMemEvalSelectionBindingError(
  payload: LongMemEvalSelectionPayload
): string | null {
  const selection = payload.selection_contract;
  if (selection === undefined) return "external selection contract is missing";
  if (selection.dataset_sha256 !== payload.dataset.checksum_sha256) {
    return "selection contract dataset SHA differs from KPI dataset";
  }
  const rows = payload.kpi.per_scenario;
  if (selection.selected_count !== payload.evaluated_count || rows.length !== payload.evaluated_count) {
    return "selection contract count differs from evaluated KPI rows";
  }
  const assignments = observedAssignments(rows);
  if (typeof assignments === "string") return assignments;
  const ids = assignments.map((row) => row.question_id);
  const idError = findLongMemEvalQuestionIdValidationError(ids);
  if (idError !== null) return idError.message;
  if (selection.selected_id_digest !== computeLongMemEvalQuestionIdDigest(ids)) {
    return "selection contract ordered ID digest differs from KPI rows";
  }
  const counts = countCohorts(assignments);
  if (counts.answerable !== selection.expected_cohort_counts.answerable ||
      counts.abstention !== selection.expected_cohort_counts.abstention) {
    return "selection contract expected cohorts differ from KPI rows";
  }
  return selection.cohort_assignment_digest ===
    computeLongMemEvalCohortAssignmentDigest(assignments)
    ? null
    : "selection contract ordered assignment digest differs from KPI rows";
}

function observedAssignments(
  rows: LongMemEvalSelectionPayload["kpi"]["per_scenario"]
): readonly LongMemEvalSelectionAssignment[] | string {
  const assignments: LongMemEvalSelectionAssignment[] = [];
  for (const row of rows) {
    if (row.measurement_cohort === undefined) {
      return "selection contract requires an explicit cohort for every KPI row";
    }
    assignments.push({
      question_id: row.id,
      dataset_cohort: row.measurement_cohort === "dataset_declared_abstention"
        ? "abstention"
        : "answerable"
    });
  }
  return assignments;
}

function countCohorts(
  assignments: readonly LongMemEvalSelectionAssignment[]
): Readonly<Record<LongMemEvalSelectionCohort, number>> {
  const counts = { answerable: 0, abstention: 0 };
  for (const assignment of assignments) counts[assignment.dataset_cohort] += 1;
  return counts;
}

function assertUniqueQuestionIds(questionIds: readonly string[]): void {
  const error = findLongMemEvalQuestionIdValidationError(questionIds);
  if (error !== null) throw new Error(error.message);
}

export function findLongMemEvalQuestionIdValidationError(
  questionIds: readonly string[]
): LongMemEvalQuestionIdValidationError | null {
  if (questionIds.some((id) => id.length === 0)) {
    return {
      code: "empty",
      message: "canonical selection requires unique non-empty NUL-free question IDs"
    };
  }
  if (questionIds.some((id) => id.includes("\0"))) {
    return {
      code: "nul",
      message: "canonical selection requires unique non-empty NUL-free question IDs"
    };
  }
  if (new Set(questionIds).size !== questionIds.length) {
    return {
      code: "duplicate",
      message: "canonical selection requires unique non-empty NUL-free question IDs"
    };
  }
  return null;
}
