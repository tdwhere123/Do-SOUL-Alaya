import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeCachedDatabase,
  EMBEDDING_OVERLAY_BIND_FILENAME,
  initDatabase
} from "@do-soul/alaya-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startBenchDaemon, type BenchDaemonHandle } from "../../../harness/daemon.js";
import {
  explodePackedWorkingCopy,
  explodeRecallEvalWorkingCopyIfNeeded,
  installRecallEvalWorkspaceSlice,
  installWorkspaceSlice,
  loadSliceIntoOpenDatabase,
  packedWorkingDbPath,
  workingAlayaDbPath
} from "../../../bench/snapshot/recall-eval/workspace-slice/index.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import {
  createPackedTwoWorkspaceDb,
  EVIDENCE_A,
  EVIDENCE_B,
  MEMORY_A,
  MEMORY_B,
  plantPackedPathProjections,
  TOKEN_A,
  TOKEN_B,
  WORKSPACE_A,
  WORKSPACE_B,
  writeOverlayBindBeside,
  writeRealMemoryOverlayBeside
} from "./workspace-slice-fixture.js";

const OVERLAY_SHA = "a".repeat(64);
const previousWriteQueue = process.env.ALAYA_SQLITE_WRITE_QUEUE;

let root: string;
let packedPath: string;
const daemons: BenchDaemonHandle[] = [];

beforeEach(async () => {
  // Vitest loads storage from source, so the write-queue worker.js sibling is absent.
  process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
  root = await mkdtemp(join(tmpdir(), "workspace-slice-"));
  packedPath = join(root, "packed.alaya.db");
  await createPackedTwoWorkspaceDb(packedPath);
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.shutdown().catch(() => undefined);
  }
  closeCachedDatabase(packedPath);
  if (previousWriteQueue === undefined) {
    delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
  } else {
    process.env.ALAYA_SQLITE_WRITE_QUEUE = previousWriteQueue;
  }
  await removeTempDirectory(root);
});

