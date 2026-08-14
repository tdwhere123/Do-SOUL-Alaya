import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { compileRecallQueryProbes } from "../../../../../../packages/core/src/recall/query/recall-query-probes.js";
import { collectGovernancePathDerivations } from "../../../../../../packages/core/src/recall/supplements/supplementary-data-governance-paths.js";
import { computeIntegratedFloodScore } from "../../../../../../packages/core/src/recall/scoring/integrated-flood-scoring.js";
import { computeFloodEdgeTransfer } from "../../../../../../packages/core/src/recall/flood/edge-transfer.js";
import {
  resolveConformantFloodCapPerSource,
  resolveConformantFloodCapTotal,
  resolveConformantRhoPath
} from "../../../../../../packages/core/src/recall/scoring/conformant-fusion-scoring.js";
import type { RecallSupplementaryData } from "../../../../../../packages/core/src/recall/runtime/recall-service-types.js";
import {
  StorageDatabase,
  initDatabase,
  isTemporalProjectionSelected
} from "@do-soul/alaya-storage";
import {
  createBoundRecallPathReadPorts,
  resolveRecallPathReadBind
} from "../../../runtime/recall/recall-path-read-bind.js";

const SNAPSHOT = path.resolve(
  process.cwd(),
  ".do-it/bench-runs/recall-any5-evidence-first/rematerialize-10da1318-20260814/snapshot-gated/longmemeval-s-100q.sqlite"
);
const WORKSPACE_ID = "lme-ea9098706deafa04dc8006f7520a5be854f4ef2e4ca143524caa3a7087105ea2";
const SOURCE_ID = "91819ae1-3bfb-4bc6-921c-0a4f2f6a493c";
const TARGET_ID = "c430e48a-3d08-4893-9b50-cf1b06049f97";
const PATH_ID = "relation_assertion_0003fe6d0f2d78f4e1ef18ba0cf0b16e0c5472de62a5999d";

const openDatabases: StorageDatabase[] = [];
let snapshotScratch: string | null = null;
let snapshotCopy: string | null = null;

beforeAll(() => {
  if (!existsSync(SNAPSHOT)) {
    throw new Error(`readonly snapshot missing: ${SNAPSHOT}`);
  }
  snapshotScratch = mkdtempSync(path.join(tmpdir(), "alaya-path-bind-"));
  snapshotCopy = path.join(snapshotScratch, "snapshot.sqlite");
  copyFileSync(SNAPSHOT, snapshotCopy);
  if (statSync(SNAPSHOT).ino === statSync(snapshotCopy).ino) {
    throw new Error("snapshot scratch must not share an inode with the frozen file");
  }
});

afterEach(() => {
  for (const database of openDatabases) {
    if (!database.isClosed()) database.close();
  }
  openDatabases.length = 0;
});

afterAll(() => {
  if (snapshotScratch !== null) {
    rmSync(snapshotScratch, { recursive: true, force: true });
  }
});

describe("typed path transfer bind seam", () => {
  it("defaults to the temporal projection and returns the locator edge on this snapshot", async () => {
    const database = openSnapshotReadonly();
    expect(isTemporalProjectionSelected(database)).toBe(false);
    expect(countRows(database, "path_relations")).toBe(0);
    expect(countActivePathProjections(database)).toBeGreaterThan(0);
    expect(resolveRecallPathReadBind({ database })).toBe("temporal");

    const derivations = await collectLocatorDerivations(database);
    const inflow = derivations.pathInflowByTarget[TARGET_ID] ?? [];
    expect(derivations.pathInflowAvailability).toBe("available");
    expect(inflow).toEqual(expect.arrayContaining([
      expect.objectContaining({ pathId: PATH_ID, seedObjectId: SOURCE_ID, targetObjectId: TARGET_ID })
    ]));

    const flood = computeIntegratedFloodScore({
      entry: memory(TARGET_ID),
      axisInputs: { R_obj: 0.2, A_path: 0.5, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowByTarget: derivations.pathInflowByTarget,
        pathInflowAvailability: derivations.pathInflowAvailability
      })
    });
    expect(flood.diagnostics.path_status).toBe("active");
  }, 60_000);

  it("attributes a production transfer receipt without injecting A_path", async () => {
    const database = openSnapshotReadonly();
    const derivations = await collectLocatorDerivations(database);
    const inflow = derivations.pathInflowByTarget[TARGET_ID] ?? [];
    expect(inflow.length).toBeGreaterThan(0);

    const transfer = computeFloodEdgeTransfer({
      inflow,
      targetObjectId: TARGET_ID,
      rObjectById: new Map([[SOURCE_ID, 1], [TARGET_ID, 1]]),
      capPerSource: resolveConformantFloodCapPerSource(),
      capTotal: resolveConformantFloodCapTotal(),
      rhoPath: resolveConformantRhoPath()
    });
    expect(transfer.traces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path_id: PATH_ID,
        relation_kind: "answers_with",
        seed_object_id: SOURCE_ID,
        target_object_id: TARGET_ID
      })
    ]));
    expect(transfer.value).toBeGreaterThan(0);

    const flood = computeIntegratedFloodScore({
      entry: memory(TARGET_ID),
      axisInputs: { R_obj: 0.2, A_path: transfer.value, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowByTarget: derivations.pathInflowByTarget,
        pathInflowAvailability: derivations.pathInflowAvailability
      })
    });
    expect(flood.diagnostics.path_status).toBe("active");
    expect(flood.diagnostics.A_path).toBe(transfer.value);
  }, 60_000);

  it("seals a forced legacy bind as index_unavailable instead of pass-through identity", async () => {
    const database = openSnapshotReadonly();
    const ports = createBoundRecallPathReadPorts({
      database,
      pathReadBind: "legacy"
    });
    const candidates = [memory(SOURCE_ID), memory(TARGET_ID)];
    const derivations = await collectGovernancePathDerivations({
      dependencies: { pathExpansionPort: ports.pathExpansionPort },
      warn: () => undefined,
      workspaceId: WORKSPACE_ID,
      candidates
    });
    const flood = computeIntegratedFloodScore({
      entry: candidates[1]!,
      axisInputs: { R_obj: 0.2, A_path: 0.5, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowByTarget: derivations.pathInflowByTarget,
        pathInflowAvailability: derivations.pathInflowAvailability
      })
    });
    expect(derivations.pathInflowAvailability).toBe("unavailable");
    expect(flood.diagnostics.path_status).toBe("inactive:index_unavailable");
    expect(flood.diagnostics.A_path).not.toBe(1);
  }, 60_000);
});

