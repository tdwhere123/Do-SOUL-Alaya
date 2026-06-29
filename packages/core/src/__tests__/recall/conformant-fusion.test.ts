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
import { applyPathSuppressionToFusionScores, buildRecallFusionDetails } from "../../recall/fusion-delivery-scoring.js";
import {
  compareConformantAxisRa,
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
  "ALAYA_RECALL_CONFORMANT", "ALAYA_RECALL_CONF_W_PATH", "ALAYA_RECALL_CONF_EVIDENCE_BETA",
  "ALAYA_RECALL_CONF_FLOOD_CAP", "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL", "ALAYA_RECALL_CONF_LAMBDA",
  "ALAYA_RECALL_CONF_GATE_FLOOR", "ALAYA_RECALL_CONF_EVIDENCE_DECAY", "ALAYA_RECALL_SYNTHESIS",
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
    graphSupportCounts: {},
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
  it("flag OFF is byte-identical, deterministic, and emits no per_axis_* keys", async () => {
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

  it("flag OFF ignores an injected inflow adjacency (flat path untouched)", async () => {
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

  it("object collapse no-multicount: 3 correlated lexical hits give pure-max R_O, not an additive sum", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    const all = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1, trigram: 1, evidence: 1 }]);
    const one = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1 }]);
    const raAll = all.get(keyOf(objectId(1)))!.per_axis_contribution!.object;
    const raOne = one.get(keyOf(objectId(1)))!.per_axis_contribution!.object;
    expect(raAll).toBeGreaterThan(0.5);
    expect(raAll).toBeLessThanOrEqual(raOne + 1e-9);
    expect(raAll).toBeLessThan(2);
  });

  it("path is compositional: a high-R_O source floods its target; a candidate with no inflow gets ~0 path", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
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
    process.env.ALAYA_RECALL_CONFORMANT = "1";
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
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    const dominant: CandidateSpec = { id: objectId(1), lexical: 1, embedding: 1 };
    // path/sourceProximity present but, absent any inflow adjacency, contribute no free vote.
    const broadWeak: CandidateSpec = { id: objectId(2), lexical: 0.2, path: 0.3, sourceProximity: 0.3 };
    const fusion = await runFusion(GENERIC_QUERY, [dominant, broadWeak]);
    expect(fusion.get(keyOf(dominant.id))!.fused_score)
      .toBeGreaterThan(fusion.get(keyOf(broadWeak.id))!.fused_score);
    expect(fusion.get(keyOf(dominant.id))!.fused_rank)
      .toBeLessThan(fusion.get(keyOf(broadWeak.id))!.fused_rank);
  });

  it("evidence is a multiplicative boost: g(0)=1 never penalizes, evidence lifts an already-active memory", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    const noEvidence = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1 }]);
    const dry = noEvidence.get(keyOf(objectId(1)))!;
    // g(0)=1: with no flood, S == activation == R_O; a memory with no evidence is not penalized.
    expect(dry.fused_score).toBeCloseTo(dry.per_axis_contribution!.object, 9);

    const withEvidence = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1, sourceProximity: 1 }]);
    const boosted = withEvidence.get(keyOf(objectId(1)))!;
    expect(boosted.per_axis_contribution!.evidence).toBeGreaterThan(0);
    expect(boosted.fused_score).toBeGreaterThan(boosted.per_axis_contribution!.object);
  });

  it("evidence cannot inject noise: a zero-activation candidate stays 0 regardless of evidence", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    const fusion = await runFusion(GENERIC_QUERY, [{ id: objectId(1), sourceProximity: 1 }]);
    const candidate = fusion.get(keyOf(objectId(1)))!;
    expect(candidate.per_axis_contribution!.object).toBe(0);
    expect(candidate.per_axis_contribution!.evidence).toBeGreaterThan(0);
    expect(candidate.fused_score).toBe(0);
  });

  it("governance caps the per-source flood without compressing the object seed", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
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

  it("governance caps the total flood across converging sources", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    process.env.ALAYA_RECALL_CONF_FLOOD_CAP = "1";
    process.env.ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL = "1.5";
    const seedA: CandidateSpec = { id: objectId(1), lexical: 1 };
    const seedB: CandidateSpec = { id: objectId(2), lexical: 1 };
    const target: CandidateSpec = { id: objectId(3), lexical: 0.1 };
    const fusion = await runFusion(GENERIC_QUERY, [seedA, seedB, target], {
      inflow: {
        [target.id]: [
          { seedObjectId: seedA.id, weight: 2 },
          { seedObjectId: seedB.id, weight: 2 }
        ]
      }
    });
    expect(fusion.get(keyOf(target.id))!.per_axis_contribution!.path).toBeCloseTo(1.5, 9);
  });

  it("temporal split: object-time lifts R_O and the now-distance recency is not consulted", async () => {
    const query = "what did we decide in 2024-03 about the rollout";
    const inWindow: CandidateSpec = {
      id: objectId(1), lexical: 0.5, eventStart: "2024-03-15T00:00:00.000Z", eventEnd: "2024-03-15T00:00:00.000Z"
    };
    const noEvent: CandidateSpec = { id: objectId(2), lexical: 0.5 };
    process.env.ALAYA_RECALL_CONFORMANT = "1";

    const fusion = await runFusion(query, [inWindow, noEvent]);
    const lift = fusion.get(keyOf(inWindow.id))!.per_axis_contribution!.object
      - fusion.get(keyOf(noEvent.id))!.per_axis_contribution!.object;
    expect(lift).toBeGreaterThan(0.5);

    const farNow = await runFusion(query, [inWindow], { nowIso: "2026-06-28T00:00:00.000Z" });
    const nearNow = await runFusion(query, [inWindow], { nowIso: "2024-03-16T00:00:00.000Z" });
    expect(nearNow.get(keyOf(inWindow.id))!.fused_score)
      .toBeCloseTo(farNow.get(keyOf(inWindow.id))!.fused_score, 12);
  });

  it("single_fact intent exempts the lexical surface from the embedding gate (γ→1)", async () => {
    const singleFactQuery = "what is the staging database password";
    expect(classifyRecallIntent(compileRecallQueryProbes(singleFactQuery))).toBe("single_fact");
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    const fusion = await runFusion(singleFactQuery, [
      { id: objectId(1), lexical: 1, embedding: 0.1 },
      { id: objectId(2), embedding: 1 }
    ]);
    expect(fusion.get(keyOf(objectId(1)))!.per_axis_contribution!.object).toBeGreaterThan(0.9);
  });

  it("conformant supersedes synthesis when both flags are on", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
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

  it("path-suppression stays a clean demote, not an annihilation, on the compositional score", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    const spec: CandidateSpec = { id: objectId(1), lexical: 1, sourceProximity: 1 };
    const fusion = await runFusion(GENERIC_QUERY, [spec]);
    const before = fusion.get(keyOf(spec.id))!.fused_score;
    expect(before).toBeGreaterThan(0.27);
    const suppressed = applyPathSuppressionToFusionScores(fusion, { [spec.id]: 0.27 });
    const after = suppressed.get(keyOf(spec.id))!.fused_score;
    expect(after).toBeCloseTo(before - 0.27, 9);
    expect(after).toBeGreaterThan(1e-4);
    expect(after).toBeLessThan(before);
  });

  it("tunables default to bounded compositional values", () => {
    expect(resolveConformantPathWeight()).toBe(0.6);
    expect(resolveConformantEvidenceBeta()).toBe(0.5);
    expect(resolveConformantFloodCapPerSource()).toBe(1);
    expect(resolveConformantFloodCapTotal()).toBe(3);
  });
});
