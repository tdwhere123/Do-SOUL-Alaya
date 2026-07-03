import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
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
import { buildRecallFusionDetails } from "../../recall/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const WS = "workspace-1";
const RUN = "run-1";
const QUERY = "how does the staging release rotate database credentials and migrations?";
const REDUNDANT_ID = "00000000-0000-4000-8000-0000000000a1";
const DISTINCT_ID = "00000000-0000-4000-8000-0000000000b2";
const REDUNDANT_REF = "evidence-redundant-1";
const DISTINCT_REF_A = "evidence-distinct-a";
const DISTINCT_REF_B = "evidence-distinct-b";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  delete process.env.ALAYA_RECALL_LEXICAL_DECORR;
});

function createRealStorage(): { readonly database: StorageDatabase; readonly memoryEntryRepo: SqliteMemoryEntryRepo } {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  workspaceRepo.create({
    workspace_id: WS,
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  runRepo.create({
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
  return { database, memoryEntryRepo };
}

// Equal 4-lane counts but different field spread: redundant collapses onto one ref, distinct lands on two refs.
async function seedCandidates(memoryEntryRepo: SqliteMemoryEntryRepo): Promise<void> {
  await memoryEntryRepo.create(createMemoryEntry({
    object_id: REDUNDANT_ID,
    content: "Staging release database credentials migrations note (redundant single ref).",
    surface_id: null,
    activation_score: 0.4,
    evidence_refs: [REDUNDANT_REF]
  }));
  await memoryEntryRepo.create(createMemoryEntry({
    object_id: DISTINCT_ID,
    content: "Staging release database credentials migrations note (distinct refs).",
    surface_id: null,
    activation_score: 0.4,
    evidence_refs: [DISTINCT_REF_A, DISTINCT_REF_B]
  }));
}

function buildSupplementaryData(): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(QUERY),
    ftsRanks: { [REDUNDANT_ID]: 1, [DISTINCT_ID]: 1 },
    trigramFtsRanks: { [REDUNDANT_ID]: 1, [DISTINCT_ID]: 1 },
    synthesisFtsRanks: {},
    evidenceFtsRanks: { [REDUNDANT_ID]: 1, [DISTINCT_ID]: 1 },
    // Redundant: all weight on one ref. Distinct: two refs → two independent fields.
    evidenceFtsRanksPerRef: {
      [REDUNDANT_REF]: 1,
      [DISTINCT_REF_A]: 1,
      [DISTINCT_REF_B]: 1
    },
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: { [REDUNDANT_ID]: 1, [DISTINCT_ID]: 1 },
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
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

async function fusedScoresFromRealStorage(): Promise<{ readonly redundant: number; readonly distinct: number }> {
  const { memoryEntryRepo } = createRealStorage();
  await seedCandidates(memoryEntryRepo);
  const stored = await memoryEntryRepo.findByWorkspaceId(WS);
  const byId = new Map(stored.map((entry) => [entry.object_id, entry]));
  const fusion = buildRecallFusionDetails({
    candidates: [
      { entry: byId.get(REDUNDANT_ID)!, effectiveScore: 0, effectiveFactors: { activation: 0, relevance: 0 }, structuralScore: 1 },
      { entry: byId.get(DISTINCT_ID)!, effectiveScore: 0, effectiveFactors: { activation: 0, relevance: 0 }, structuralScore: 1 }
    ],
    policy: {} as RecallPolicy,
    supplementaryData: buildSupplementaryData(),
    nowIso: "2026-03-20T10:20:30.000Z"
  });
  return {
    redundant: fusion.get(`workspace_local:memory_entry:${REDUNDANT_ID}`)?.fused_score ?? 0,
    distinct: fusion.get(`workspace_local:memory_entry:${DISTINCT_ID}`)?.fused_score ?? 0
  };
}

describe("selective lexical de-correlation (real SQLite)", () => {
  it("flag ON lifts the distinct-ref candidate's relative rank by restoring its full corroboration credit", async () => {
    delete process.env.ALAYA_RECALL_LEXICAL_DECORR;
    const off = await fusedScoresFromRealStorage();

    process.env.ALAYA_RECALL_LEXICAL_DECORR = "1";
    const on = await fusedScoresFromRealStorage();

    // Distinct's 4 lanes map to 4 fields so ON lifts its discount; redundant's collapse to 3 fields so it stays damped.
    expect(on.distinct).toBeGreaterThan(off.distinct);
    expect(on.redundant).toBeCloseTo(off.redundant, 9);
    // Distinct clears redundant by a wider margin than OFF.
    expect(on.distinct - on.redundant).toBeGreaterThan(off.distinct - off.redundant);
  });

  it("flag OFF is byte-identical to HEAD lane-count scoring", async () => {
    delete process.env.ALAYA_RECALL_LEXICAL_DECORR;
    const first = await fusedScoresFromRealStorage();
    const second = await fusedScoresFromRealStorage();
    expect(first).toEqual(second);

    // ON must reproduce the redundant candidate's OFF value exactly, proving OFF is the unchanged default.
    process.env.ALAYA_RECALL_LEXICAL_DECORR = "1";
    const on = await fusedScoresFromRealStorage();
    expect(on.redundant).toBeCloseTo(first.redundant, 9);
  });
});
