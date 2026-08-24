import {
  type CoverageSelectableCandidate,
  type CoverageSelectionCandidateState,
  type CoverageSelectionSupplementary
} from "../../../recall/delivery/coverage-selection.js";
import type { CandidateCoverageAtom } from
  "../../../recall/delivery/fine-assessment-selection/coverage-atoms.js";
import { requireByKey } from
  "../../../recall/delivery/select-gamma/admission/require-by-key.js";
import { bindCoverageSelectionWalkObjective } from
  "../../../recall/delivery/select-gamma/walk-objective.js";
import type {
  SelectGammaBinding,
  SelectGammaFormulaCandidate,
  SelectGammaRequest
} from "../../../recall/delivery/select-gamma/types.js";
import { createAttributedFacilityCoverageObjective } from
  "../../../recall/field/facility-objective.js";
import { materializeAttributedQueryFacilityDemand } from
  "../../../recall/field/query-facility-demand.js";

export const PARITY_GOLDS = Object.freeze([
  "gold-apple",
  "gold-banana",
  "gold-orange"
] as const);

export type FrozenParityPool = Readonly<{
  readonly request: SelectGammaRequest;
  readonly binding: SelectGammaBinding;
}>;

export function frozenParityPool(): FrozenParityPool {
  const candidates = Object.freeze([
    formulaCandidate("gold-apple", {
      quality: 0.8,
      cover: { slice: 1 },
      source: "grocery-receipt"
    }),
    formulaCandidate("gold-banana", {
      quality: 0.7,
      cover: { f3: 1 },
      source: "grocery-receipt"
    }),
    formulaCandidate("gold-orange", {
      quality: 0.6,
      cover: { slice: 1 },
      source: "market-note"
    }),
    formulaCandidate("distractor-high", {
      quality: 0.65,
      cover: {},
      source: "blog"
    })
  ]);
  const request: SelectGammaRequest = Object.freeze({
    workspace_id: "workspace-1",
    generation_id: `sha256:${"a".repeat(64)}`,
    condition_digest: `sha256:${"b".repeat(64)}`,
    eligible_candidate_keys: Object.freeze(candidates.map(
      ({ candidate_key }) => candidate_key
    )),
    token_budget: 100
  });
  return Object.freeze({
    request,
    binding: Object.freeze({
      workspace_id: request.workspace_id,
      generation_id: request.generation_id,
      condition_digest: request.condition_digest,
      candidates,
      feature_weights: Object.freeze({ slice: 1, f3: 1 }),
      max_selected: 3,
      per_dimension_limits: null
    })
  });
}

export function withSourceDedupe(
  binding: SelectGammaBinding,
  sourceHardDedupe: boolean
): SelectGammaBinding {
  return Object.freeze({
    ...binding,
    source_hard_dedupe: sourceHardDedupe
  });
}

export function facilityWalkObjective(pool: FrozenParityPool) {
  const demand = materializeAttributedQueryFacilityDemand({
    query_demand: Object.freeze({
      schema_version: 1,
      atoms: Object.freeze([
        queryDemand("fruit-count"),
        queryDemand("other-count")
      ])
    }),
    weights: {
      entity: 1,
      relation: 1,
      time: 1,
      logical_object: 1,
      independent_evidence: 1
    }
  });
  const fruit = "facility:logical_object:object_id:fruit-count";
  const other = "facility:logical_object:object_id:other-count";
  const states = pool.binding.candidates.map((candidate) =>
    coverageState(candidate));
  const byKey = new Map(states.map((state) => [
    state.candidate.fusion.candidate_key,
    state
  ]));
  const supplementaryData: CoverageSelectionSupplementary = {
    evidenceGistsByMemoryId: {}
  };
  return bindCoverageSelectionWalkObjective({
    objective: createAttributedFacilityCoverageObjective({
      base_relevance_weight: 1,
      demand,
      matches_by_candidate_key: new Map([
        ["gold-apple", [objectMatch(requireByKey(byKey, "gold-apple", "missing coverage state"), fruit)]],
        ["gold-banana", [objectMatch(requireByKey(byKey, "gold-banana", "missing coverage state"), fruit)]],
        ["gold-orange", [objectMatch(requireByKey(byKey, "gold-orange", "missing coverage state"), other)]]
      ])
    }),
    candidateStates: states,
    supplementaryData
  });
}