describe("packed workspace slice explode", () => {
  it("copies workspace-scoped rows so each slice matches packed WHERE workspace_id", () => {
    const destDir = join(root, "slices");
    const exploded = explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    const packed = initDatabase({ filename: packedPath });
    try {
      assertSliceMatchesPacked(exploded.sliceDbPaths[WORKSPACE_A]!, packed, WORKSPACE_A);
      assertSliceMatchesPacked(exploded.sliceDbPaths[WORKSPACE_B]!, packed, WORKSPACE_B);
    } finally {
      packed.close();
    }
  });

  it("MATCH on slice A never returns B object_ids and vice versa", () => {
    const destDir = join(root, "slices-fts");
    const exploded = explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    const sliceA = initDatabase({ filename: exploded.sliceDbPaths[WORKSPACE_A]! });
    const sliceB = initDatabase({ filename: exploded.sliceDbPaths[WORKSPACE_B]! });
    try {
      expect(matchObjectIds(sliceA, "memory_content_fts_porter", TOKEN_A)).toEqual([MEMORY_A]);
      expect(matchObjectIds(sliceA, "memory_content_fts_porter", TOKEN_B)).toEqual([]);
      expect(matchObjectIds(sliceB, "memory_content_fts_porter", TOKEN_B)).toEqual([MEMORY_B]);
      expect(matchObjectIds(sliceB, "memory_content_fts_porter", TOKEN_A)).toEqual([]);
      expect(matchObjectIds(sliceA, "evidence_capsule_fts", TOKEN_A)).toEqual([EVIDENCE_A]);
      expect(matchObjectIds(sliceA, "evidence_capsule_fts", TOKEN_B)).toEqual([]);
      expect(matchObjectIds(sliceB, "evidence_capsule_fts", TOKEN_B)).toEqual([EVIDENCE_B]);
      expect(matchObjectIds(sliceB, "evidence_capsule_fts", TOKEN_A)).toEqual([]);
    } finally {
      sliceA.close();
      sliceB.close();
    }
  });

  it("replicates overlay bind and sidecar into each slice dir", () => {
    const overlayPath = writeOverlayBindBeside(packedPath, OVERLAY_SHA);
    const destDir = join(root, "slices-overlay");
    const exploded = explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
      const sliceDir = dirname(exploded.sliceDbPaths[workspaceId]!);
      const bindPath = join(sliceDir, EMBEDDING_OVERLAY_BIND_FILENAME);
      const copiedOverlay = join(sliceDir, `.embedding-cache-overlay-${OVERLAY_SHA}.sqlite`);
      expect(existsSync(bindPath)).toBe(true);
      expect(JSON.parse(readFileSync(bindPath, "utf8"))).toMatchObject({
        overlay_filename: `.embedding-cache-overlay-${OVERLAY_SHA}.sqlite`,
        overlay_sha256: OVERLAY_SHA
      });
      expect(existsSync(copiedOverlay)).toBe(true);
      const stat = lstatSync(copiedOverlay);
      if (stat.isSymbolicLink()) {
        expect(readFileSync(copiedOverlay, "utf8")).toBe(readFileSync(overlayPath, "utf8"));
      } else {
        expect(readFileSync(copiedOverlay, "utf8")).toBe("overlay-sidecar\n");
      }
    }
  });

  it("fails when a product table is neither workspace-scoped nor handled", () => {
    const packed = initDatabase({ filename: packedPath });
    packed.connection.exec("CREATE TABLE orphan_global_probe (id TEXT PRIMARY KEY)");
    packed.connection.prepare("INSERT INTO orphan_global_probe (id) VALUES (?)").run("leak");
    packed.close();
    expect(() => explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir: join(root, "slices-unhandled"),
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    })).toThrow(/unhandled table orphan_global_probe/u);
  });

  it("rebinds temporal receipts so a sliced dest still passes the runtime gate", () => {
    plantPackedPathProjections(packedPath);
    closeCachedDatabase(packedPath);
    const destDir = join(root, "slices-temporal");
    const exploded = explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    const packed = initDatabase({ filename: packedPath });
    const packedHistory = readHistoryDigest(packed);
    packed.close();
    const sliceA = initDatabase({ filename: exploded.sliceDbPaths[WORKSPACE_A]! });
    const sliceB = initDatabase({ filename: exploded.sliceDbPaths[WORKSPACE_B]! });
    try {
      expect(countTable(sliceA, "relation_path_projections")).toBe(2);
      expect(countTableWhere(sliceA, "relation_path_projections", WORKSPACE_B)).toBe(1);
      expect(readProjectionCount(sliceA)).toBe(2);
      expect(readHistoryDigest(sliceA)).toBe(packedHistory);
      expect(countTable(sliceA, "relation_assertion_evidence")).toBe(2);
      expect(countTable(sliceB, "relation_path_projections")).toBe(2);
      expect(countTableWhere(sliceB, "relation_path_projections", WORKSPACE_A)).toBe(1);
      expect(readProjectionCount(sliceB)).toBe(2);
      expect(readHistoryDigest(sliceB)).toBe(packedHistory);
    } finally {
      sliceA.close();
      sliceB.close();
    }
    const dataDir = join(root, "temporal-install");
    installWorkspaceSlice({ dataDir, sliceDbPath: packedPath });
    installRecallEvalWorkspaceSlice({
      dataDirRoot: dataDir,
      workspaceId: WORKSPACE_A,
      slices: exploded
    });
    const working = initDatabase({ filename: workingAlayaDbPath(dataDir) });
    try {
      expect(countTable(working, "relation_path_projections")).toBe(2);
      expect(countTable(working, "relation_assertion_evidence")).toBe(2);
      expect(countTableWhere(working, "relation_path_projections", WORKSPACE_B)).toBe(1);
      expect(readProjectionCount(working)).toBe(2);
      expect(readHistoryDigest(working)).toBe(packedHistory);
    } finally {
      working.close();
    }
  });
});

