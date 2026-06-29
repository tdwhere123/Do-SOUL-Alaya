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
const QUERY = "how does the staging release rotate credentials";
// A: strong structural/evidence magnitude, no lexical hit. B: lexical rank-1, weak structural.
const STRUCTURAL_ID = "00000000-0000-4000-8000-00000000aaaa";
const LEXICAL_ID = "00000000-0000-4000-8000-00000000bbbb";

const databases = new Set<StorageDatabase>();

// Legacy flood path is reachable only under the flat-baseline kill-switch (four-axis is the default).
beforeEach(() => {
  process.env.ALAYA_RECALL_FLAT_BASELINE = "1";
});

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  delete process.env.ALAYA_RECALL_FLOOD_FUSION;
  delete process.env.ALAYA_RECALL_FLAT_BASELINE;
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

async function seedCandidates(memoryEntryRepo: SqliteMemoryEntryRepo): Promise<void> {
  await memoryEntryRepo.create(createMemoryEntry({
    object_id: STRUCTURAL_ID,
    content: "Strong structural and evidence corroboration, no query lexical tokens.",
    surface_id: null,
    activation_score: 0.4
  }));
  await memoryEntryRepo.create(createMemoryEntry({
    object_id: LEXICAL_ID,
    content: "Staging release rotate credentials lexical match, weak structural backing.",
    surface_id: null,
    activation_score: 0.4
  }));
}

function buildSupplementaryData(): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(QUERY),
    ftsRanks: { [LEXICAL_ID]: 1 },
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: { [STRUCTURAL_ID]: 1, [LEXICAL_ID]: 0.2 },
    evidenceFtsRanksPerRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: { [STRUCTURAL_ID]: 1, [LEXICAL_ID]: 0.2 },
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

async function fusedScoresFromRealStorage(): Promise<{ readonly structural: number; readonly lexical: number }> {
  const { memoryEntryRepo } = createRealStorage();
  await seedCandidates(memoryEntryRepo);
  const stored = await memoryEntryRepo.findByWorkspaceId(WS);
  const byId = new Map(stored.map((entry) => [entry.object_id, entry]));
  const fusion = buildRecallFusionDetails({
    candidates: [
      { entry: byId.get(STRUCTURAL_ID)!, effectiveScore: 0, effectiveFactors: { activation: 0, relevance: 0 }, structuralScore: 1 },
      { entry: byId.get(LEXICAL_ID)!, effectiveScore: 0, effectiveFactors: { activation: 0, relevance: 0 }, structuralScore: 0.2 }
    ],
    policy: {} as RecallPolicy,
    supplementaryData: buildSupplementaryData(),
    nowIso: "2026-03-20T10:20:30.000Z"
  });
  return {
    structural: fusion.get(`workspace_local:memory_entry:${STRUCTURAL_ID}`)?.fused_score ?? 0,
    lexical: fusion.get(`workspace_local:memory_entry:${LEXICAL_ID}`)?.fused_score ?? 0
  };
}

describe("magnitude-preserving flood fusion (real SQLite)", () => {
  it("flag OFF is byte-identical and deterministic to the RRF rank path", async () => {
    delete process.env.ALAYA_RECALL_FLOOD_FUSION;
    const first = await fusedScoresFromRealStorage();
    const second = await fusedScoresFromRealStorage();
    expect(first).toEqual(second);

    // RRF buries the magnitude-strong candidate behind the lexical rank-1 candidate.
    expect(first.lexical).toBeGreaterThan(first.structural);

    // Turning flood ON must not retroactively change the OFF value path: re-read OFF after toggling back.
    process.env.ALAYA_RECALL_FLOOD_FUSION = "1";
    await fusedScoresFromRealStorage();
    delete process.env.ALAYA_RECALL_FLOOD_FUSION;
    const afterToggle = await fusedScoresFromRealStorage();
    expect(afterToggle).toEqual(first);
  });

  it("flag ON preserves raw magnitude so the structural-strong candidate beats lexical rank-1", async () => {
    delete process.env.ALAYA_RECALL_FLOOD_FUSION;
    const off = await fusedScoresFromRealStorage();
    // Under RRF the structural-strong candidate loses to lexical rank-1.
    expect(off.structural).toBeLessThan(off.lexical);

    process.env.ALAYA_RECALL_FLOOD_FUSION = "1";
    const on = await fusedScoresFromRealStorage();
    // Under flood the preserved structural magnitude clears the lexical rank-1 candidate.
    expect(on.structural).toBeGreaterThan(on.lexical);
  });
});
