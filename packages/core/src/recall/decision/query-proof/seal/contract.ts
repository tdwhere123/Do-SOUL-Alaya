import { compareText } from "../../../../shared/compare-text.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../../../field/field-identity.js";
import { SHADOW_CAPTURE_OPERATOR_ID } from "../../prefix-capture/identity.js";
import type { AbstractRefinementRequest } from "../proof/abstract/contract.js";
import {
  normalizeDecisionTrace,
  type FiniteDecisionTrace
} from "../proof/oracle/contract.js";
import type { QueryCompiledGammaV1 } from "../gamma/contract.js";

export const QUERY_PROOF_FINAL_DECISION_OPERATOR_ID =
  "query_proof_final_decision_v1" as const;

export const DECISION_STABILITY_SEAL_OPERATOR_ID =
  "query_proof_decision_stability_seal_v1" as const;

export const QUERY_PROOF_TIE_POLICY = "identity_after_equal_gamma" as const;

export const LIVE_DECIDE_OPERATOR_BRAND = Symbol.for("alaya.query_proof.live_decide_q");

export type DecisionContractIdentityV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof QUERY_PROOF_FINAL_DECISION_OPERATOR_ID;
  readonly gamma_digest: RecallFieldDigest;
  readonly walk_operator_id: typeof SHADOW_CAPTURE_OPERATOR_ID;
  readonly walk_transfer_digest: RecallFieldDigest;
  readonly prefix_sk: true;
  readonly tie_policy: typeof QUERY_PROOF_TIE_POLICY;
  readonly query_digest: RecallFieldDigest;
  readonly compilation_digest: RecallFieldDigest;
  readonly candidate_universe_digest: RecallFieldDigest;
  readonly standings_digest: RecallFieldDigest;
  readonly semantic_feasibility_digest: RecallFieldDigest;
  readonly resource_policy_digest: RecallFieldDigest;
}>;

export type DecisionStabilitySealV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof DECISION_STABILITY_SEAL_OPERATOR_ID;
  readonly decision_contract_digest: RecallFieldDigest;
  readonly authority_digest: RecallFieldDigest;
  readonly query_digest: RecallFieldDigest;
  readonly compilation_digest: RecallFieldDigest;
  readonly live_compilation_digest: RecallFieldDigest;
  readonly world_digest: RecallFieldDigest;
  readonly proof_state_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly gamma_digest: RecallFieldDigest;
  readonly walk_operator_id: typeof SHADOW_CAPTURE_OPERATOR_ID;
  readonly k_max: number;
  readonly candidate_prefix: readonly string[];
  readonly answer_bindings: FiniteDecisionTrace["answer_bindings"];
  readonly pick_reasons: FiniteDecisionTrace["pick_reasons"];
  readonly outcome_digest: RecallFieldDigest;
  readonly seal_digest: RecallFieldDigest;
}>;

export type SealCheckerStatusV1 =
  | "CERTIFIED_STABLE"
  | "UNCERTIFIED_OPEN"
  | "CONFLICT"
  | "UNSUPPORTED";

export type SealCheckerResultV1 =
  | Readonly<{
      readonly status: "CERTIFIED_STABLE";
      readonly decision_contract_digest: RecallFieldDigest;
      readonly seal: DecisionStabilitySealV1;
    }>
  | Readonly<{
      readonly status: "UNCERTIFIED_OPEN";
      readonly decision_contract_digest: RecallFieldDigest;
      readonly reason: string;
      readonly requested_refinements: readonly AbstractRefinementRequest[];
    }>
  | Readonly<{
      readonly status: "CONFLICT";
      readonly decision_contract_digest: RecallFieldDigest;
      readonly reason: string;
    }>
  | Readonly<{
      readonly status: "UNSUPPORTED";
      readonly decision_contract_digest: RecallFieldDigest;
      readonly reason: string;
    }>;

