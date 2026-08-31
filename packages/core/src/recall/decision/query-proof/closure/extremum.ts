import { compareText } from "../../../../shared/compare-text.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../../../field/field-identity.js";
import type { ChannelClosureResult } from "./contract.js";
import { verifyChannelClosureResult } from "./verify.js";

export const EXTREMUM_CLOSURE_WITNESS_OPERATOR_ID =
  "query_proof_extremum_closure_witness_v1";

export type ExtremumBindingInterval = Readonly<{
  readonly binding_id: string;
  readonly lower: number;
  readonly upper: number;
}>;

export type ExtremumClosureWitness = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof EXTREMUM_CLOSURE_WITNESS_OPERATOR_ID;
  readonly operator: "argmax" | "argmin";
  readonly closure_result_digest: RecallFieldDigest;
  readonly query_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly universe_digest: RecallFieldDigest;
  readonly sensitivity_id: string;
  readonly extremal_binding_ids: readonly string[];
  readonly interval_digest: RecallFieldDigest;
  readonly witness_digest: RecallFieldDigest;
}>;

export function createExtremumClosureWitness(params: Readonly<{
  readonly closure: ChannelClosureResult;
  readonly operator: "argmax" | "argmin";
  readonly sensitivity_id: string;
  readonly intervals: readonly ExtremumBindingInterval[];
  readonly extremal_binding_ids: readonly string[];
  readonly tie_set_complete: boolean;
}>): ExtremumClosureWitness | null {
  try {
    verifyChannelClosureResult(params.closure);
  } catch {
    return null;
  }
  if (params.closure.status !== "exact_closed" ||
      params.closure.completeness_refs.length === 0 ||
      !params.tie_set_complete || params.sensitivity_id.length === 0 ||
      params.sensitivity_id.trim() !== params.sensitivity_id) return null;
  const intervals = normalizeIntervals(params.intervals);
  const declared = normalizeIdentities(params.extremal_binding_ids);
  if (intervals === null || declared === null ||
      !isClosedExtremum(params.operator, intervals, declared)) return null;
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: EXTREMUM_CLOSURE_WITNESS_OPERATOR_ID,
    operator: params.operator,
    closure_result_digest: params.closure.result_digest,
    query_digest: params.closure.query_digest,
    snapshot_digest: params.closure.snapshot_digest,
    principal_digest: params.closure.principal_digest,
    universe_digest: params.closure.universe_digest,
    sensitivity_id: params.sensitivity_id,
    extremal_binding_ids: declared,
    interval_digest: digestRecallFieldIdentity(intervals)
  });
  return Object.freeze({
    ...body,
    witness_digest: digestRecallFieldIdentity(body)
  });
}

function isClosedExtremum(
  operator: "argmax" | "argmin",
  intervals: readonly ExtremumBindingInterval[],
  declared: readonly string[]
): boolean {
  const winners = intervals.filter(({ binding_id }) => declared.includes(binding_id));
  if (winners.length !== declared.length || winners.length === 0) return false;
  const winnerPoint = operator === "argmax"
    ? Math.min(...winners.map(({ lower }) => lower))
    : Math.max(...winners.map(({ upper }) => upper));
  if (!winners.every(({ lower, upper }) => lower === upper && lower === winnerPoint)) {
    return false;
  }
  return intervals.filter(({ binding_id }) => !declared.includes(binding_id))
    .every(({ lower, upper }) => operator === "argmax"
      ? upper < winnerPoint
      : lower > winnerPoint);
}

function normalizeIntervals(
  values: readonly ExtremumBindingInterval[]
): readonly ExtremumBindingInterval[] | null {
  const output = values.map((value) => Object.freeze({ ...value }))
    .sort((left, right) => compareText(left.binding_id, right.binding_id));
  if (output.length === 0 || new Set(output.map(({ binding_id }) => binding_id)).size !==
      output.length || output.some(({ binding_id, lower, upper }) =>
        binding_id.trim().length === 0 || !Number.isFinite(lower) ||
        !Number.isFinite(upper) || upper < lower)) return null;
  return Object.freeze(output);
}

function normalizeIdentities(values: readonly string[]): readonly string[] | null {
  const output = [...values].sort(compareText);
  if (output.length === 0 || new Set(output).size !== output.length ||
      output.some((value) => value.length === 0 || value.trim() !== value)) return null;
  return Object.freeze(output);
}
