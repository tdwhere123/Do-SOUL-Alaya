import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from "../../../../field/field-identity.js";
import {
  assertDigest,
  assertIdentity,
  digestFiniteFixture,
  normalizeFiniteFixture,
  type FiniteMutualExclusionAssignment,
  type FiniteMutualExclusionReceipt,
  type FiniteOracleFixture
} from "./contract.js";

const issuedReceipts = new WeakSet<object>();

export function createFiniteMutualExclusionReceipt(params: Readonly<{
  readonly fixture: FiniteOracleFixture;
  readonly proposition_digest: FiniteMutualExclusionReceipt["proposition_digest"];
  readonly evidence_digest: FiniteMutualExclusionReceipt["evidence_digest"];
  readonly forbidden_combinations:
    readonly (readonly FiniteMutualExclusionAssignment[])[];
}>): FiniteMutualExclusionReceipt {
  assertExactKeys(params, [
    "fixture", "proposition_digest", "evidence_digest", "forbidden_combinations"
  ]);
  const fixture = fixtureWithoutExclusions(params.fixture);
  assertDigest(params.proposition_digest, "mutual exclusion proposition");
  assertDigest(params.evidence_digest, "mutual exclusion evidence");
  const combinations = normalizeCombinations(params.forbidden_combinations, fixture);
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: "finite_fixture_mutual_exclusion_v1" as const,
    fixture_id: fixture.fixture_id,
    snapshot_digest: fixture.snapshot_digest,
    fixture_premise_digest: digestFiniteFixture(fixture),
    proposition_digest: params.proposition_digest,
    evidence_digest: params.evidence_digest,
    forbidden_combinations: combinations
  });
  const receipt = Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
  issuedReceipts.add(receipt);
  return receipt;
}

export function verifyFiniteMutualExclusionReceipt(
  receipt: FiniteMutualExclusionReceipt,
  fixtureInput: FiniteOracleFixture
): void {
  const fixture = fixtureWithoutExclusions(fixtureInput);
  const { receipt_digest: _digest, ...body } = receipt;
  if (!issuedReceipts.has(receipt) || receipt.schema_version !== 1 ||
      receipt.operator_id !== "finite_fixture_mutual_exclusion_v1" ||
      receipt.fixture_id !== fixture.fixture_id ||
      receipt.snapshot_digest !== fixture.snapshot_digest ||
      receipt.fixture_premise_digest !== digestFiniteFixture(fixture) ||
      receipt.receipt_digest !== digestRecallFieldIdentity(body)) {
    throw new Error("finite mutual exclusion source authority or binding mismatch");
  }
  normalizeCombinations(receipt.forbidden_combinations, fixture);
}

function fixtureWithoutExclusions(fixture: FiniteOracleFixture): FiniteOracleFixture {
  const { mutual_exclusion_receipts: _receipts, ...base } = fixture;
  return normalizeFiniteFixture(base);
}

function normalizeCombinations(
  values: readonly (readonly FiniteMutualExclusionAssignment[])[],
  fixture: FiniteOracleFixture
): readonly (readonly FiniteMutualExclusionAssignment[])[] {
  const coordinates = new Map(fixture.coordinates.map((coordinate) => [
    coordinate.coordinate_id,
    new Set(coordinate.choices.map(({ choice_id }) => choice_id))
  ]));
  const combinations = values.map((combination) => {
    if (combination.length < 2) {
      throw new Error("mutual exclusion requires at least two assignments");
    }
    const assignments = combination.map((assignment) => {
      assertExactKeys(assignment, ["coordinate_id", "choice_id"]);
      assertIdentity(assignment.coordinate_id, "mutual exclusion coordinate");
      assertIdentity(assignment.choice_id, "mutual exclusion choice");
      if (!coordinates.get(assignment.coordinate_id)?.has(assignment.choice_id)) {
        throw new Error("mutual exclusion assignment is outside fixture choices");
      }
      return Object.freeze({ ...assignment });
    }).sort((left, right) => compareText(left.coordinate_id, right.coordinate_id));
    if (new Set(assignments.map(({ coordinate_id }) => coordinate_id)).size !==
        assignments.length) {
      throw new Error("mutual exclusion coordinates must be unique");
    }
    return Object.freeze(assignments);
  }).sort((left, right) => compareText(
    digestRecallFieldIdentity(left), digestRecallFieldIdentity(right)
  ));
  if (new Set(combinations.map(digestRecallFieldIdentity)).size !== combinations.length) {
    throw new Error("mutual exclusion combinations must be unique");
  }
  return Object.freeze(combinations);
}

function assertExactKeys(value: object, fields: readonly string[]): void {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...fields].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) =>
    key !== expected[index])) throw new Error("mutual exclusion value has unknown fields");
}
