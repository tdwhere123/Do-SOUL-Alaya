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
  applyConformantGovernance,
  resolveConformantAxisK,
  resolveConformantCrossAxis,
  resolveConformantFloodScale
} from "../../recall/conformant-fusion-scoring.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import { classifyRecallIntent } from "../../recall/recall-query-plan.js";
import type { RecallFusionBreakdown, RecallSupplementaryData } from "../../recall/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const WS = "workspace-1";
const RUN = "run-1";
const NOW = "2026-03-20T10:20:30.000Z";

const CONFORMANT_ENV = [
  "ALAYA_RECALL_CONFORMANT", "ALAYA_RECALL_CONF_K", "ALAYA_RECALL_CONF_K_OBJECT",
  "ALAYA_RECALL_CONF_K_PATH", "ALAYA_RECALL_CONF_K_EVIDENCE", "ALAYA_RECALL_CONF_W_OBJECT",
  "ALAYA_RECALL_CONF_W_PATH", "ALAYA_RECALL_CONF_W_EVIDENCE", "ALAYA_RECALL_CONF_LAMBDA",
  "ALAYA_RECALL_CONF_GATE_FLOOR", "ALAYA_RECALL_CONF_GOV_FLOOR", "ALAYA_RECALL_CONF_GOV_RATIO",
  "ALAYA_RECALL_CONF_SCALE", "ALAYA_RECALL_CONF_EVIDENCE_DECAY", "ALAYA_RECALL_SYNTHESIS",
  "ALAYA_RECALL_FACET_OVERLAP", "ALAYA_RECALL_FACET_SLICE", "ALAYA_RECALL_PATH_FLOW",
  "ALAYA_RECALL_TEMPORAL_WINDOW", "ALAYA_RECALL_CONF_XAXIS", "ALAYA_RECALL_CONF_FLOOD_SCALE"
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

function buildSupplementaryData(query: string, specs: readonly CandidateSpec[]): RecallSupplementaryData {
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
    governanceCeilingByMemoryId: {}
  };
}

async function runFusion(
  query: string,
  specs: readonly CandidateSpec[],
  nowIso: string = NOW
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
    supplementaryData: buildSupplementaryData(query, specs),
    nowIso
  });
}

const GENERIC_QUERY = "how does the staging release rotate database credentials and migration tooling";