export function formulaCandidate(
  key: string,
  params: Readonly<{
    readonly quality: number;
    readonly cover: Readonly<Record<string, number>>;
    readonly source: string;
  }>
): SelectGammaFormulaCandidate {
  return Object.freeze({
    workspace_id: "workspace-1",
    candidate_key: key,
    eligibility: { risk: "clear" as const, authority: "clear" as const },
    object_key: `memory:${key}`,
    dimension: "procedure",
    source: { status: "available" as const, key: params.source },
    lineage: { status: "unavailable" as const },
    token_cost: 1,
    quality: params.quality,
    authority_tie_break: "unavailable" as const,
    quality_channels: {
      temporal: { status: "unavailable" as const }
    },
    cover: params.cover
  });
}

function coverageState(
  candidate: SelectGammaFormulaCandidate
): CoverageSelectionCandidateState<CoverageSelectableCandidate> {
  const atom = objectAtom(candidate.candidate_key);
  return Object.freeze({
    candidate: selectable(candidate),
    identity: Object.freeze({
      objectKey: candidate.object_key,
      gistKey: `gist:${candidate.candidate_key}`
    }),
    relevance: candidate.quality,
    coverage: Object.freeze({
      schema_version: 1 as const,
      operator_id: "attributed_coverage_atoms_v1",
      candidate_key: candidate.candidate_key,
      activation: Object.freeze({
        schema_version: 1 as const,
        operator_id: "candidate_semantic_max_v1",
        state: "absent" as const,
        score: null,
        winner: null,
        observations: Object.freeze([]),
        missing_channel_policy: "no_op" as const
      }),
      evidence_semantic_completeness: "not_observed" as const,
      projection_match_count: 0,
      atoms: Object.freeze([atom])
    })
  });
}

function selectable(
  candidate: SelectGammaFormulaCandidate
): CoverageSelectableCandidate {
  return Object.freeze({
    entry: Object.freeze({
      object_id: candidate.candidate_key,
      object_kind: "memory_entry" as const,
      evidence_refs: Object.freeze([])
    }),
    effectiveFactors: Object.freeze({
      activation: 0.5,
      relevance: candidate.quality,
      graph_support: 0,
      path_plasticity: 0,
      budget_penalty: 0,
      conflict_penalty: 0
    }),
    fusion: Object.freeze({
      candidate_key: candidate.candidate_key,
      fused_score: candidate.quality
    })
  });
}

function objectMatch(
  state: CoverageSelectionCandidateState<CoverageSelectableCandidate>,
  demandAtomId: string
) {
  const atom = state.coverage.atoms[0]!;
  return Object.freeze({
    demand_atom_id: demandAtomId,
    coverage_atom_id: atom.atom_id,
    independence_key: atom.independence_key,
    projection_form_keys: Object.freeze([]),
    alignment_operator_id: "identity_v1" as const,
    match_strength: 1
  });
}

function objectAtom(candidateKey: string): CandidateCoverageAtom {
  return Object.freeze({
    atom_id: `object:${candidateKey}`,
    kind: "logical_object",
    strength: 1,
    independence_key: `object:${candidateKey}`,
    evidence_object_id: null,
    document_identity: null,
    projection: null,
    demand_roles: Object.freeze([]),
    observation_channels: Object.freeze([])
  });
}

function queryDemand(value: string) {
  return Object.freeze({
    id: `object_id:${value}`,
    kind: "object_id" as const,
    value,
    priority: "core" as const
  });
}
