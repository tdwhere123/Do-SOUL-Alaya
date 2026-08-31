import { compareText } from "../../../../../shared/compare-text.js";
import { normalizeFiniteFixture, type FiniteOracleFixture } from
  "../oracle/contract.js";
import type { LiveClosureAuthorityBinding } from
  "../../closure/live-authority-binding.js";
import {
  assertIdentity,
  type AbstractCoordinate,
  type AbstractProofKernelInput
} from "./contract.js";

export function validateAbstractKernelInput(
  input: AbstractProofKernelInput,
  live: LiveClosureAuthorityBinding
): string | null {
  try {
    assertExactKeys(input, [
      "live_authority", "fixture", "concrete_operator", "k_max", "closures",
      "coordinates", "limits", "operator"
    ], "abstract kernel input");
    assertExactKeys(input.limits, [
      "max_channels", "max_coordinates", "max_sensitivities"
    ], "abstract kernel limits");
    if (!Array.isArray(input.closures) || !Array.isArray(input.coordinates)) {
      return "abstract kernel closures and coordinates must be arrays";
    }
    const fixture = normalizeFiniteFixture(input.fixture);
    if (fixture.snapshot_digest !== live.snapshot_digest) {
      return "abstract fixture snapshot is outside live authority";
    }
    if (input.k_max !== fixture.k_max) {
      return "abstract K_max does not match finite fixture";
    }
    assertExactKeys(input.concrete_operator, ["operator_id", "decide"],
      "abstract concrete operator");
    assertExactKeys(input.operator, ["operator_id", "evaluate"],
      "abstract operator");
    assertIdentity(input.concrete_operator.operator_id, "abstract concrete operator id");
    assertIdentity(input.operator.operator_id, "abstract operator id");
    if (typeof input.concrete_operator.decide !== "function" ||
        typeof input.operator.evaluate !== "function") {
      return "abstract operators must provide callable functions";
    }
    if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(input.operator.operator_id) ||
        input.operator.operator_id.includes("decide_q") ||
        input.operator.operator_id.includes("sealchecker_v1")) {
      return "abstract fixture operator uses a reserved final operator name";
    }
    if (!Number.isSafeInteger(input.k_max) || input.k_max < 0 ||
        !Number.isSafeInteger(input.limits.max_channels) ||
        !Number.isSafeInteger(input.limits.max_coordinates) ||
        !Number.isSafeInteger(input.limits.max_sensitivities) ||
        input.limits.max_channels < 1 || input.limits.max_coordinates < 1 ||
        input.limits.max_sensitivities < 1) {
      return "abstract kernel limits are invalid";
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "abstract kernel input is invalid";
  }
}

export function validateFixtureAbstractCoverage(
  fixture: FiniteOracleFixture,
  coordinates: readonly AbstractCoordinate[]
): string | null {
  if (fixture.coordinates.length !== coordinates.length) {
    return "abstract coordinates do not exactly cover finite fixture manifest";
  }
  for (let index = 0; index < coordinates.length; index += 1) {
    const coordinate = coordinates[index]!;
    const row = fixture.coordinates[index]!;
    if (coordinate.coordinate_id !== row.coordinate_id ||
        coordinate.sensitivity_id !== row.sensitivity_id ||
        coordinate.owner_id !== row.owner_id ||
        coordinate.kind !== row.abstract_kind) {
      return "abstract coordinate does not match finite fixture manifest";
    }
  }
  return null;
}

export function assertExactKeys(
  value: object,
  keys: readonly string[],
  field: string
): void {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) =>
    key !== expected[index])) throw new Error(`${field} has unknown or missing fields`);
}
