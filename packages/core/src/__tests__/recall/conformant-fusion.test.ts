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
  buildRecallFusionDetails,
  flatBaselineEnabled,
  fourAxisAssemblyEnabled
} from "../../recall/fusion-delivery-scoring.js";
import {
  compareConformantAxisRa,
  resolveConformantCEmb,
  resolveConformantCSurf,
  resolveConformantEvidenceBeta,
  resolveConformantFloodCapPerSource,
  resolveConformantFloodCapTotal,
  resolveConformantPathWeight
} from "../../recall/conformant-fusion-scoring.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import { classifyRecallIntent } from "../../recall/recall-query-plan.js";
import type {
  PathInflowEdge,
  RecallFusionBreakdown,
  RecallSupplementaryData
} from "../../recall/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const WS = "workspace-1";
const RUN = "run-1";
const NOW = "2026-03-20T10:20:30.000Z";

const CONFORMANT_ENV = [
  "ALAYA_RECALL_FLAT_BASELINE", "ALAYA_RECALL_CONF_W_PATH", "ALAYA_RECALL_CONF_EVIDENCE_BETA",
  "ALAYA_RECALL_CONF_FLOOD_CAP", "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL", "ALAYA_RECALL_CONF_RHO_LEX",
  "ALAYA_RECALL_CONF_RHO_SUB", "ALAYA_RECALL_CONF_RHO_PATH", "ALAYA_RECALL_CONF_RHO_EVIDENCE",
  "ALAYA_RECALL_CONF_ECHO", "ALAYA_RECALL_CONF_STALE", "ALAYA_RECALL_CONF_C_SURF",
  "ALAYA_RECALL_CONF_C_EMB", "ALAYA_RECALL_SYNTHESIS",
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
    supplementaryData: buildSupplementaryData(query, specs, options.inflow),
    nowIso: options.nowIso ?? NOW
  });
}

const GENERIC_QUERY = "how does the staging release rotate database credentials and migration tooling";

