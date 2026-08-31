import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from
  "../../../../field/field-identity.js";
import {
  assertDigest,
  assertIdentity,
  type FiniteMutualExclusionAssignment,
  type FiniteMutualExclusionReceipt
} from "./contract.js";

export function createFiniteMutualExclusionReceipt(params: Readonly<{
  readonly fixture_id: string;
  readonly snapshot_digest: FiniteMutualExclusionReceipt["snapshot_digest"];
  readonly forbidden_combinations:
    readonly (readonly FiniteMutualExclusionAssignment[])[];
}>): FiniteMutualExclusionReceipt {
  assertIdentity(params.fixture_id, "mutual exclusion fixture id");
  assertDigest(params.snapshot_digest, "mutual exclusion snapshot");
  const combinations = params.forbidden_combinations.map((combination) => {
    if (combination.length < 2) {
      throw new Error("mutual exclusion requires at least two assignments");
    }
    const assignments = combination.map((assignment) => {
      assertIdentity(assignment.coordinate_id, "mutual exclusion coordinate");
      assertIdentity(assignment.choice_id, "mutual exclusion choice");
      return Object.freeze({ ...assignment });
    }).sort((left, right) => compareText(left.coordinate_id, right.coordinate_id));
    if (new Set(assignments.map(({ coordinate_id }) => coordinate_id)).size !==
        assignments.length) {
      throw new Error("mutual exclusion coordinates must be unique");
    }
    return Object.freeze(assignments);
  }).sort((left, right) => compareText(
    digestRecallFieldIdentity(left),
    digestRecallFieldIdentity(right)
  ));
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: "finite_fixture_mutual_exclusion_v1" as const,
    fixture_id: params.fixture_id,
    snapshot_digest: params.snapshot_digest,
    forbidden_combinations: Object.freeze(combinations)
  });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}
