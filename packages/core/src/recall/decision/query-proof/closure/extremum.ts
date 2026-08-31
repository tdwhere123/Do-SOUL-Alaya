import {
  readRecallFiniteFieldClosureAuthority,
  type RecallFiniteFieldClosureAuthority
} from "../../../field/finite-field-seal.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { compareText } from "../../../../shared/compare-text.js";
import type { ChannelClosureResult } from "./contract.js";
import { verifyChannelClosureResult } from "./verify.js";

export const EXTREMUM_CLOSURE_WITNESS_OPERATOR_ID =
  "query_proof_extremum_closure_witness_v1";

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
  readonly authority: RecallFiniteFieldClosureAuthority;
  readonly closure: ChannelClosureResult;
  readonly operator: "argmax" | "argmin";
  readonly sensitivity_id: string;
}>): ExtremumClosureWitness | null {
  let source: ReturnType<typeof readRecallFiniteFieldClosureAuthority>;
  try {
    assertExactKeys(params, ["authority", "closure", "operator", "sensitivity_id"]);
    if (params.operator !== "argmax" && params.operator !== "argmin") return null;
    source = readRecallFiniteFieldClosureAuthority(params.authority);
    verifyChannelClosureResult(params.closure);
  } catch {
    return null;
  }
  const declared = source.sensitivities.find(({ sensitivity_id }) =>
    sensitivity_id === params.sensitivity_id);
  if (declared?.effect !== "extremum_interval" ||
      params.closure.status !== "exact_closed" ||
      params.closure.query_digest !== source.query_digest ||
      params.closure.snapshot_digest !== source.snapshot_digest ||
      params.closure.principal_digest !== source.principal_digest ||
      params.closure.domain_id !== source.domain_id ||
      params.closure.universe_digest !== source.universe_digest) return null;
  const winners = closedExtremumIds(params.operator, source.extremum_intervals);
  if (winners === null) return null;
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: EXTREMUM_CLOSURE_WITNESS_OPERATOR_ID,
    operator: params.operator,
    closure_result_digest: params.closure.result_digest,
    query_digest: source.query_digest,
    snapshot_digest: source.snapshot_digest,
    principal_digest: source.principal_digest,
    universe_digest: source.universe_digest,
    sensitivity_id: params.sensitivity_id,
    extremal_binding_ids: winners,
    interval_digest: digestRecallFieldIdentity(source.extremum_intervals)
  });
  return Object.freeze({
    ...body,
    witness_digest: digestRecallFieldIdentity(body)
  });
}

function assertExactKeys(value: object, fields: readonly string[]): void {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...fields].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) =>
    key !== expected[index])) throw new Error("extremum witness input has unknown fields");
}

function closedExtremumIds(
  operator: "argmax" | "argmin",
  intervals: readonly Readonly<{
    readonly binding_id: string;
    readonly lower: number;
    readonly upper: number;
  }>[]
): readonly string[] | null {
  if (intervals.length === 0) return null;
  const point = operator === "argmax"
    ? Math.max(...intervals.map(({ lower }) => lower))
    : Math.min(...intervals.map(({ upper }) => upper));
  const winners = intervals.filter(({ lower, upper }) =>
    lower === upper && lower === point);
  if (winners.length === 0) return null;
  const winnerIds = new Set(winners.map(({ binding_id }) => binding_id));
  const separated = intervals.filter(({ binding_id }) => !winnerIds.has(binding_id))
    .every(({ lower, upper }) => operator === "argmax" ? upper < point : lower > point);
  return separated
    ? Object.freeze(winners.map(({ binding_id }) => binding_id))
    : null;
}
