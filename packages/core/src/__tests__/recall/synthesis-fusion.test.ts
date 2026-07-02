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
import { classifyRecallIntent } from "../../recall/recall-query-plan.js";
import type { RecallSupplementaryData } from "../../recall/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const WS = "workspace-1";
const RUN = "run-1";
const QUERY = "which database credential rotation and migration tooling do I prefer for staging releases?";
const ID = "00000000-0000-4000-8000-0000000000c3";
const KEY = `workspace_local:memory_entry:${ID}`;

const SYNTHESIS_ENV = [
  "ALAYA_RECALL_SYNTHESIS",
  "ALAYA_RECALL_SYN_DECORR_LAMBDA",
  "ALAYA_RECALL_SYN_GATE_FLOOR",
  "ALAYA_RECALL_SYN_GATE_INTENTS",
  "ALAYA_RECALL_SYN_GOVERN",
  "ALAYA_RECALL_SYN_GOV_RATIO",
  "ALAYA_RECALL_SYN_GOV_FLOOR",
  "ALAYA_RECALL_FLAT_BASELINE"
] as const;

const databases = new Set<StorageDatabase>();

// Legacy synthesis path is reachable only under the flat-baseline kill-switch (four-axis is the default).
beforeEach(() => {
  process.env.ALAYA_RECALL_FLAT_BASELINE = "1";
});

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  for (const name of SYNTHESIS_ENV) {
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

// One candidate carrying a multi-lane lexical family (so de-corr can bite) plus an orthogonal
// embedding signal (so the governance ceiling has something to bound surface against).
function buildSupplementaryData(): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(QUERY),
    ftsRanks: { [ID]: 1 },
    trigramFtsRanks: { [ID]: 1 },
    synthesisFtsRanks: { [ID]: 1 },
    evidenceFtsRanks: { [ID]: 1 },
    evidenceFtsRanksPerRef: { "evidence-1": 1 },
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: { [ID]: 1 },
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: { [ID]: 0.9 },
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

async function fusedScore(): Promise<number> {
  const memoryEntryRepo = createRealStorage();
  await memoryEntryRepo.create(createMemoryEntry({
    object_id: ID,
    content: "Staging release database credential rotation and migration tooling preference note.",
    surface_id: null,
    activation_score: 0.4,
    evidence_refs: ["evidence-1"]
  }));
  const stored = await memoryEntryRepo.findByWorkspaceId(WS);
  const byId = new Map(stored.map((entry) => [entry.object_id, entry]));
  const fusion = buildRecallFusionDetails({
    candidates: [
      { entry: byId.get(ID)!, effectiveScore: 0, effectiveFactors: { activation: 0, relevance: 0 }, structuralScore: 1 }
    ],
    policy: {} as RecallPolicy,
    supplementaryData: buildSupplementaryData(),
    nowIso: "2026-03-20T10:20:30.000Z"
  });
  return fusion.get(KEY)?.fused_score ?? 0;
}

function gateQueryIntent(): void {
  process.env.ALAYA_RECALL_SYN_GATE_INTENTS = classifyRecallIntent(compileRecallQueryProbes(QUERY));
}

describe("four-axis synthesis combine (real SQLite)", () => {
  it("flag OFF is byte-identical across runs", async () => {
    const first = await fusedScore();
    const second = await fusedScore();
    expect(second).toBeCloseTo(first, 12);
  });

  it("λ=1 ∧ γ=1 ∧ governance-off collapses to the additive baseline even for a gated intent", async () => {
    const baseline = await fusedScore();
    process.env.ALAYA_RECALL_SYNTHESIS = "1";
    gateQueryIntent();
    process.env.ALAYA_RECALL_SYN_DECORR_LAMBDA = "1";
    process.env.ALAYA_RECALL_SYN_GATE_FLOOR = "1";
    const collapsed = await fusedScore();
    expect(collapsed).toBeCloseTo(baseline, 9);
  });

  it("default de-correlation (λ=0.5) damps a redundant-lexical candidate below the λ=1 sum", async () => {
    process.env.ALAYA_RECALL_SYNTHESIS = "1";
    gateQueryIntent();
    process.env.ALAYA_RECALL_SYN_GATE_FLOOR = "1";
    process.env.ALAYA_RECALL_SYN_DECORR_LAMBDA = "1";
    const summed = await fusedScore();
    process.env.ALAYA_RECALL_SYN_DECORR_LAMBDA = "0.5";
    const decorrelated = await fusedScore();
    expect(decorrelated).toBeLessThan(summed);
  });

  it("governance ceiling bounds surface mass against the orthogonal signal", async () => {
    process.env.ALAYA_RECALL_SYNTHESIS = "1";
    gateQueryIntent();
    process.env.ALAYA_RECALL_SYN_GATE_FLOOR = "1";
    process.env.ALAYA_RECALL_SYN_DECORR_LAMBDA = "1";
    const ungoverned = await fusedScore();
    process.env.ALAYA_RECALL_SYN_GOVERN = "1";
    process.env.ALAYA_RECALL_SYN_GOV_RATIO = "0";
    process.env.ALAYA_RECALL_SYN_GOV_FLOOR = "0";
    const governed = await fusedScore();
    expect(governed).toBeLessThan(ungoverned);
  });
});
