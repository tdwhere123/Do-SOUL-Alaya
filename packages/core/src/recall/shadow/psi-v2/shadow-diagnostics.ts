import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { freezeShadow } from "../envelope.js";
import type { D1CandidateEnvelopeMap } from "../d1/legal-envelope.js";
import { peelPsiV2Frontiers, psiV2CycleCount } from "./frontier.js";
import { comparePsiV2 } from "./compare.js";
import { adaptLexicalIntervalEnvelopeToCollapse } from "./lexical-interval-adapter.js";
import type { PsiV2CandidateV1 } from "./types.js";
import type { SupportMaterializationV1 } from "../support/index.js";
import { isPsiCycleFailure } from "../frontier-peel.js";

export type PsiV2ShadowDiagnosticsV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: "recall_psi_v2_shadow_v1";
  readonly frontier_width: number;
  readonly undominated_share: number;
  readonly blocked_share: number;
  readonly tradeoff_share: number;
  readonly equal_share: number;
  readonly cycle_count: number;
  readonly raw_fragment_veto: false;
  readonly support_graph_digest: string | null;
  readonly digest: RecallFieldDigest;
}>;

export type PsiV2ShadowInputV1 = Readonly<{
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly candidate_keys: readonly string[];
  readonly lexical_interval_by_key?: Readonly<Record<string, D1CandidateEnvelopeMap>>;
  readonly support?: SupportMaterializationV1;
}>;

export function buildPsiV2ShadowDiagnostics(
  input: PsiV2ShadowInputV1
): PsiV2ShadowDiagnosticsV1 {
  const candidates = input.candidate_keys.map((key) =>
    toPsiCandidate(key, input)
  );
  const peeled = peelPsiV2Frontiers(candidates);
  const pairShares = pairSharesOf(candidates);
  const cycleCount = psiV2CycleCount(peeled);
  const frontierWidth = isPsiCycleFailure(peeled) ? 0 : peeled.layers.length;
  const undominated = isPsiCycleFailure(peeled)
    ? 0
    : (peeled.layers[0]?.member_keys.length ?? 0);
  const body = freezeShadow({
    schema_version: 1 as const,
    operator_id: "recall_psi_v2_shadow_v1" as const,
    frontier_width: frontierWidth,
    undominated_share: share(undominated, candidates.length),
    blocked_share: pairShares.blocked,
    tradeoff_share: pairShares.tradeoff,
    equal_share: pairShares.equal,
    cycle_count: cycleCount,
    raw_fragment_veto: false as const,
    support_graph_digest: input.support?.graph.digest ?? null
  });
  return freezeShadow({
    ...body,
    digest: digestRecallFieldIdentity(body)
  });
}

function toPsiCandidate(key: string, input: PsiV2ShadowInputV1): PsiV2CandidateV1 {
  const envelopeMap = input.lexical_interval_by_key?.[key];
  if (envelopeMap?.primary === null || envelopeMap?.primary === undefined) {
    return { candidate_id: key, coordinates: [] };
  }
  return {
    candidate_id: key,
    coordinates: [{
      proposition_id: "lex.interval",
      applicable: true,
      collapse: adaptLexicalIntervalEnvelopeToCollapse(
        envelopeMap.primary.envelope,
        {
          coordinate_id: `lex.interval:${key}`,
          query_id: input.query_id,
          snapshot_digest: input.snapshot_digest,
          candidate_id: key,
          proposition_id: "lex.interval"
        },
        [{ source_id: "lexical.interval.primary", producer: "lexical.interval.adapter.v1" }]
      )
    }]
  };
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
