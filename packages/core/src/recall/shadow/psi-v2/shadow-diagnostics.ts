import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import type { D1CandidateEnvelopeMap } from "../d1/legal-envelope.js";
import { freezeShadow } from "../envelope.js";
import { isPsiCycleFailure } from "../frontier-peel.js";
import type { SupportMaterializationV1 } from "../support/index.js";
import type {
  SupportAliasRecordV1,
  SupportCorrelationRecordV1
} from "../support/types.js";
import type { SupportObservabilityGapV1 } from "../support/adapters/types.js";
import { comparePsiV2 } from "./compare.js";
import { peelPsiV2Frontiers, psiV2CycleCount } from "./frontier.js";
import {
  psiV2CandidateFromLexicalEnvelope,
  rawMissingFamilyFragment
} from "./from-envelope.js";
import type { PsiV2CandidateV1 } from "./types.js";

export type PsiV2ShadowObservationStatusV1 =
  | "observed"
  | "not_observed"
  | "producer_unavailable";

export type PsiV2ShadowVisibilityV1 = Readonly<{
  readonly conflict: boolean;
  readonly alias: boolean;
  readonly unknown_correlation: boolean;
  readonly unsupported: boolean;
}>;

export type PsiV2ShadowDiagnosticsV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: "recall_psi_v2_shadow_v1";
  readonly observation_status: PsiV2ShadowObservationStatusV1;
  readonly frontier_width: number;
  readonly undominated_share: number;
  readonly blocked_share: number;
  readonly tradeoff_share: number;
  readonly equal_share: number;
  readonly cycle_count: number;
  readonly raw_fragment_veto: boolean;
  readonly support_graph_digest: string | null;
  readonly visibility: PsiV2ShadowVisibilityV1 | null;
  readonly digest: RecallFieldDigest;
}>;

export type PsiV2ShadowInputV1 = Readonly<{
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly candidate_keys: readonly string[];
  readonly lexical_interval_by_key?: Readonly<Record<string, D1CandidateEnvelopeMap>>;
  readonly support?: SupportMaterializationV1;
  readonly aliases?: readonly SupportAliasRecordV1[];
  readonly correlations?: readonly SupportCorrelationRecordV1[];
  readonly conflicts?: readonly Readonly<{ readonly kind: string }>[];
  readonly unsupported?: readonly SupportObservabilityGapV1[];
}>;

export function buildPsiV2ShadowDiagnostics(
  input: PsiV2ShadowInputV1
): PsiV2ShadowDiagnosticsV1 {
  if (!producersRan(input)) return finish(unobservedBody(input));
  const candidates = input.lexical_interval_by_key === undefined
    ? []
    : input.candidate_keys.map((key) =>
      psiV2CandidateFromLexicalEnvelope(
        key,
        input.lexical_interval_by_key?.[key],
        input.query_id,
        input.snapshot_digest
      )
    );
  const peeled = peelPsiV2Frontiers(candidates);
  const pairShares = pairSharesOf(candidates);
  const cycleCount = psiV2CycleCount(peeled);
  const frontierWidth = isPsiCycleFailure(peeled) ? 0 : peeled.layers.length;
  const undominated = isPsiCycleFailure(peeled)
    ? 0
    : (peeled.layers[0]?.member_keys.length ?? 0);
  return finish({
    schema_version: 1 as const,
    operator_id: "recall_psi_v2_shadow_v1" as const,
    observation_status: "observed" as const,
    frontier_width: frontierWidth,
    undominated_share: share(undominated, candidates.length),
    blocked_share: pairShares.blocked,
    tradeoff_share: pairShares.tradeoff,
    equal_share: pairShares.equal,
    cycle_count: cycleCount,
    raw_fragment_veto: rawFragmentVeto(input, candidates),
    support_graph_digest: input.support?.graph.digest ?? null,
    visibility: visibilityOf(input)
  });
}

function producersRan(input: PsiV2ShadowInputV1): boolean {
  return input.lexical_interval_by_key !== undefined ||
    input.support !== undefined ||
    input.aliases !== undefined ||
    input.correlations !== undefined ||
    input.conflicts !== undefined ||
    input.unsupported !== undefined;
}

function unobservedBody(input: PsiV2ShadowInputV1) {
  return {
    schema_version: 1 as const,
    operator_id: "recall_psi_v2_shadow_v1" as const,
    observation_status: "not_observed" as const,
    frontier_width: 0,
    undominated_share: 0,
    blocked_share: 0,
    tradeoff_share: 0,
    equal_share: 0,
    cycle_count: 0,
    raw_fragment_veto: false,
    support_graph_digest: input.support?.graph.digest ?? null,
    visibility: null
  };
}

function visibilityOf(input: PsiV2ShadowInputV1): PsiV2ShadowVisibilityV1 {
  const aliases = input.aliases ?? input.support?.graph.aliases ?? [];
  const correlations = input.correlations ?? input.support?.graph.correlations ?? [];
  const gaps = input.unsupported ?? input.support?.gaps ?? [];
  const polarities = input.support?.polarities ?? [];
  return freezeShadow({
    conflict: (input.conflicts?.length ?? 0) > 0 ||
      aliases.some((row) => row.state === "conflict") ||
      polarities.some((row) => row.epistemic.kind === "conflict" || row.payload?.polarity === "both"),
    alias: aliases.length > 0,
    unknown_correlation: correlations.some((row) => row.state === "possibly_correlated"),
    unsupported: gaps.length > 0
  });
}

function rawFragmentVeto(
  input: PsiV2ShadowInputV1,
  candidates: readonly PsiV2CandidateV1[]
): boolean {
  const maps = input.lexical_interval_by_key;
  if (maps === undefined) return false;
  const byId = new Map(candidates.map((row) => [row.candidate_id, row]));
  const keys = input.candidate_keys;
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      if (pairRawFragmentVeto(keys[i]!, keys[j]!, maps, byId)) return true;
    }
  }
  return false;
}

function pairRawFragmentVeto(
  leftKey: string,
  rightKey: string,
  maps: Readonly<Record<string, D1CandidateEnvelopeMap>>,
  byId: ReadonlyMap<string, PsiV2CandidateV1>
): boolean {
  const leftMap = maps[leftKey];
  const rightMap = maps[rightKey];
  const left = byId.get(leftKey);
  const right = byId.get(rightKey);
  if (leftMap === undefined || rightMap === undefined || left === undefined || right === undefined) {
    return false;
  }
  if (!rawMissingFamilyFragment(leftMap, rightMap)) return false;
  return comparePsiV2(left, right).kind === "blocked";
}

function pairSharesOf(candidates: readonly PsiV2CandidateV1[]): {
  blocked: number;
  tradeoff: number;
  equal: number;
} {
  let blocked = 0;
  let tradeoff = 0;
  let equal = 0;
  let pairs = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      pairs += 1;
      const kind = comparePsiV2(candidates[i]!, candidates[j]!).kind;
      if (kind === "blocked") blocked += 1;
      if (kind === "tradeoff") tradeoff += 1;
      if (kind === "equal") equal += 1;
    }
  }
  return {
    blocked: share(blocked, pairs),
    tradeoff: share(tradeoff, pairs),
    equal: share(equal, pairs)
  };
}

function share(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function finish(
  body: Omit<PsiV2ShadowDiagnosticsV1, "digest">
): PsiV2ShadowDiagnosticsV1 {
  const frozen = freezeShadow(body);
  return freezeShadow({
    ...frozen,
    digest: digestRecallFieldIdentity(frozen)
  });
}