describe("workspace slice install and daemon reopen", () => {
  it("installing slice B after A leaves only B on the search path", () => {
    const destDir = join(root, "slices-install");
    const dataDir = join(root, "data");
    const exploded = explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    installWorkspaceSlice({
      dataDir,
      sliceDbPath: exploded.sliceDbPaths[WORKSPACE_A]!
    });
    const afterA = initDatabase({ filename: join(dataDir, "alaya.db") });
    expect(matchObjectIds(afterA, "memory_content_fts_porter", TOKEN_A)).toEqual([MEMORY_A]);
    expect(matchObjectIds(afterA, "memory_content_fts_porter", TOKEN_B)).toEqual([]);
    afterA.close();
    installWorkspaceSlice({
      dataDir,
      sliceDbPath: exploded.sliceDbPaths[WORKSPACE_B]!
    });
    const afterB = initDatabase({ filename: join(dataDir, "alaya.db") });
    expect(matchObjectIds(afterB, "memory_content_fts_porter", TOKEN_B)).toEqual([MEMORY_B]);
    expect(matchObjectIds(afterB, "memory_content_fts_porter", TOKEN_A)).toEqual([]);
    expect(countTable(afterB, "memory_entries")).toBe(1);
    afterB.close();
  });

  it("reopening the daemon working db does not read stale packed pages", async () => {
    const destDir = join(root, "slices-daemon");
    const dataDir = join(root, "daemon-data");
    const exploded = explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    installWorkspaceSlice({
      dataDir,
      sliceDbPath: exploded.sliceDbPaths[WORKSPACE_A]!
    });
    const daemon = await startBenchDaemon({
      dataDirRoot: dataDir,
      workspaceId: WORKSPACE_A,
      runId: "run-a",
      embeddingMode: "disabled"
    });
    daemons.push(daemon);
    const attachedA = await daemon.attachWorkspace({
      workspaceId: WORKSPACE_A,
      runId: "run-a"
    });
    const recallA = await attachedA.recall(TOKEN_A, { maxResults: 10 });
    expect(recallA.results.map((row) => row.object_id)).toContain(MEMORY_A);
    await attachedA.detach();

    installWorkspaceSlice({
      dataDir,
      sliceDbPath: exploded.sliceDbPaths[WORKSPACE_B]!
    });
    daemon.reloadWorkingDatabase();
    const attachedB = await daemon.attachWorkspace({
      workspaceId: WORKSPACE_B,
      runId: "run-b"
    });
    const stale = await attachedB.recall(TOKEN_A, { maxResults: 10 });
    expect(stale.results.map((row) => row.object_id)).not.toContain(MEMORY_A);
    const recallB = await attachedB.recall(TOKEN_B, { maxResults: 10 });
    expect(recallB.results.map((row) => row.object_id)).toContain(MEMORY_B);
    await attachedB.detach();
  }, 120_000);

  it("reuses packed.alaya.db after a one-workspace working copy is installed", () => {
    const dataDir = join(root, "reopen-data");
    installWorkspaceSlice({ dataDir, sliceDbPath: packedPath });
    const first = explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: dataDir });
    expect(first).not.toBeNull();
    expect(first!.workspaceIds).toEqual([WORKSPACE_A, WORKSPACE_B]);
    installRecallEvalWorkspaceSlice({
      dataDirRoot: dataDir,
      workspaceId: WORKSPACE_A,
      slices: first!
    });
    const working = initDatabase({ filename: workingAlayaDbPath(dataDir) });
    try {
      expect(countTable(working, "memory_entries")).toBe(1);
    } finally {
      working.close();
    }
    const second = explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: dataDir });
    expect(second).not.toBeNull();
    expect(second!.packedDbPath).toBe(packedWorkingDbPath(dataDir));
    expect(second!.sliceDbPaths[WORKSPACE_A]).toBe(first!.sliceDbPaths[WORKSPACE_A]);
    installRecallEvalWorkspaceSlice({
      dataDirRoot: dataDir,
      workspaceId: WORKSPACE_B,
      slices: second!
    });
    const afterB = initDatabase({ filename: workingAlayaDbPath(dataDir) });
    try {
      expect(matchObjectIds(afterB, "memory_content_fts_porter", TOKEN_B)).toEqual([MEMORY_B]);
      expect(matchObjectIds(afterB, "memory_content_fts_porter", TOKEN_A)).toEqual([]);
    } finally {
      afterB.close();
    }
  });

  it("boots the daemon after explode then switches A to B", async () => {
    const dataDir = join(root, "boot-after-explode");
    installWorkspaceSlice({ dataDir, sliceDbPath: packedPath });
    const slices = explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: dataDir });
    expect(slices).not.toBeNull();
    installRecallEvalWorkspaceSlice({
      dataDirRoot: dataDir,
      workspaceId: WORKSPACE_A,
      slices: slices!
    });
    const daemon = await startBenchDaemon({
      dataDirRoot: dataDir,
      workspaceId: WORKSPACE_A,
      runId: "run-a",
      embeddingMode: "disabled"
    });
    daemons.push(daemon);
    const attachedA = await daemon.attachWorkspace({
      workspaceId: WORKSPACE_A,
      runId: "run-a"
    });
    const recallA = await attachedA.recall(TOKEN_A, { maxResults: 10 });
    expect(recallA.results.map((row) => row.object_id)).toContain(MEMORY_A);
    await attachedA.detach();
    installRecallEvalWorkspaceSlice({
      dataDirRoot: dataDir,
      workspaceId: WORKSPACE_B,
      slices: slices!
    });
    daemon.reloadWorkingDatabase();
    const attachedB = await daemon.attachWorkspace({
      workspaceId: WORKSPACE_B,
      runId: "run-b"
    });
    expect((await attachedB.recall(TOKEN_A, { maxResults: 10 })).results.map((row) => row.object_id))
      .not.toContain(MEMORY_A);
    expect((await attachedB.recall(TOKEN_B, { maxResults: 10 })).results.map((row) => row.object_id))
      .toContain(MEMORY_B);
    await attachedB.detach();
  }, 120_000);

  it("loads slice B on a live overlay-attached connection without losing the projection", () => {
    const dataDir = join(root, "overlay-live-slice");
    installWorkspaceSlice({ dataDir, sliceDbPath: packedPath });
    writeRealMemoryOverlayBeside(workingAlayaDbPath(dataDir), MEMORY_A, WORKSPACE_A);
    const slices = explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: dataDir });
    expect(slices).not.toBeNull();
    installRecallEvalWorkspaceSlice({
      dataDirRoot: dataDir,
      workspaceId: WORKSPACE_A,
      slices: slices!
    });
    const live = initDatabase({ filename: workingAlayaDbPath(dataDir) });
    try {
      expect(() => installRecallEvalWorkspaceSlice({
        dataDirRoot: dataDir,
        workspaceId: WORKSPACE_B,
        slices: slices!
      })).not.toThrow();
      expect(matchObjectIds(live, "memory_content_fts_porter", TOKEN_B)).toEqual([MEMORY_B]);
      expect(matchObjectIds(live, "memory_content_fts_porter", TOKEN_A)).toEqual([]);
      expect(countTable(live, "memory_embeddings")).toBe(1);
      expect(countTable(live, "main.memory_embeddings")).toBe(0);
    } finally {
      live.close();
    }
  });

  it("restores foreign_keys after a failed slice attach", () => {
    const dataDir = join(root, "fk-restore");
    installWorkspaceSlice({ dataDir, sliceDbPath: packedPath });
    const live = initDatabase({ filename: join(dataDir, "alaya.db") });
    try {
      const triggerCountBefore = countTriggers(live);
      expect(triggerCountBefore).toBeGreaterThan(0);
      expect(() => loadSliceIntoOpenDatabase(live, join(dataDir, "missing-slice.db"))).toThrow();
      const fk = live.connection.pragma("foreign_keys") as ReadonlyArray<{ foreign_keys: number }>;
      expect(fk[0]?.foreign_keys).toBe(1);
      expect(countTriggers(live)).toBe(triggerCountBefore);
    } finally {
      live.close();
    }
  });

  it("pager explode is skipped when the skip env is set", () => {
    const dataDir = join(root, "skip-data");
    installWorkspaceSlice({
      dataDir,
      sliceDbPath: packedPath
    });
    const exploded = explodeRecallEvalWorkingCopyIfNeeded({
      dataDirRoot: dataDir,
      env: { ALAYA_RECALL_EVAL_SKIP_WORKSPACE_SLICE: "1" }
    });
    expect(exploded).toBeNull();
  });
});

