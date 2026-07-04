import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEntry, RecallPolicy } from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import {
  applyPathSuppressionToFusionScores,
  buildRecallFusionDetails
} from "../../recall/delivery/fusion-delivery-scoring.js";
import {
  compareConformantAxisRa,
  resolveConformantEvidenceBeta,
  resolveConformantFloodCapPerSource,
  resolveConformantFloodCapTotal,
  resolveConformantPathWeight
} from "../../recall/scoring/conformant-fusion-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { classifyRecallIntent } from "../../recall/query/recall-query-plan.js";
import { buildEvidenceSupportVectors } from "../../recall/supplements/supplementary-data.js";
import type {
  PathInflowEdge,
  RecallFusionBreakdown,
  RecallSupplementaryData
} from "../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const WS = "workspace-1";
const RUN = "run-1";
const NOW = "2026-03-20T10:20:30.000Z";

const CONFORMANT_ENV = [
  "ALAYA_RECALL_CONF_W_PATH",
  "ALAYA_RECALL_CONF_EVIDENCE_BETA", "ALAYA_RECALL_CONF_FLOOD_CAP", "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL",
  "ALAYA_RECALL_CONF_RHO_PATH", "ALAYA_RECALL_CONF_RHO_EVIDENCE",
  "ALAYA_RECALL_FACET_OVERLAP", "ALAYA_RECALL_FACET_SLICE", "ALAYA_RECALL_PATH_FLOW",
  "ALAYA_RECALL_TEMPORAL_WINDOW"
] as const;

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  for (const name of CONFORMANT_ENV) {
    delete process.env[name];
  }
});

