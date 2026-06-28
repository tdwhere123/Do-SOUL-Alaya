import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEntry, RecallPolicy } from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { RunMode, RunState, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { buildRecallFusionDetails } from "../../recall/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const WS = "workspace-1";
const RUN = "run-1";
const QUERY = "which database credential rotation and migration tooling do I prefer for staging releases?";
// Two pooled candidates: HI sets the embedding pool-max, LO competes with lower embedding agreement.
const HI = "00000000-0000-4000-8000-0000000000d1";
const LO = "00000000-0000-4000-8000-0000000000d2";

const GATE_ENV = ["ALAYA_RECALL_EMBED_GATE", "ALAYA_RECALL_EMBED_GATE_FLOOR"] as const;
const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  for (const name of GATE_ENV) {
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

function buildSupplementaryData(embeddingByObject: Readonly<Record<string, number>>): RecallSupplementaryData {
  const ones = { [HI]: 1, [LO]: 1 };
  return {
    queryProbes: compileRecallQueryProbes(QUERY),
    ftsRanks: ones,
    trigramFtsRanks: ones,
    synthesisFtsRanks: ones,
    evidenceFtsRanks: ones,
    evidenceFtsRanksPerRef: { "evidence-1": 1 },
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: ones,
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: embeddingByObject,
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

async function fusedScoresByObject(
  embeddingByObject: Readonly<Record<string, number>>
): Promise<ReadonlyMap<string, number>> {
  const memoryEntryRepo = createRealStorage();
  const content = "Staging release database credential rotation and migration tooling preference note.";
  for (const id of [HI, LO]) {
    await memoryEntryRepo.create(createMemoryEntry({
      object_id: id, content, surface_id: null, activation_score: 0.4, evidence_refs: ["evidence-1"]
    }));
  }
  const stored = await memoryEntryRepo.findByWorkspaceId(WS);
  const byId = new Map(stored.map((entry) => [entry.object_id, entry]));
  const candidate = (entry: Readonly<MemoryEntry>) => ({
    entry,
    effectiveScore: 0,
    effectiveFactors: { activation: 0, relevance: 0, embedding_similarity: embeddingByObject[entry.object_id] ?? 0 },
    structuralScore: 1
  });
  const fusion = buildRecallFusionDetails({
    candidates: [candidate(byId.get(HI)!), candidate(byId.get(LO)!)],
    policy: {} as RecallPolicy,
    supplementaryData: buildSupplementaryData(embeddingByObject),
    nowIso: "2026-03-20T10:20:30.000Z"
  });
  return new Map([...fusion.values()].map((b) => [b.object_id, b.fused_score]));
}

describe("standalone embedding gate (real SQLite)", () => {
  it("flag OFF is byte-identical across runs", async () => {
    const first = await fusedScoresByObject({ [HI]: 0.9, [LO]: 0.45 });
    const second = await fusedScoresByObject({ [HI]: 0.9, [LO]: 0.45 });
    expect(second.get(LO) ?? 0).toBeCloseTo(first.get(LO) ?? 0, 12);
  });

  it("ON demotes the below-pool-max candidate's lexical surface", async () => {
    const baseline = (await fusedScoresByObject({ [HI]: 0.9, [LO]: 0.45 })).get(LO) ?? 0;
    process.env.ALAYA_RECALL_EMBED_GATE = "1";
    process.env.ALAYA_RECALL_EMBED_GATE_FLOOR = "0";
    const gated = (await fusedScoresByObject({ [HI]: 0.9, [LO]: 0.45 })).get(LO) ?? 0;
    expect(gated).toBeLessThan(baseline);
  });

  it("is pool-relative, not absolute: halving every cosine scale leaves the gated score unchanged", async () => {
    process.env.ALAYA_RECALL_EMBED_GATE = "1";
    process.env.ALAYA_RECALL_EMBED_GATE_FLOOR = "0";
    const highScale = (await fusedScoresByObject({ [HI]: 0.9, [LO]: 0.45 })).get(LO) ?? 0;
    const lowScale = (await fusedScoresByObject({ [HI]: 0.45, [LO]: 0.225 })).get(LO) ?? 0;
    expect(lowScale).toBeCloseTo(highScale, 9);
  });

  it("ON is a no-op when no candidate has an embedding signal", async () => {
    const baseline = (await fusedScoresByObject({})).get(LO) ?? 0;
    process.env.ALAYA_RECALL_EMBED_GATE = "1";
    process.env.ALAYA_RECALL_EMBED_GATE_FLOOR = "0";
    const gated = (await fusedScoresByObject({})).get(LO) ?? 0;
    expect(gated).toBeCloseTo(baseline, 12);
  });
});