function assertSliceMatchesPacked(
  slicePath: string,
  packed: ReturnType<typeof initDatabase>,
  workspaceId: string
): void {
  const slice = initDatabase({ filename: slicePath });
  try {
    expect(countTableWhere(slice, "memory_entries", workspaceId))
      .toBe(countTableWhere(packed, "memory_entries", workspaceId));
    expect(countTableWhere(slice, "factor_incidences", workspaceId))
      .toBe(countTableWhere(packed, "factor_incidences", workspaceId));
    expect(countFts(slice, "memory_content_fts_porter"))
      .toBe(countTableWhere(packed, "memory_entries", workspaceId));
    expect(countTableWhere(slice, "memory_entries", workspaceId === WORKSPACE_A ? WORKSPACE_B : WORKSPACE_A))
      .toBe(0);
  } finally {
    slice.close();
  }
}

function countTable(database: ReturnType<typeof initDatabase>, table: string): number {
  const row = database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  return row.n;
}

function readProjectionCount(database: ReturnType<typeof initDatabase>): number {
  const row = database.connection.prepare(
    "SELECT projection_count AS n FROM temporal_schema_state WHERE state_id = 1"
  ).get() as { n: number };
  return row.n;
}

function readHistoryDigest(database: ReturnType<typeof initDatabase>): string {
  const row = database.connection.prepare(
    "SELECT history_digest AS digest FROM temporal_schema_state WHERE state_id = 1"
  ).get() as { digest: string };
  return row.digest;
}

function countTableWhere(
  database: ReturnType<typeof initDatabase>,
  table: string,
  workspaceId: string
): number {
  const row = database.connection.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`
  ).get(workspaceId) as { n: number };
  return row.n;
}

function countTriggers(database: ReturnType<typeof initDatabase>): number {
  const row = database.connection.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'"
  ).get() as { n: number };
  return row.n;
}

function countFts(database: ReturnType<typeof initDatabase>, table: string): number {
  const row = database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  return row.n;
}

function matchObjectIds(
  database: ReturnType<typeof initDatabase>,
  table: string,
  token: string
): readonly string[] {
  const rows = database.connection.prepare(
    `SELECT object_id FROM ${table} WHERE ${table} MATCH ?`
  ).all(token) as ReadonlyArray<{ readonly object_id: string }>;
  return rows.map((row) => row.object_id);
}
