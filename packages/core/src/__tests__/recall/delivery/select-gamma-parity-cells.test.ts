import { SELECT_GAMMA_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import {
  type CoverageSelectableCandidate,
  type CoverageSelectionCandidateState,
  type CoverageSelectionSupplementary
} from "../../../recall/delivery/coverage-selection.js";
import type { CandidateCoverageAtom } from
  "../../../recall/delivery/fine-assessment-selection/coverage-atoms.js";
import {
  firstSelectGammaExclusionReason,
  type SelectGammaFirstExclusionReason
} from "../../../recall/delivery/select-gamma/first-exclusion.js";
import { selectGammaWalk } from
  "../../../recall/delivery/select-gamma/select-gamma.js";
import type {
  SelectGammaBinding,
  SelectGammaFormulaCandidate,
  SelectGammaRequest,
  SelectGammaWalkObjective
} from "../../../recall/delivery/select-gamma/types.js";
import {
  bindCoverageSelectionWalkObjective,
  createSelectGammaGenericWalkObjective,
  selectGammaObjectiveDigest
} from "../../../recall/delivery/select-gamma/walk-objective.js";
import {
  ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID,
  createAttributedFacilityCoverageObjective
} from "../../../recall/field/facility-objective.js";
import { materializeAttributedQueryFacilityDemand } from
  "../../../recall/field/query-facility-demand.js";

const GOLDS = Object.freeze(["gold-apple", "gold-banana", "gold-orange"]);
const SHARED_SOURCE = "grocery-receipt";
const OTHER_SOURCE = "market-note";
const DISTRACTOR_SOURCE = "blog";

describe("Select_Gamma selector parity cells", () => {
  it("matches live walk keys and decision order on the generic proof path", () => {
    const pool = frozenPool();
    for (const sourceHardDedupe of [true, false] as const) {
      const binding = withDedupe(pool.binding, sourceHardDedupe);
      const live = selectGammaWalk(pool.request, binding);
      const proof = selectGammaWalk(
        pool.request,
        binding,
        createSelectGammaGenericWalkObjective(binding)
      );
      expect(proof.selected_candidate_keys).toEqual(live.selected_candidate_keys);
      expect(proof.decisions.map(decisionKeys)).toEqual(
        live.decisions.map(decisionKeys)
      );
    }
  });

  it("emits four-cell first-exclusion receipts on one frozen pool", () => {
    const pool = frozenPool();
    const generic = createSelectGammaGenericWalkObjective(pool.binding);
    const facility = facilityWalkObjective(pool);
    const cells = Object.freeze({
      generic_dedupe_on: runCell(pool, generic, true),
      generic_dedupe_off: runCell(pool, generic, false),
      facility_dedupe_on: runCell(pool, facility, true),
      facility_dedupe_off: runCell(pool, facility, false)
    });

    expect(cells.generic_dedupe_on).toEqual(cell(
      ["gold-apple", "distractor-high", "gold-orange"],
      {
        operator_id: SELECT_GAMMA_OPERATOR_ID,
        configuration_digest: null
      },
      {
        "gold-apple": null,
        "gold-banana": "duplicate_source",
        "gold-orange": null
      }
    ));
    expect(cells.generic_dedupe_off).toEqual(cell(
      ["gold-apple", "gold-banana", "distractor-high"],
      {
        operator_id: SELECT_GAMMA_OPERATOR_ID,
        configuration_digest: null
      },
      {
        "gold-apple": null,
        "gold-banana": null,
        "gold-orange": "entry_budget"
      }
    ));
    expect(cells.facility_dedupe_on.objective.operator_id)
      .toBe(ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID);
    expect(cells.facility_dedupe_on.objective.configuration_digest)
      .toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(cells.facility_dedupe_on.selected_keys).toEqual([
      "gold-apple", "gold-orange", "distractor-high"
    ]);
    expect(cells.facility_dedupe_on.order).toEqual(
      cells.facility_dedupe_on.selected_keys
    );
    expect(cells.facility_dedupe_on.gold_first_exclusion).toEqual({
      "gold-apple": null,
      "gold-banana": "duplicate_source",
      "gold-orange": null
    });
    expect(cells.facility_dedupe_off.selected_keys).toEqual([
      "gold-apple", "gold-orange", "gold-banana"
    ]);
    expect(cells.facility_dedupe_off.order).toEqual(
      cells.facility_dedupe_off.selected_keys
    );
    expect(cells.facility_dedupe_off.gold_first_exclusion).toEqual({
      "gold-apple": null,
      "gold-banana": null,
      "gold-orange": null
    });
    expect(cells.facility_dedupe_on.objective).toEqual(
      cells.facility_dedupe_off.objective
    );
  });

  it("classifies unconstrained displacement as coverage versus quality", () => {
    const candidates = Object.freeze([
      formulaCandidate("cover-winner", {
        quality: 0.2,
        cover: { slice: 1 },
        source: "s-a"
      }),
      formulaCandidate("high-quality", {
        quality: 0.9,
        cover: {},
        source: "s-b"
      }),
      formulaCandidate("low-quality", {
        quality: 0.1,
        cover: {},
        source: "s-c"
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
    const binding: SelectGammaBinding = Object.freeze({
      workspace_id: request.workspace_id,
      generation_id: request.generation_id,
      condition_digest: request.condition_digest,
      candidates,
      feature_weights: Object.freeze({ slice: 1 }),
      max_selected: 1,
      per_dimension_limits: null,
      source_hard_dedupe: false
    });
    const objective = createSelectGammaGenericWalkObjective(binding);
    const walk = selectGammaWalk(request, binding, objective);
    const winner = walk.selected_candidate_keys[0]!;
    const unconstrained = Object.freeze({
      ...walk,
      decisions: Object.freeze(walk.decisions.filter((decision) =>
        decision.candidate_key === winner)),
      selected_candidate_keys: Object.freeze([winner])
    });

    expect(winner).toBe("cover-winner");
    expect(firstSelectGammaExclusionReason("high-quality", unconstrained, {
      candidates,
      objective
    })).toBe("coverage_displaced");
    expect(firstSelectGammaExclusionReason("low-quality", unconstrained, {
      candidates,
      objective
    })).toBe("quality_displaced");
  });
});

function runCell(
  pool: FrozenPool,
  objective: SelectGammaWalkObjective,
  sourceHardDedupe: boolean
) {
  const binding = withDedupe(pool.binding, sourceHardDedupe);
  const walk = selectGammaWalk(pool.request, binding, objective);
  return cell(
    [...walk.selected_candidate_keys],
    selectGammaObjectiveDigest(objective),
    Object.fromEntries(GOLDS.map((gold) => [
      gold,
      firstSelectGammaExclusionReason(gold, walk, {
        candidates: pool.binding.candidates,
        objective
      })
    ])) as Record<(typeof GOLDS)[number], SelectGammaFirstExclusionReason | null>
  );
}

function cell(
  selectedKeys: readonly string[],
  objective: Readonly<{
    readonly operator_id: string;
    readonly configuration_digest: string | null;
  }>,
  goldFirstExclusion: Readonly<Record<
    (typeof GOLDS)[number],
    SelectGammaFirstExclusionReason | null
  >>
) {
  return {
    selected_keys: selectedKeys,
    order: selectedKeys,
    objective,
    gold_first_exclusion: goldFirstExclusion
  };
}

function decisionKeys(decision: Readonly<{
  readonly candidate_key: string;
  readonly selection_order: number;
  readonly selected_rank: number | null;
  readonly receipt: { readonly kind: string };
}>) {
  return Object.freeze({
    candidate_key: decision.candidate_key,
    selection_order: decision.selection_order,
    selected_rank: decision.selected_rank,
    receipt_kind: decision.receipt.kind
  });
}

function withDedupe(
  binding: SelectGammaBinding,
  sourceHardDedupe: boolean
): SelectGammaBinding {
  return Object.freeze({
    ...binding,
    source_hard_dedupe: sourceHardDedupe
  });
}

type FrozenPool = Readonly<{
  readonly request: SelectGammaRequest;
  readonly binding: SelectGammaBinding;
}>;

function frozenPool(): FrozenPool {
  const candidates = Object.freeze([
    formulaCandidate("gold-apple", {
      quality: 0.8,
      cover: { slice: 1 },
      source: SHARED_SOURCE
    }),
    formulaCandidate("gold-banana", {
      quality: 0.7,
      cover: { f3: 1 },
      source: SHARED_SOURCE
    }),
    formulaCandidate("gold-orange", {
      quality: 0.6,
      cover: { slice: 1 },
      source: OTHER_SOURCE
    }),
    formulaCandidate("distractor-high", {
      quality: 0.65,
      cover: {},
      source: DISTRACTOR_SOURCE
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

function facilityWalkObjective(
  pool: FrozenPool
): SelectGammaWalkObjective {
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
        ["gold-apple", [objectMatch(byKey.get("gold-apple")!, fruit)]],
        ["gold-banana", [objectMatch(byKey.get("gold-banana")!, fruit)]],
        ["gold-orange", [objectMatch(byKey.get("gold-orange")!, other)]]
      ])
    }),
    candidateStates: states,
    supplementaryData
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

function formulaCandidate(
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