function createRealStorage(): SqliteMemoryEntryRepo {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  new SqliteWorkspaceRepo(database).create({
    workspace_id: WS,
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  new SqliteRunRepo(database).create({
    run_id: RUN,
    workspace_id: WS,
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  return new SqliteMemoryEntryRepo(database);
}

interface CandidateSpec {
  readonly id: string;
  readonly content?: string;
  readonly embedding?: number;
  readonly structural?: number;
  readonly lexical?: number;
  readonly trigram?: number;
  readonly evidence?: number;
  readonly path?: number;
  readonly graph?: number;
  readonly graphSupport?: number;
  readonly evidenceRefs?: readonly string[];
  readonly evidenceSupports?: readonly number[];
  readonly entity?: number;
  readonly sourceProximity?: number;
  readonly facetTags?: readonly string[];
  readonly eventStart?: string;
  readonly eventEnd?: string;
  readonly effectiveScore?: number;
}

type InflowMap = Readonly<Record<string, readonly PathInflowEdge[]>>;

function objectId(index: number): string {
  return `00000000-0000-4000-8000-0000000000${index.toString(16).padStart(2, "0")}`;
}

function keyOf(id: string): string {
  return `workspace_local:memory_entry:${id}`;
}

async function seedEntries(repo: SqliteMemoryEntryRepo, specs: readonly CandidateSpec[]): Promise<Map<string, MemoryEntry>> {
  for (const spec of specs) {
    await repo.create(createMemoryEntry({
      object_id: spec.id,
      content: spec.content ?? "neutral memory content for the recall pool",
      evidence_refs: spec.evidenceRefs ?? spec.evidenceSupports?.map((_support, index) => `${spec.id}-ev-${index}`) ?? [],
      surface_id: null,
      activation_score: 0.4,
      ...(spec.facetTags !== undefined ? { facet_tags: spec.facetTags.map((facet) => ({ facet })) } : {}),
      ...(spec.eventStart !== undefined ? { event_time_start: spec.eventStart } : {}),
      ...(spec.eventEnd !== undefined ? { event_time_end: spec.eventEnd } : {})
    }) as MemoryEntry);
  }
  const stored = await repo.findByWorkspaceId(WS);
  return new Map(stored.map((entry) => [entry.object_id, entry]));
}

function buildSupplementaryData(
  query: string,
  specs: readonly CandidateSpec[],
  entries: readonly MemoryEntry[],
  inflow?: InflowMap
): RecallSupplementaryData {
  const record = (pick: (spec: CandidateSpec) => number | undefined): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const spec of specs) {
      const value = pick(spec);
      if (value !== undefined) {
        out[spec.id] = value;
      }
    }
    return out;
  };
  return {
    queryProbes: compileRecallQueryProbes(query),
    ftsRanks: record((s) => s.lexical),
    trigramFtsRanks: record((s) => s.trigram),
    synthesisFtsRanks: {},
    evidenceFtsRanks: record((s) => s.evidence),
    evidenceFtsRanksPerRef: {},
    sourceProximityScores: record((s) => s.sourceProximity),
    sourceCohortKeys: {},
    structuralScores: record((s) => s.structural),
    graphExpansionScores: record((s) => s.graph),
    entitySeedScores: record((s) => s.entity),
    pathExpansionScores: record((s) => s.path),
    pathSuppressionScores: {},
    embeddingSimilarityScores: record((s) => s.embedding),
    graphSupportCounts: record((s) => s.graphSupport),
    evidenceSupportVectorsByMemoryId: buildEvidenceSupportVectors(entries),
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {},
    ...(inflow !== undefined ? { pathInflowByTarget: inflow } : {})
  };
}

async function runFusion(
  query: string,
  specs: readonly CandidateSpec[],
  options: { readonly nowIso?: string; readonly inflow?: InflowMap } = {}
): Promise<ReadonlyMap<string, RecallFusionBreakdown>> {
  const repo = createRealStorage();
  const byId = await seedEntries(repo, specs);
  const entries = specs.map((spec) => byId.get(spec.id)!);
  return buildRecallFusionDetails({
    candidates: specs.map((spec) => ({
      entry: byId.get(spec.id)!,
      effectiveScore: spec.effectiveScore ?? 0,
      effectiveFactors: spec.embedding !== undefined
        ? { activation: 0, relevance: 0, embedding_similarity: spec.embedding }
        : { activation: 0, relevance: 0 },
      structuralScore: spec.structural ?? 0
    })),
    policy: {} as RecallPolicy,
    supplementaryData: buildSupplementaryData(query, specs, entries, options.inflow),
    nowIso: options.nowIso ?? NOW
  });
}

const GENERIC_QUERY = "how does the staging release rotate database credentials and migration tooling";

describe("conformant compositional combine (real SQLite)", () => {
  it("unified kernel is deterministic and emits all calibrated axes", async () => {
    const specs: readonly CandidateSpec[] = [
      { id: objectId(1), lexical: 1, evidence: 1, structural: 1 },
      { id: objectId(2), path: 1, sourceProximity: 1 },
      { id: objectId(3), embedding: 0.6, lexical: 0.3 }
    ];
    const first = await runFusion(GENERIC_QUERY, specs);
    const second = await runFusion(GENERIC_QUERY, specs);
    for (const spec of specs) {
      const a = first.get(keyOf(spec.id))!;
      const b = second.get(keyOf(spec.id))!;
      expect(b.fused_score).toBeCloseTo(a.fused_score, 12);
      expect(b.fused_rank).toBe(a.fused_rank);
      expect(b.per_stream_rank).toEqual(a.per_stream_rank);
      expect(b.fused_rank_contribution_per_stream).toEqual(a.fused_rank_contribution_per_stream);
      expect(a.per_axis_rank).toEqual({
        object: null,
        path: null,
        evidence: null,
        temporal: null,
        control: null
      });
      expect(Object.keys(a.per_axis_contribution ?? {}).sort()).toEqual([
        "control",
        "evidence",
        "object",
        "path",
        "temporal"
      ]);
    }
  });

  it("path inflow is part of the unified kernel", async () => {
    const specs: readonly CandidateSpec[] = [
      { id: objectId(1), lexical: 1 },
      { id: objectId(2), lexical: 0.2 }
    ];
    const without = await runFusion(GENERIC_QUERY, specs);
    const withInflow = await runFusion(GENERIC_QUERY, specs, {
      inflow: { [objectId(2)]: [{ seedObjectId: objectId(1), weight: 1 }] }
    });
    expect(withInflow.get(keyOf(objectId(2)))!.per_axis_contribution!.path).toBeGreaterThan(0);
    expect(withInflow.get(keyOf(objectId(2)))!.fused_score)
      .toBeGreaterThan(without.get(keyOf(objectId(2)))!.fused_score);
  });

  it("object base is the additive RRF sum: more matching streams raise R_O", async () => {
    const all = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1, trigram: 1, evidence: 1 }]);
    const one = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1 }]);
    const raAll = all.get(keyOf(objectId(1)))!.per_axis_contribution!.object;
    const raOne = one.get(keyOf(objectId(1)))!.per_axis_contribution!.object;
    expect(raOne).toBeGreaterThan(0);
    expect(raAll).toBeGreaterThan(raOne);
  });

  it("path is compositional: a high-base source floods its target; a candidate with no inflow gets ~0 path", async () => {
    const seed: CandidateSpec = { id: objectId(1), lexical: 1 };
    const target: CandidateSpec = { id: objectId(2) };

    const noInflow = await runFusion(GENERIC_QUERY, [seed, target]);
    const targetNoInflow = noInflow.get(keyOf(target.id))!;
    expect(targetNoInflow.per_axis_contribution!.path).toBe(0);
    expect(targetNoInflow.fused_score).toBe(0);

    const withInflow = await runFusion(GENERIC_QUERY, [seed, target], {
      inflow: { [target.id]: [{ seedObjectId: seed.id, weight: 0.8 }] }
    });
    const targetLifted = withInflow.get(keyOf(target.id))!;
    expect(targetLifted.per_axis_contribution!.path).toBeGreaterThan(0);
    expect(targetLifted.fused_score).toBeGreaterThan(targetNoInflow.fused_score);
  });

  it("path flood carries no free vote: inflow from a zero-base source lifts nothing", async () => {
    const irrelevantSeed: CandidateSpec = { id: objectId(1) };
    const target: CandidateSpec = { id: objectId(2) };
    const fusion = await runFusion(GENERIC_QUERY, [irrelevantSeed, target], {
      inflow: { [target.id]: [{ seedObjectId: irrelevantSeed.id, weight: 1 }] }
    });
    const lifted = fusion.get(keyOf(target.id))!;
    expect(lifted.per_axis_contribution!.path).toBe(0);
    expect(lifted.fused_score).toBeCloseTo(
      (await runFusion(GENERIC_QUERY, [target])).get(keyOf(target.id))!.fused_score,
      12
    );
  });

  it("a magnitude-dominant candidate outranks a broad-but-individually-weak one under additive RRF", async () => {
    const dominant: CandidateSpec = { id: objectId(1), lexical: 1, embedding: 1 };
    const broadWeak: CandidateSpec = { id: objectId(2), lexical: 0.2, path: 0.3, sourceProximity: 0.3 };
    const fusion = await runFusion(GENERIC_QUERY, [dominant, broadWeak]);
    expect(fusion.get(keyOf(dominant.id))!.fused_score)
      .toBeGreaterThan(fusion.get(keyOf(broadWeak.id))!.fused_score);
    expect(fusion.get(keyOf(dominant.id))!.fused_rank)
      .toBeLessThan(fusion.get(keyOf(broadWeak.id))!.fused_rank);
  });

  it("builds live evidence support vectors from candidate evidence_refs", async () => {
    const repo = createRealStorage();
    const candidateId = objectId(1);
    const byId = await seedEntries(repo, [
      { id: candidateId, evidenceRefs: ["ev-a", "ev-b"] }
    ]);
    const vectors = buildEvidenceSupportVectors([byId.get(candidateId)!]);

    expect(vectors[candidateId]).toEqual([
      { source_kind: "evidence_ref", source_id: "ev-a", support: 1 / 3 },
      { source_kind: "evidence_ref", source_id: "ev-b", support: 1 / 3 }
    ]);
  });

  it("evidence axis is always populated from independent support", async () => {
    const dry = (await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1 }])).get(keyOf(objectId(1)))!;
    expect(dry.per_axis_contribution!.evidence).toBe(0);
    const boosted = (await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1, evidenceSupports: [0.5, 0.5] }])).get(keyOf(objectId(1)))!;
    expect(boosted.per_axis_contribution!.evidence).toBeGreaterThan(0);
  });

  it("evidence axis is populated for a candidate with no lexical or embedding signal", async () => {
    const candidate = (await runFusion(GENERIC_QUERY, [{ id: objectId(1), evidenceSupports: [1] }])).get(keyOf(objectId(1)))!;
    expect(candidate.per_axis_contribution!.evidence).toBeGreaterThan(0);
  });

  it("governance caps the per-source flood without compressing the object seed", async () => {
    const seed: CandidateSpec = { id: objectId(1), lexical: 1 };
    const target: CandidateSpec = { id: objectId(2), lexical: 1 };
    // weight 10 makes base(seed)·weight overshoot a tight per-source cap.
    const inflow: InflowMap = { [target.id]: [{ seedObjectId: seed.id, weight: 10 }] };

    const wide = await runFusion(GENERIC_QUERY, [seed, target], { inflow });
    process.env.ALAYA_RECALL_CONF_FLOOD_CAP = "0.1";
    const capped = await runFusion(GENERIC_QUERY, [seed, target], { inflow });

    const wideTarget = wide.get(keyOf(target.id))!;
    const cappedTarget = capped.get(keyOf(target.id))!;
    // The cap bounds the flood term...
    expect(cappedTarget.per_axis_contribution!.path).toBeLessThan(wideTarget.per_axis_contribution!.path);
    expect(cappedTarget.per_axis_contribution!.path).toBeCloseTo(0.1, 9);
    // ...but never touches the object seed.
    expect(cappedTarget.per_axis_contribution!.object)
      .toBeCloseTo(wideTarget.per_axis_contribution!.object, 12);
  });

  it("path inflow folds by NOR (bounded ≤1) and cap_tot clamps the converging total", async () => {
    process.env.ALAYA_RECALL_CONF_FLOOD_CAP = "1";
    const seedA: CandidateSpec = { id: objectId(1), lexical: 1 };
    const seedB: CandidateSpec = { id: objectId(2), lexical: 1 };
    const target: CandidateSpec = { id: objectId(3), lexical: 0.1 };
    // Large weights drive each per-source flood past cap_src=1 so both saturate before the fold.
    const inflow: InflowMap = {
      [target.id]: [
        { seedObjectId: seedA.id, weight: 100 },
        { seedObjectId: seedB.id, weight: 100 }
      ]
    };
    // Two saturating sources fold by NOR to ≤1 — never the additive 2.
    const folded = await runFusion(GENERIC_QUERY, [seedA, seedB, target], { inflow });
    expect(folded.get(keyOf(target.id))!.per_axis_contribution!.path).toBeCloseTo(1, 9);

    process.env.ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL = "0.5";
    const clamped = await runFusion(GENERIC_QUERY, [seedA, seedB, target], { inflow });
    expect(clamped.get(keyOf(target.id))!.per_axis_contribution!.path).toBeCloseTo(0.5, 9);
  });

  // B2 regression lock: single_fact gold (lexical answer + its own embedding) must out-rank a purely
  // semantic co-topical neighbor in the additive RRF delivery path, even when the neighbor owns the top
  // embedding similarity. The extra lexical stream keeps gold ahead — the property that holds single_fact ≈96.9.
  it("single_fact: the lexical gold out-ranks a pure-embedding neighbor (fused_rank lock)", async () => {
    const singleFactQuery = "what is the staging database password";
    expect(classifyRecallIntent(compileRecallQueryProbes(singleFactQuery))).toBe("single_fact");
    const fusion = await runFusion(singleFactQuery, [
      { id: objectId(1), lexical: 1, embedding: 0.9 },
      { id: objectId(2), embedding: 1 }
    ]);
    const gold = fusion.get(keyOf(objectId(1)))!;
    const neighbor = fusion.get(keyOf(objectId(2)))!;
    expect(gold.fused_score).toBeGreaterThan(neighbor.fused_score);
    expect(gold.fused_rank).toBe(1);
    expect(gold.fused_rank).toBeLessThan(neighbor.fused_rank);
  });

  it("non-single_fact: the embedding co-facet lifts R_O above a surface-only sibling, absence never demotes it", async () => {
    expect(classifyRecallIntent(compileRecallQueryProbes(GENERIC_QUERY))).not.toBe("single_fact");
    const fusion = await runFusion(GENERIC_QUERY, [
      { id: objectId(1), lexical: 1 },
      { id: objectId(2), lexical: 1, embedding: 1 }
    ]);
    const surfaceOnly = fusion.get(keyOf(objectId(1)))!.per_axis_contribution!.object;
    const withEmbedding = fusion.get(keyOf(objectId(2)))!.per_axis_contribution!.object;
    expect(surfaceOnly).toBeGreaterThan(0);
    expect(withEmbedding).toBeGreaterThan(surfaceOnly);
  });

  it("R_a vector tie-break orders object before path before evidence before temporal before control", () => {
    // Object dominates: left ranks ahead despite a weaker path/evidence vector.
    expect(compareConformantAxisRa(
      { object: 1, path: 0, evidence: 0, temporal: 0, control: 0 },
      { object: 0.5, path: 1, evidence: 1, temporal: 1, control: 1 }
    )).toBeLessThan(0);
    // Equal object, path breaks the tie before evidence.
    expect(compareConformantAxisRa(
      { object: 0.5, path: 1, evidence: 0, temporal: 0, control: 0 },
      { object: 0.5, path: 0.5, evidence: 1, temporal: 1, control: 1 }
    )).toBeLessThan(0);
    expect(compareConformantAxisRa(
      { object: 0.5, path: 0.5, evidence: 0.5, temporal: 1, control: 0 },
      { object: 0.5, path: 0.5, evidence: 0.5, temporal: 0.5, control: 1 }
    )).toBeLessThan(0);
    expect(compareConformantAxisRa(undefined, { object: 1, path: 0, evidence: 0, temporal: 0, control: 0 })).toBe(0);
  });

  it("path-suppression stays a clean demote, not an annihilation, on the delivered score", async () => {
    const spec: CandidateSpec = { id: objectId(1), lexical: 1, sourceProximity: 1 };
    const fusion = await runFusion(GENERIC_QUERY, [spec]);
    const before = fusion.get(keyOf(spec.id))!.fused_score;
    expect(before).toBeGreaterThan(0);
    // partial suppression demotes proportionally (scale-agnostic: additive RRF base, not the old composite scale).
    const partial = applyPathSuppressionToFusionScores(fusion, { [spec.id]: before / 2 });
    const afterPartial = partial.get(keyOf(spec.id))!.fused_score;
    expect(afterPartial).toBeCloseTo(before / 2, 9);
    expect(afterPartial).toBeLessThan(before);
    // an over-large suppression floors, never annihilates.
    const heavy = applyPathSuppressionToFusionScores(fusion, { [spec.id]: before * 10 });
    const afterHeavy = heavy.get(keyOf(spec.id))!.fused_score;
    expect(afterHeavy).toBeGreaterThan(0);
    expect(afterHeavy).toBeLessThan(before);
  });

  it("path-suppression floor never boosts a tiny positive score", () => {
    const tiny = 0.00001;
    const fusion = new Map<string, RecallFusionBreakdown>([
      [
        "workspace_local:memory_entry:tiny",
        {
          candidate_key: "workspace_local:memory_entry:tiny",
          object_id: "tiny",
          object_kind: "memory_entry",
          origin_plane: "workspace_local",
          fused_rank: 1,
          fused_score: tiny,
          fused_rank_per_stream: {
            lexical_fts: null,
            trigram_fts: null,
            synthesis_fts: null,
            evidence_fts: null,
            evidence_structural_agreement: null,
            source_proximity: null,
            source_evidence_agreement: null,
            subject_alignment: null,
            structural: null,
            existing_score: null,
            embedding_similarity: null,
            graph_expansion: null,
            entity_seed: null,
            path_expansion: null,
            temporal_recency: null,
            workspace_activation: null,
            facet_overlap: null
          },
          fused_rank_contribution_per_stream: {
            lexical_fts: 0,
            trigram_fts: 0,
            synthesis_fts: 0,
            evidence_fts: 0,
            evidence_structural_agreement: 0,
            source_proximity: 0,
            source_evidence_agreement: 0,
            subject_alignment: 0,
            structural: 0,
            existing_score: 0,
            embedding_similarity: 0,
            graph_expansion: 0,
            entity_seed: 0,
            path_expansion: 0,
            temporal_recency: 0,
            workspace_activation: 0,
            facet_overlap: 0
          }
        }
      ]
    ]);

    const suppressed = applyPathSuppressionToFusionScores(fusion, { tiny: 1 });
    expect(suppressed.get("workspace_local:memory_entry:tiny")?.fused_score).toBe(tiny);
  });

  it("unified assembly is the production algorithm", async () => {
    const fusion = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1, path: 1, sourceProximity: 1 }]);
    expect(fusion.get(keyOf(objectId(1)))!.per_axis_contribution).toEqual(
      expect.objectContaining({ object: expect.any(Number), path: expect.any(Number), evidence: expect.any(Number) })
    );
  });

  it("tunables default to bounded compositional values", () => {
    expect(resolveConformantPathWeight()).toBe(0.6);
    expect(resolveConformantEvidenceBeta()).toBe(0);
    expect(resolveConformantFloodCapPerSource()).toBe(1);
    expect(resolveConformantFloodCapTotal()).toBe(3);
  });

  it("cold-start fused score equals R_obj without path or evidence fuel", async () => {
    const candidate = (await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1 }])).get(keyOf(objectId(1)))!;
    expect(candidate.flood_potential?.fuel_verified).toBe(false);
    expect(candidate.flood_potential?.Flood).toBe(0);
    expect(candidate.fused_score).toBeCloseTo(candidate.per_axis_contribution!.object, 12);
  });

  it("unified delivery includes temporal and control axes even when path is zero", async () => {
    const specs: readonly CandidateSpec[] = [
      { id: objectId(1), lexical: 1, evidence: 1, embedding: 0.7 },
      { id: objectId(2), lexical: 0.4, trigram: 0.6 },
      { id: objectId(3), embedding: 0.9, structural: 0.5 }
    ];
    const unified = await runFusion(GENERIC_QUERY, specs);
    for (const spec of specs) {
      const contribution = unified.get(keyOf(spec.id))!.per_axis_contribution!;
      expect(contribution.temporal).toBeGreaterThanOrEqual(0);
      expect(contribution.control).toBeGreaterThan(0);
    }
  });

  it("integrated flood score matches omega * (R_obj + lambda * Flood) with beta disabled", async () => {
    const spec: CandidateSpec = { id: objectId(1), lexical: 1, evidenceSupports: [0.5, 0.5] };
    const candidate = (await runFusion(GENERIC_QUERY, [spec])).get(keyOf(spec.id))!;
    const axes = candidate.per_axis_contribution!;
    const flood = candidate.flood_potential!;
    expect(flood.R_obj).toBeCloseTo(axes.object, 12);
    expect(flood.beta).toBe(0);
    expect(flood.e_direct_status).toBe("inactive:beta_disabled");
    expect(flood.fuel_verified).toBe(true);
    const expected = flood.omega * (flood.R_obj + flood.lambda * flood.Flood);
    expect(candidate.fused_score).toBeCloseTo(expected, 9);
    expect(flood.final_score).toBeCloseTo(expected, 9);
  });
});