describe("conformant four-axis combine (real SQLite)", () => {
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

  it("rrf orthogonal lift: a path+evidence candidate overtakes a lexical-only winner, causally", async () => {
    const lexicalOnly: CandidateSpec = { id: objectId(1), lexical: 1, evidence: 1, structural: 1 };
    const orthogonal: CandidateSpec = { id: objectId(2), path: 1, sourceProximity: 1 };

    const baseline = await runFusion(GENERIC_QUERY, [lexicalOnly, orthogonal]);
    expect(baseline.get(keyOf(lexicalOnly.id))!.fused_rank)
      .toBeLessThan(baseline.get(keyOf(orthogonal.id))!.fused_rank);

    process.env.ALAYA_RECALL_CONFORMANT = "1";
    process.env.ALAYA_RECALL_CONF_XAXIS = "rrf";
    const lifted = await runFusion(GENERIC_QUERY, [lexicalOnly, orthogonal]);
    expect(lifted.get(keyOf(orthogonal.id))!.fused_rank)
      .toBeLessThan(lifted.get(keyOf(lexicalOnly.id))!.fused_rank);

    // Causal: removing EITHER orthogonal axis returns the lexical-only winner to the top.
    const pathOnly = await runFusion(GENERIC_QUERY, [lexicalOnly, { ...orthogonal, sourceProximity: undefined }]);
    expect(pathOnly.get(keyOf(lexicalOnly.id))!.fused_rank)
      .toBeLessThan(pathOnly.get(keyOf(orthogonal.id))!.fused_rank);
    const evidenceOnly = await runFusion(GENERIC_QUERY, [lexicalOnly, { ...orthogonal, path: undefined }]);
    expect(evidenceOnly.get(keyOf(lexicalOnly.id))!.fused_rank)
      .toBeLessThan(evidenceOnly.get(keyOf(orthogonal.id))!.fused_rank);
  });

  it("collapse no-multicount: 3 correlated lexical hits give pure-max R_O, not an additive sum", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    const all = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1, trigram: 1, evidence: 1 }]);
    const one = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1 }]);
    const raAll = all.get(keyOf(objectId(1)))!.per_axis_contribution!.object;
    const raOne = one.get(keyOf(objectId(1)))!.per_axis_contribution!.object;
    expect(raAll).toBeGreaterThan(0.5);
    // Pure max (λ=0): three unit hits never exceed a single view; additive would be ~2.5x.
    expect(raAll).toBeLessThanOrEqual(raOne + 1e-9);
    expect(raAll).toBeLessThan(2);
  });

  it("rrf per-axis rank differs from any single per-stream rank", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    process.env.ALAYA_RECALL_CONF_XAXIS = "rrf";
    // A wins lexical_fts; B loses lexical_fts but wins R_O via an orthogonal embedding signal.
    const fusion = await runFusion(GENERIC_QUERY, [
      { id: objectId(1), lexical: 1 },
      { id: objectId(2), lexical: 0.5, embedding: 0.9 }
    ]);
    const a = fusion.get(keyOf(objectId(1)))!;
    const b = fusion.get(keyOf(objectId(2)))!;
    expect(a.per_stream_rank.lexical_fts).toBe(1);
    expect(b.per_stream_rank.lexical_fts).toBe(2);
    expect(b.per_axis_rank!.object).toBe(1);
    expect(a.per_axis_rank!.object).toBe(2);
  });

  it("governance binds the Object vote by default (floor 0 / ratio 1) with no extra flag", () => {
    // No orthogonal evidence ⇒ object intact (early return).
    expect(applyConformantGovernance(0.5, 0)).toBeCloseTo(0.5, 12);
    // With orthogonal evidence ⇒ object vote capped at floor + ratio·orthogonal = orthogonal.
    expect(applyConformantGovernance(0.5, 0.1)).toBeCloseTo(0.1, 12);
    expect(applyConformantGovernance(0.05, 0.1)).toBeCloseTo(0.05, 12);
  });

  it("k defaults to 20 (not the per-stream 45-90) and a lower k widens the orthogonal rank gap", async () => {
    expect(resolveConformantAxisK("object")).toBe(20);
    expect(resolveConformantAxisK("path")).toBe(20);
    expect(resolveConformantAxisK("evidence")).toBe(20);

    const specs: readonly CandidateSpec[] = [
      { id: objectId(1), path: 1 },
      { id: objectId(2), path: 0.3 }
    ];
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    process.env.ALAYA_RECALL_CONF_XAXIS = "rrf";
    const atK20 = await runFusion(GENERIC_QUERY, specs);
    const gap20 = atK20.get(keyOf(objectId(1)))!.fused_score / atK20.get(keyOf(objectId(2)))!.fused_score;
    process.env.ALAYA_RECALL_CONF_K = "60";
    const atK60 = await runFusion(GENERIC_QUERY, specs);
    const gap60 = atK60.get(keyOf(objectId(1)))!.fused_score / atK60.get(keyOf(objectId(2)))!.fused_score;
    expect(gap20).toBeGreaterThan(gap60);
  });

  it("ties break on the R_a magnitude vector before effectiveScore", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    // M is sole on Path, N sole on Evidence; W_P=W_E ⇒ identical S. N carries a higher effectiveScore.
    const fusion = await runFusion(GENERIC_QUERY, [
      { id: objectId(1), path: 1, effectiveScore: 0 },
      { id: objectId(2), sourceProximity: 1, effectiveScore: 1 }
    ]);
    const m = fusion.get(keyOf(objectId(1)))!;
    const n = fusion.get(keyOf(objectId(2)))!;
    expect(n.fused_score).toBeCloseTo(m.fused_score, 12);
    // Path precedes Evidence in the R_a vector, so M ranks first despite N's higher effectiveScore.
    expect(m.fused_rank).toBeLessThan(n.fused_rank);
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

    // now-invariance: distance-to-now would change recency, but conformant never reads it.
    const farNow = await runFusion(query, [inWindow], "2026-06-28T00:00:00.000Z");
    const nearNow = await runFusion(query, [inWindow], "2024-03-16T00:00:00.000Z");
    expect(nearNow.get(keyOf(inWindow.id))!.fused_score)
      .toBeCloseTo(farNow.get(keyOf(inWindow.id))!.fused_score, 12);
  });

  it("single_fact intent exempts the lexical surface from the embedding gate (γ→1)", async () => {
    const singleFactQuery = "what is the staging database password";
    expect(classifyRecallIntent(compileRecallQueryProbes(singleFactQuery))).toBe("single_fact");
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    // Gold has strong surface but low embedding; a sibling pins a high embedding pool max.
    const fusion = await runFusion(singleFactQuery, [
      { id: objectId(1), lexical: 1, embedding: 0.1 },
      { id: objectId(2), embedding: 1 }
    ]);
    // γ→1 means the lexical surface is not damped by the low pool-relative cosine: R_O ≈ full surface.
    expect(fusion.get(keyOf(objectId(1)))!.per_axis_contribution!.object).toBeGreaterThan(0.9);
  });

  it("conformant supersedes synthesis when both flags are on", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    process.env.ALAYA_RECALL_SYNTHESIS = "1";
    const fusion = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1, path: 1, sourceProximity: 1 }]);
    const breakdown = fusion.get(keyOf(objectId(1)))!;
    expect(breakdown.per_axis_contribution).toBeDefined();
  });

  it("K_SCALE keeps a 0.27 path-suppression delta meaningful (demote, not annihilate)", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    const fusion = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1, path: 1, sourceProximity: 1 }]);
    const score = fusion.get(keyOf(objectId(1)))!.fused_score;
    // The scaled score sits well above the 0.27 absolute suppression delta and its 1e-4 residual floor.
    expect(score).toBeGreaterThan(0.27);
  });

  it("rrf normalization edges: single candidate yields a finite S; an empty-pool stream casts no vote", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    process.env.ALAYA_RECALL_CONF_XAXIS = "rrf";
    const single = await runFusion(GENERIC_QUERY, [{ id: objectId(1), lexical: 1 }]);
    const only = single.get(keyOf(objectId(1)))!;
    expect(Number.isFinite(only.fused_score)).toBe(true);
    expect(only.fused_score).toBeGreaterThan(0);
    expect(only.per_axis_rank!.object).toBe(1);
    // path/evidence streams are empty ⇒ no vote, no NaN.
    expect(only.per_axis_rank!.path).toBeNull();
    expect(only.per_axis_contribution!.path).toBe(0);
  });

  // The exact failure rrf+cap had: a magnitude-dominant single-axis candidate crushed below a broad-but-weak one.
  const DOMINANT: CandidateSpec = { id: objectId(1), lexical: 1, embedding: 1 };
  const BROAD_WEAK: CandidateSpec = { id: objectId(2), lexical: 0.2, path: 0.3, sourceProximity: 0.3 };

  it("flood (default) ranks a magnitude-dominant single-axis candidate above a broad-but-weak multi-axis one", async () => {
    expect(resolveConformantCrossAxis()).toBe("flood");
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    const fusion = await runFusion(GENERIC_QUERY, [DOMINANT, BROAD_WEAK]);
    const dominant = fusion.get(keyOf(DOMINANT.id))!;
    const broad = fusion.get(keyOf(BROAD_WEAK.id))!;
    expect(dominant.fused_score).toBeGreaterThan(broad.fused_score);
    expect(dominant.fused_rank).toBeLessThan(broad.fused_rank);
    // flood casts no per-axis rank.
    expect(dominant.per_axis_rank!.object).toBeNull();
  });

  it("flood and rrf disagree on the same pool: flood favours magnitude, rrf+cap favours breadth", async () => {
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    process.env.ALAYA_RECALL_CONF_XAXIS = "flood";
    const flood = await runFusion(GENERIC_QUERY, [DOMINANT, BROAD_WEAK]);
    expect(flood.get(keyOf(DOMINANT.id))!.fused_rank)
      .toBeLessThan(flood.get(keyOf(BROAD_WEAK.id))!.fused_rank);

    process.env.ALAYA_RECALL_CONF_XAXIS = "rrf";
    const rrf = await runFusion(GENERIC_QUERY, [DOMINANT, BROAD_WEAK]);
    expect(rrf.get(keyOf(BROAD_WEAK.id))!.fused_rank)
      .toBeLessThan(rrf.get(keyOf(DOMINANT.id))!.fused_rank);
  });

  it("flag OFF is unaffected by the cross-axis selector (parity holds, no per_axis keys)", async () => {
    process.env.ALAYA_RECALL_CONF_XAXIS = "flood";
    const a = await runFusion(GENERIC_QUERY, [DOMINANT, BROAD_WEAK]);
    process.env.ALAYA_RECALL_CONF_XAXIS = "rrf";
    const b = await runFusion(GENERIC_QUERY, [DOMINANT, BROAD_WEAK]);
    for (const spec of [DOMINANT, BROAD_WEAK]) {
      const left = a.get(keyOf(spec.id))!;
      const right = b.get(keyOf(spec.id))!;
      expect(right.fused_score).toBeCloseTo(left.fused_score, 12);
      expect(right.fused_rank).toBe(left.fused_rank);
      expect(left.per_axis_rank).toBeUndefined();
      expect(left.per_axis_contribution).toBeUndefined();
    }
  });

  it("flood scale keeps a 0.27 path-suppression delta a demote, not an annihilation", async () => {
    expect(resolveConformantFloodScale()).toBe(1);
    process.env.ALAYA_RECALL_CONFORMANT = "1";
    const spec: CandidateSpec = { id: objectId(1), lexical: 1, path: 1, sourceProximity: 1 };
    const fusion = await runFusion(GENERIC_QUERY, [spec]);
    const before = fusion.get(keyOf(spec.id))!.fused_score;
    expect(before).toBeGreaterThan(0.27);
    const suppressed = applyPathSuppressionToFusionScores(fusion, { [spec.id]: 0.27 });
    const after = suppressed.get(keyOf(spec.id))!.fused_score;
    // Clean subtraction (not floored to the 1e-4 residual): demoted but still well above zero.
    expect(after).toBeCloseTo(before - 0.27, 9);
    expect(after).toBeGreaterThan(1e-4);
    expect(after).toBeLessThan(before);
  });
});