describe("conformant compositional combine (real SQLite)", () => {
  it("flat-baseline kill-switch is byte-identical, deterministic, and emits no per_axis_* keys", async () => {
    process.env.ALAYA_RECALL_FLAT_BASELINE = "1";
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
      expect(a.per_axis_rank).toBeUndefined();
      expect(a.per_axis_contribution).toBeUndefined();
    }
  });

  it("flat-baseline kill-switch ignores an injected inflow adjacency (flat path untouched)", async () => {
    process.env.ALAYA_RECALL_FLAT_BASELINE = "1";
    const specs: readonly CandidateSpec[] = [
      { id: objectId(1), lexical: 1 },
      { id: objectId(2), lexical: 0.2 }
    ];
    const without = await runFusion(GENERIC_QUERY, specs);
    const withInflow = await runFusion(GENERIC_QUERY, specs, {
      inflow: { [objectId(2)]: [{ seedObjectId: objectId(1), weight: 1 }] }
    });
    for (const spec of specs) {
      expect(withInflow.get(keyOf(spec.id))!.fused_score)
        .toBeCloseTo(without.get(keyOf(spec.id))!.fused_score, 12);
    }
  });

  it("object collapse no-multicount: correlated lexical views fold by NOR_ρ, bounded, never an additive sum", async () => {
    const all = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1, trigram: 1, evidence: 1 }]);
    const one = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1 }]);
    const raAll = all.get(keyOf(objectId(1)))!.per_axis_contribution!.object;
    const raOne = one.get(keyOf(objectId(1)))!.per_axis_contribution!.object;
    expect(raAll).toBeGreaterThan(0.5);
    // Redundant correlated views never exceed one clean primary hit, and R_O stays bounded in [0,1].
    expect(raAll).toBeLessThanOrEqual(raOne + 1e-9);
    expect(raAll).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("path is compositional: a high-R_O source floods its target; a candidate with no inflow gets ~0 path", async () => {
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

  it("path flood carries no free vote: inflow from a zero-R_O source lifts nothing", async () => {
    const irrelevantSeed: CandidateSpec = { id: objectId(1) };
    const target: CandidateSpec = { id: objectId(2) };
    const fusion = await runFusion(GENERIC_QUERY, [irrelevantSeed, target], {
      inflow: { [target.id]: [{ seedObjectId: irrelevantSeed.id, weight: 1 }] }
    });
    const lifted = fusion.get(keyOf(target.id))!;
    expect(lifted.per_axis_contribution!.path).toBe(0);
    expect(lifted.fused_score).toBe(0);
  });

  it("a broad-but-weak multi-axis candidate no longer out-votes a magnitude-dominant one (no independent axis votes)", async () => {
    const dominant: CandidateSpec = { id: objectId(1), lexical: 1, embedding: 1 };
    // path/sourceProximity present but, absent any inflow adjacency, contribute no free vote.
    const broadWeak: CandidateSpec = { id: objectId(2), lexical: 0.2, path: 0.3, sourceProximity: 0.3 };
    const fusion = await runFusion(GENERIC_QUERY, [dominant, broadWeak]);
    expect(fusion.get(keyOf(dominant.id))!.fused_score)
      .toBeGreaterThan(fusion.get(keyOf(broadWeak.id))!.fused_score);
    expect(fusion.get(keyOf(dominant.id))!.fused_rank)
      .toBeLessThan(fusion.get(keyOf(broadWeak.id))!.fused_rank);
  });

  // compose-on-flat (2026-06-29): the noisy-OR object axis catastrophically regressed ranking (any@5
  // 86.7→37.8), so the delivered score reverted to the additive RRF base + path flood. The evidence
  // axis (R_E) is still computed for diagnostics (per_axis_contribution) but DEFERRED from the delivered
  // score — the multiplicative g(R_E) deferral is unit-tested in conformant-axis-math.test.ts. Here we
  // only assert the axis is still wired/computed (a graph-support confound also moves the RRF base, so an
  // integration-level deferral assertion is not clean).
  it("evidence axis R_E is computed: 0 without graph support, >0 with", async () => {
    const dry = (await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1 }])).get(keyOf(objectId(1)))!;
    expect(dry.per_axis_contribution!.evidence).toBe(0);
    const boosted = (await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1, graphSupport: 3 }])).get(keyOf(objectId(1)))!;
    expect(boosted.per_axis_contribution!.evidence).toBeGreaterThan(0);
  });

  it("evidence axis is computed even with a zero object base (R_O=0, R_E>0)", async () => {
    const candidate = (await runFusion(GENERIC_QUERY, [{ id: objectId(1), graphSupport: 3 }])).get(keyOf(objectId(1)))!;
    expect(candidate.per_axis_contribution!.object).toBe(0);
    expect(candidate.per_axis_contribution!.evidence).toBeGreaterThan(0);
  });

  it("governance caps the per-source flood without compressing the object seed", async () => {
    const seed: CandidateSpec = { id: objectId(1), lexical: 1 };
    const target: CandidateSpec = { id: objectId(2), lexical: 1 };
    // weight 10 makes R_O(seed)·weight overshoot any sane per-source cap.
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
    const inflow: InflowMap = {
      [target.id]: [
        { seedObjectId: seedA.id, weight: 2 },
        { seedObjectId: seedB.id, weight: 2 }
      ]
    };
    // Two saturating sources fold by NOR to ≤1 — never the additive 2.
    const folded = await runFusion(GENERIC_QUERY, [seedA, seedB, target], { inflow });
    expect(folded.get(keyOf(target.id))!.per_axis_contribution!.path).toBeCloseTo(1, 9);

    process.env.ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL = "0.5";
    const clamped = await runFusion(GENERIC_QUERY, [seedA, seedB, target], { inflow });
    expect(clamped.get(keyOf(target.id))!.per_axis_contribution!.path).toBeCloseTo(0.5, 9);
  });

  it("temporal split: object-time lifts R_O and the now-distance recency is not consulted", async () => {
    const query = "what did we decide in 2024-03 about the rollout";
    const inWindow: CandidateSpec = {
      id: objectId(1), lexical: 0.5, eventStart: "2024-03-15T00:00:00.000Z", eventEnd: "2024-03-15T00:00:00.000Z"
    };
    const noEvent: CandidateSpec = { id: objectId(2), lexical: 0.5 };
    // A stronger lexical sibling keeps the in-window R_lex below saturation so the time facet is observable.
    const lexAnchor: CandidateSpec = { id: objectId(3), lexical: 1 };

    const fusion = await runFusion(query, [inWindow, noEvent, lexAnchor]);
    const lift = fusion.get(keyOf(inWindow.id))!.per_axis_contribution!.object
      - fusion.get(keyOf(noEvent.id))!.per_axis_contribution!.object;
    expect(lift).toBeGreaterThan(0);

    const farNow = await runFusion(query, [inWindow], { nowIso: "2026-06-28T00:00:00.000Z" });
    const nearNow = await runFusion(query, [inWindow], { nowIso: "2024-03-16T00:00:00.000Z" });
    expect(nearNow.get(keyOf(inWindow.id))!.fused_score)
      .toBeCloseTo(farNow.get(keyOf(inWindow.id))!.fused_score, 12);
  });

  it("single_fact: c_emb=0 keeps lexical truth dominant — an embedding-only candidate is never lifted", async () => {
    const singleFactQuery = "what is the staging database password";
    expect(classifyRecallIntent(compileRecallQueryProbes(singleFactQuery))).toBe("single_fact");
    // Lexical hit with a weak embedding vs a no-lexical candidate with a strong one; single_fact zeroes the embedding facet.
    const fusion = await runFusion(singleFactQuery, [
      { id: objectId(1), lexical: 1, embedding: 0.1 },
      { id: objectId(2), embedding: 1 }
    ]);
    expect(fusion.get(keyOf(objectId(1)))!.per_axis_contribution!.object)
      .toBeGreaterThan(fusion.get(keyOf(objectId(2)))!.per_axis_contribution!.object);
    expect(fusion.get(keyOf(objectId(2)))!.per_axis_contribution!.object).toBe(0);
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

  it("four-axis default supersedes synthesis even when the synthesis flag is on", async () => {
    process.env.ALAYA_RECALL_SYNTHESIS = "1";
    const fusion = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1, path: 1, sourceProximity: 1 }]);
    expect(fusion.get(keyOf(objectId(1)))!.per_axis_contribution).toBeDefined();
  });

  it("R_a vector tie-break orders object before path before evidence", () => {
    // Object dominates: left ranks ahead despite a weaker path/evidence vector.
    expect(compareConformantAxisRa(
      { object: 1, path: 0, evidence: 0 },
      { object: 0.5, path: 1, evidence: 1 }
    )).toBeLessThan(0);
    // Equal object, path breaks the tie before evidence.
    expect(compareConformantAxisRa(
      { object: 0.5, path: 1, evidence: 0 },
      { object: 0.5, path: 0.5, evidence: 1 }
    )).toBeLessThan(0);
    // Absent vectors (flag-off) never reorder.
    expect(compareConformantAxisRa(undefined, { object: 1, path: 0, evidence: 0 })).toBe(0);
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

  it("four-axis assembly is the production default and the flat-baseline kill-switch flips it", () => {
    expect(fourAxisAssemblyEnabled()).toBe(true);
    expect(flatBaselineEnabled()).toBe(false);
    process.env.ALAYA_RECALL_FLAT_BASELINE = "1";
    expect(fourAxisAssemblyEnabled()).toBe(false);
    expect(flatBaselineEnabled()).toBe(true);
  });

  it("tunables default to bounded compositional values", () => {
    expect(resolveConformantPathWeight()).toBe(0.6);
    expect(resolveConformantEvidenceBeta()).toBe(0.5);
    expect(resolveConformantFloodCapPerSource()).toBe(1);
    expect(resolveConformantFloodCapTotal()).toBe(3);
    expect(resolveConformantCSurf()).toBe(0.9);
    expect(resolveConformantCEmb()).toBe(0.7);
  });
});
