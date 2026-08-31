import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from "../../../../field/field-identity.js";
import {
  isSourceIssuedLexicalBoundProof,
  verifyLexicalBoundProof,
  type LexicalBoundLaneId,
  type LexicalBoundProof,
  type LexicalBoundProofCaptured
} from "../../../../runtime/diagnostics/lexical-bound-proof.js";
import type {
  ChannelClosureScope,
  ChannelRemainingEffect,
  ClosureQuerySensitivity
} from "../../closure/contract.js";

export type LexicalClosureSensitivity = ClosureQuerySensitivity & Readonly<{
  readonly lane_id: LexicalBoundLaneId;
  readonly effect: "proposition_bound" | "extremum_interval";
}>;

export type LexicalClosureAuthorityState = Readonly<{
  readonly proof: LexicalBoundProofCaptured;
  readonly scope: ChannelClosureScope;
  readonly effects_by_lane: Readonly<Partial<Record<
    LexicalBoundLaneId,
    readonly ChannelRemainingEffect[]
  >>>;
}>;

declare const lexicalClosureAuthorityBrand: unique symbol;
export type LexicalClosureAuthority = Readonly<{
  readonly [lexicalClosureAuthorityBrand]: true;
}>;

const states = new WeakMap<object, LexicalClosureAuthorityState>();
const authoritiesByProof = new WeakMap<object, LexicalClosureAuthority>();

export function issueLexicalClosureAuthority(params: Readonly<{
  readonly proof: LexicalBoundProof;
  readonly query_digest: ChannelClosureScope["query_digest"];
  readonly principal_digest: ChannelClosureScope["principal_digest"];
  readonly sensitivities: readonly LexicalClosureSensitivity[];
}>): LexicalClosureAuthority {
  assertExactKeys(params, ["proof", "query_digest", "principal_digest", "sensitivities"]);
  verifyLexicalBoundProof(params.proof);
  if (params.proof.status !== "captured" ||
      !isSourceIssuedLexicalBoundProof(params.proof)) {
    throw new Error("lexical closure requires a source-issued captured proof");
  }
  const next = materializeState(params as Parameters<typeof materializeState>[0]);
  const existing = authoritiesByProof.get(params.proof);
  if (existing !== undefined) {
    if (digestRecallFieldIdentity(readLexicalClosureAuthority(existing).scope) !==
        digestRecallFieldIdentity(next.scope)) {
      throw new Error("lexical proof is already bound to another closure scope");
    }
    return existing;
  }
  const authority = Object.freeze({}) as LexicalClosureAuthority;
  states.set(authority, next);
  authoritiesByProof.set(params.proof, authority);
  return authority;
}

export function readLexicalClosureAuthority(
  authority: LexicalClosureAuthority
): LexicalClosureAuthorityState {
  const state = states.get(authority);
  if (state === undefined) throw new Error("lexical closure authority is invalid");
  verifyLexicalBoundProof(state.proof);
  return state;
}

function materializeState(params: Readonly<{
  readonly proof: LexicalBoundProofCaptured;
  readonly query_digest: ChannelClosureScope["query_digest"];
  readonly principal_digest: ChannelClosureScope["principal_digest"];
  readonly sensitivities: readonly LexicalClosureSensitivity[];
}>): LexicalClosureAuthorityState {
  const { proof } = params;
  if (typeof proof.identity.request_digest !== "string" ||
      typeof proof.identity.snapshot_digest !== "string" ||
      typeof proof.identity.workspace_id !== "string" ||
      typeof proof.field_prefix !== "string" ||
      proof.candidate_key_domain !== "memory_object_id") {
    throw new Error("lexical closure proof identity is unavailable");
  }
  assertDigest(params.query_digest, "lexical closure query");
  assertDigest(params.principal_digest, "lexical closure principal");
  const sensitivities = normalizeSensitivities(params.sensitivities, proof);
  const universeDigest = digestRecallFieldIdentity({
    operator_id: "lexical_source_universe_v1",
    proof_digest: proof.proof_digest,
    candidate_key_domain: proof.candidate_key_domain,
    lane_universes: proof.receipt.lanes.map((lane) => Object.freeze({
      lane_id: lane.lane_id,
      universe_digest: lane.evaluated_universe?.universe_digest ?? null
    })).sort((left, right) => compareText(left.lane_id, right.lane_id))
  });
  const scopeBase = {
    query_digest: params.query_digest,
    request_digest: proof.identity.request_digest,
    snapshot_digest: proof.identity.snapshot_digest,
    principal_digest: params.principal_digest,
    workspace_id: proof.identity.workspace_id,
    observer_id: proof.receipt.producer_id,
    channel_id: proof.field_prefix,
    domain_id: `LexDomain:${proof.field_prefix}`,
    universe_digest: universeDigest,
    sensitivities: Object.freeze(sensitivities.map(({ lane_id: _lane, ...row }) =>
      Object.freeze(row)))
  };
  const scope = Object.freeze(scopeBase);
  return Object.freeze({
    proof,
    scope,
    effects_by_lane: deriveEffects(proof, sensitivities)
  });
}

function normalizeSensitivities(
  values: readonly LexicalClosureSensitivity[],
  proof: LexicalBoundProofCaptured
): readonly LexicalClosureSensitivity[] {
  const laneIds = new Set(proof.receipt.lanes.map(({ lane_id }) => lane_id));
  const output = values.map((value) => {
    assertExactKeys(value, ["lane_id", "sensitivity_id", "effect", "target"]);
    assertIdentity(value.sensitivity_id, "lexical closure sensitivity");
    assertIdentity(value.target, "lexical closure sensitivity target");
    if (!laneIds.has(value.lane_id) ||
        (value.effect !== "proposition_bound" && value.effect !== "extremum_interval")) {
      throw new Error("lexical closure sensitivity is outside source lanes");
    }
    return Object.freeze({ ...value });
  }).sort((left, right) => compareText(left.sensitivity_id, right.sensitivity_id));
  if (new Set(output.map(({ sensitivity_id }) => sensitivity_id)).size !== output.length ||
      new Set(output.map(({ lane_id }) => lane_id)).size !== output.length) {
    throw new Error("lexical closure sensitivities and lane owners must be unique");
  }
  return Object.freeze(output);
}

function deriveEffects(
  proof: LexicalBoundProofCaptured,
  sensitivities: readonly LexicalClosureSensitivity[]
): LexicalClosureAuthorityState["effects_by_lane"] {
  return Object.freeze(Object.fromEntries(proof.receipt.lanes.flatMap((lane) => {
    const sensitivity = sensitivities.find(({ lane_id }) => lane_id === lane.lane_id);
    if (lane.status !== "truncated" || sensitivity === undefined ||
        typeof lane.unseen_upper_bound !== "number") return [];
    return [[lane.lane_id, Object.freeze([Object.freeze({
      effect_id: `${sensitivity.sensitivity_id}:source-unseen`,
      sensitivity_id: sensitivity.sensitivity_id,
      effect: sensitivity.effect,
      lower: 0,
      upper: lane.unseen_upper_bound
    })])]];
  })));
}

function assertIdentity(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

function assertDigest(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be sha256`);
}

function assertExactKeys(value: object, fields: readonly string[]): void {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...fields].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) =>
    key !== expected[index])) throw new Error("lexical closure value has unknown fields");
}