export function digestDecisionContract(
  compiled: QueryCompiledGammaV1,
  walkTransferDigest: RecallFieldDigest
): RecallFieldDigest {
  const body: DecisionContractIdentityV1 = Object.freeze({
    schema_version: 1 as const,
    operator_id: QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
    gamma_digest: compiled.gamma_digest,
    walk_operator_id: SHADOW_CAPTURE_OPERATOR_ID,
    walk_transfer_digest: walkTransferDigest,
    prefix_sk: true as const,
    tie_policy: QUERY_PROOF_TIE_POLICY,
    query_digest: compiled.query_digest,
    compilation_digest: compiled.compilation_digest,
    candidate_universe_digest: digestRecallFieldIdentity(
      [...compiled.semantic_feasibility.map((row) => row.candidate_key)].sort(compareText)
    ),
    standings_digest: digestRecallFieldIdentity(compiled.standings),
    semantic_feasibility_digest: digestRecallFieldIdentity(compiled.semantic_feasibility),
    resource_policy_digest: digestRecallFieldIdentity(compiled.resource_policy)
  });
  return digestRecallFieldIdentity(body);
}

export function parseDecisionStabilitySeal(
  value: unknown
): DecisionStabilitySealV1 {
  if (typeof value !== "object" || value === null) {
    throw new Error("decision stability seal must be an object");
  }
  const record = value as Partial<DecisionStabilitySealV1> & { readonly proof_digest?: string };
  if (record.operator_id !== DECISION_STABILITY_SEAL_OPERATOR_ID) {
    throw new Error("kernel-only proof cannot parse as a final decision seal");
  }
  const keys = Object.keys(value).sort(compareText);
  const expected = [
    "schema_version", "operator_id", "decision_contract_digest", "authority_digest",
    "query_digest", "compilation_digest", "live_compilation_digest", "world_digest",
    "proof_state_digest", "snapshot_digest", "gamma_digest", "walk_operator_id",
    "k_max", "candidate_prefix", "answer_bindings", "pick_reasons", "outcome_digest",
    "seal_digest"
  ].sort(compareText);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("decision stability seal has unknown or missing fields");
  }
  if (record.schema_version !== 1 || record.seal_digest === undefined) {
    throw new Error("decision stability seal is incomplete");
  }
  if (record.walk_operator_id !== SHADOW_CAPTURE_OPERATOR_ID) {
    throw new Error("decision stability seal walk operator identity mismatch");
  }
  if (typeof record.k_max !== "number" || !Number.isSafeInteger(record.k_max) ||
      record.k_max <= 0) {
    throw new Error("decision stability seal is incomplete");
  }
  if (!Array.isArray(record.candidate_prefix) || !Array.isArray(record.answer_bindings) ||
      !Array.isArray(record.pick_reasons)) {
    throw new Error("decision stability seal is incomplete");
  }
  const normalized = normalizeDecisionTrace({
    candidate_prefix: Object.freeze([...(record.candidate_prefix ?? [])]),
    answer_bindings: Object.freeze([...(record.answer_bindings ?? [])]),
    pick_reasons: Object.freeze([...(record.pick_reasons ?? [])])
  }, record.k_max);
  const outcomeDigest = requireDigest(record.outcome_digest);
  if (outcomeDigest !== normalized.trace_digest) {
    throw new Error("decision stability seal outcome trace mismatch");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: DECISION_STABILITY_SEAL_OPERATOR_ID,
    decision_contract_digest: requireDigest(record.decision_contract_digest),
    authority_digest: requireDigest(record.authority_digest),
    query_digest: requireDigest(record.query_digest),
    compilation_digest: requireDigest(record.compilation_digest),
    live_compilation_digest: requireDigest(record.live_compilation_digest),
    world_digest: requireDigest(record.world_digest),
    proof_state_digest: requireDigest(record.proof_state_digest),
    snapshot_digest: requireDigest(record.snapshot_digest),
    gamma_digest: requireDigest(record.gamma_digest),
    walk_operator_id: SHADOW_CAPTURE_OPERATOR_ID,
    k_max: record.k_max,
    candidate_prefix: normalized.candidate_prefix,
    answer_bindings: normalized.answer_bindings,
    pick_reasons: normalized.pick_reasons,
    outcome_digest: outcomeDigest
  });
  if (record.seal_digest !== digestRecallFieldIdentity(body)) {
    throw new Error("decision stability seal digest mismatch");
  }
  return Object.freeze({ ...body, seal_digest: record.seal_digest });
}

function requireDigest(value: unknown): RecallFieldDigest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error("decision stability seal is incomplete");
  }
  return value as RecallFieldDigest;
}

export function sortDecisionBindings(
  bindings: FiniteDecisionTrace["answer_bindings"]
): FiniteDecisionTrace["answer_bindings"] {
  return Object.freeze([...bindings].sort((left, right) =>
    compareText(left.binding_id, right.binding_id)));
}
