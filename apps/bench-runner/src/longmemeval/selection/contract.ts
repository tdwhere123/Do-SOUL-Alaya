import {
  computeLongMemEvalCohortAssignmentDigest,
  createLongMemEvalSelectionContractIdentity,
  type LongMemEvalSelectionAssignment as SharedSelectionAssignment,
  type LongMemEvalSelectionContract as SharedSelectionContract,
  type LongMemEvalSelectionContractIdentity as SharedSelectionContractIdentity
} from "@do-soul/alaya-eval";
import type { LongMemEvalQuestion } from "../dataset.js";
import {
  classifyLongMemEvalDatasetCohort,
  type LongMemEvalDatasetCohort
} from "./dataset-cohort.js";

export type LongMemEvalSelectionContractIdentity = SharedSelectionContractIdentity;
export type LongMemEvalSelectionAssignment = SharedSelectionAssignment;

export type LongMemEvalSelectionContract = SharedSelectionContract;

export function createLongMemEvalSelectionContract(input: {
  readonly datasetSha256: string;
  readonly questions: readonly LongMemEvalQuestion[];
}): LongMemEvalSelectionContract {
  return createLongMemEvalSelectionContractFromAssignments({
    datasetSha256: input.datasetSha256,
    assignments: input.questions.map((question) => ({
      question_id: question.question_id,
      dataset_cohort: classifyLongMemEvalDatasetCohort(question)
    }))
  });
}

export function createLongMemEvalSelectionContractFromAssignments(input: {
  readonly datasetSha256: string;
  readonly assignments: readonly LongMemEvalSelectionAssignment[];
}): LongMemEvalSelectionContract {
  const assignments = input.assignments.map((assignment) => ({ ...assignment }));
  return {
    ...createLongMemEvalSelectionContractIdentity({
      datasetSha256: input.datasetSha256,
      assignments
    }),
    assignments
  };
}

export function selectionContractIdentity(
  contract: LongMemEvalSelectionContract
): LongMemEvalSelectionContractIdentity {
  const { assignments: _assignments, ...identity } = contract;
  return identity;
}

export function assertSelectionCohortBinding(
  contract: LongMemEvalSelectionContract,
  observed: readonly {
    readonly question_id: string;
    readonly dataset_cohort: "answerable" | "abstention" | "adjudicated_invalid";
  }[]
): void {
  const normalized = observed.map((row) => ({
    question_id: row.question_id,
    dataset_cohort: row.dataset_cohort
  }));
  if (JSON.stringify(normalized) !== JSON.stringify(contract.assignments)) {
    throw new Error("selection cohort binding differs from immutable selection contract");
  }
}

export const computeCohortAssignmentDigest = computeLongMemEvalCohortAssignmentDigest;