describe("refresh-required path index", () => {
  it("seals instead of empty-legacy pass-through when a ready projection needs refresh", async () => {
    const database = initDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET projection_refresh_required = 1, projection_count = 1
      WHERE state_id = 1
    `).run();
    expect(resolveRecallPathReadBind({ database })).toBe("legacy");

    const ports = createBoundRecallPathReadPorts({ database });
    const candidates = [memory(SOURCE_ID), memory(TARGET_ID)];
    const derivations = await collectGovernancePathDerivations({
      dependencies: { pathExpansionPort: ports.pathExpansionPort },
      warn: () => undefined,
      workspaceId: WORKSPACE_ID,
      candidates
    });
    const flood = computeIntegratedFloodScore({
      entry: candidates[1]!,
      axisInputs: { R_obj: 0.2, A_path: 0.5, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowByTarget: derivations.pathInflowByTarget,
        pathInflowAvailability: derivations.pathInflowAvailability
      })
    });
    expect(derivations.pathInflowAvailability).toBe("unavailable");
    expect(flood.diagnostics.path_status).toBe("inactive:index_unavailable");
    expect(flood.diagnostics.A_path).not.toBe(1);
  });
});

async function collectLocatorDerivations(database: StorageDatabase) {
  const ports = createBoundRecallPathReadPorts({ database });
  return await collectGovernancePathDerivations({
    dependencies: { pathExpansionPort: ports.pathExpansionPort },
    warn: () => undefined,
    workspaceId: WORKSPACE_ID,
    candidates: [memory(SOURCE_ID), memory(TARGET_ID)]
  });
}

function openSnapshotReadonly(): StorageDatabase {
  if (snapshotCopy === null) {
    throw new Error("snapshot scratch copy was not prepared");
  }
  const connection = new BetterSqlite3(snapshotCopy, { readonly: true, fileMustExist: true });
  connection.pragma("query_only = ON");
  const database = new StorageDatabase(snapshotCopy, connection);
  openDatabases.push(database);
  return database;
}

function countRows(database: StorageDatabase, table: string): number {
  const row = database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function countActivePathProjections(database: StorageDatabase): number {
  const row = database.connection.prepare(`
    SELECT COUNT(*) AS n
    FROM relation_path_projections
    WHERE generation = (
      SELECT active_projection_generation
      FROM temporal_schema_state
      WHERE state_id = 1 AND status = 'ready' AND projection_refresh_required = 0
    )
  `).get() as { n: number };
  return row.n;
}

function memory(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-08-13T00:00:00.000Z",
    updated_at: "2026-08-13T00:00:00.000Z",
    created_by: "bind-seam-test",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "typed path bind seam locator",
    domain_tags: [],
    evidence_refs: [],
    facet_tags: null,
    canonical_entities: null,
    projection_schema_version: 1,
    workspace_id: WORKSPACE_ID,
    run_id: null,
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: 0.5,
    manifestation_state: "full_eligible",
    retention_state: "consolidated",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
}

function supplementary(overrides: Partial<RecallSupplementaryData> = {}): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("typed path bind seam"),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: new Map(),
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {},
    ...overrides
  };
}
