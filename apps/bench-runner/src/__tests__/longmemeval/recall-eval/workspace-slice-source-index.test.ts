import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SourceIndexLifecycle } from "@do-soul/alaya-core";
import {
  closeCachedDatabase,
  initDatabase,
  SqliteSourceIndexRepository,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  explodePackedWorkingCopy,
  explodeRecallEvalWorkingCopyIfNeeded,
  installWorkspaceSlice,
  loadSliceIntoOpenDatabase,
  readValidWorkspaceSliceSnapshotDigest,
  digestWorkspaceSliceSnapshotIdentity,
  workspaceSliceDbPath,
  workingAlayaDbPath,
  WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION,
  WORKSPACE_SLICE_SNAPSHOT_SIDECAR_FILENAME
} from "../../../runs/snapshot/recall-eval/workspace-slice/index.js";
import { rebuildWorkspaceFts } from "../../../runs/snapshot/recall-eval/workspace-slice/rebuild-fts.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import {
  createPackedTwoWorkspaceDb,
  WORKSPACE_A,
  WORKSPACE_B
} from "./workspace-slice-fixture.js";
import {
  fieldContractSha256,
  FIXTURE_VECTOR_A,
  matchSourceIndexLane,
  populatePackedSourceIndexes,
  snapshotSourceIndex,
  SOURCE_INDEX_TEXT_ID_GAP,
  SOURCE_LATIN_A,
  SOURCE_LATIN_B,
  SOURCE_QUERY_BUDGET,
  SOURCE_TRIGRAM_A,
  SOURCE_TRIGRAM_B,
  sourceIndexTextIds
} from "./workspace-slice-source-index-fixture.js";

const previousWriteQueue = process.env.ALAYA_SQLITE_WRITE_QUEUE;

let root: string;
let packedPath: string;

beforeEach(async () => {
  process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
  root = await mkdtemp(join(tmpdir(), "workspace-slice-source-index-"));
  packedPath = join(root, "packed.alaya.db");
  await createPackedTwoWorkspaceDb(packedPath);
});

afterEach(async () => {
  closeCachedDatabase(packedPath);
  if (previousWriteQueue === undefined) {
    delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
  } else {
    process.env.ALAYA_SQLITE_WRITE_QUEUE = previousWriteQueue;
  }
  await removeTempDirectory(root);
});

describe("workspace slice source index explode", () => {
  it("seals a single-workspace copy that restores lexical rowid binding and labelled vectors", async () => {
    populatePackedSourceIndexes(packedPath);
    const packed = initDatabase({ filename: packedPath });
    const lifecycle = new SourceIndexLifecycle(new SqliteSourceIndexRepository(packed, fieldContractSha256), fieldContractSha256);
    for (const workspace of [WORKSPACE_A, WORKSPACE_B]) {
      expect(await lifecycle.prepareLexical(workspace, "segmented-unicode61.v1", {
        work: 1_000_000, native_bytes: 16 * 1024 * 1024, capture_page: 128,
        max_capture_pages: 8, max_roots: 128, max_body_bytes: 1_000_000
      })).toMatchObject({ status: "ready", generation: { status: "ready" }, model_inputs: 0 });
    }
    const lexicalA = snapshotLexicalIndex(packed, WORKSPACE_A);
    const lexicalB = snapshotLexicalIndex(packed, WORKSPACE_B);
    expect(lexicalA.source_index_lexical_projections.length).toBeGreaterThan(0);
    expect(lexicalB.source_index_lexical_projections.length).toBeGreaterThan(0);
    const packedA = snapshotSourceIndex(packed, WORKSPACE_A);
    const packedB = snapshotSourceIndex(packed, WORKSPACE_B);
    const packedIds = sourceIndexTextIds(packed);
    packed.close();
    expect(packedIds.length).toBeGreaterThan(1);
    expect(packedIds.every((id) => id > SOURCE_INDEX_TEXT_ID_GAP)).toBe(true);
    expect(packedA).not.toEqual(packedB);
    expect(packedA.source_index_dependencies?.length).toBeGreaterThan(0);
    expect(packedB.source_index_dependencies?.length).toBeGreaterThan(0);

    const exploded = await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir: join(root, "slices"),
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    const sliceAPath = exploded.sliceDbPaths[WORKSPACE_A]!;
    const sliceBPath = exploded.sliceDbPaths[WORKSPACE_B]!;
    const sliceA = initDatabase({ filename: sliceAPath });
    const sliceB = initDatabase({ filename: sliceBPath });
    try {
      expect(snapshotSourceIndex(sliceA, WORKSPACE_A)).toEqual(packedA);
      expect(snapshotSourceIndex(sliceB, WORKSPACE_B)).toEqual(packedB);
      expect(snapshotLexicalIndex(sliceA, WORKSPACE_A)).toEqual(lexicalA);
      expect(snapshotLexicalIndex(sliceB, WORKSPACE_B)).toEqual(lexicalB);
      expect(snapshotLexicalIndex(sliceA, WORKSPACE_B)).toEqual(snapshotLexicalIndex(sliceA, "absent"));
      expect(snapshotLexicalIndex(sliceB, WORKSPACE_A)).toEqual(snapshotLexicalIndex(sliceB, "absent"));
      expect(snapshotSourceIndex(sliceA, WORKSPACE_B)).toEqual(snapshotSourceIndex(sliceA, "absent"));
      expect(sourceIndexTextIds(sliceA).every((id) => id > SOURCE_INDEX_TEXT_ID_GAP)).toBe(true);
      assertLaneHits(sliceA, WORKSPACE_A, SOURCE_LATIN_A, SOURCE_TRIGRAM_A);
      assertLaneMisses(sliceA, WORKSPACE_A, SOURCE_LATIN_B, SOURCE_TRIGRAM_B);
      assertLaneHits(sliceB, WORKSPACE_B, SOURCE_LATIN_B, SOURCE_TRIGRAM_B);
      assertLaneMisses(sliceB, WORKSPACE_B, SOURCE_LATIN_A, SOURCE_TRIGRAM_A);
      assertNativeVectorCurrentness(sliceA, WORKSPACE_A, packedA, FIXTURE_VECTOR_A);
    } finally {
      sliceA.close();
      sliceB.close();
    }

    const dataDir = join(root, "restored");
    installWorkspaceSlice({ dataDir, sliceDbPath: sliceAPath });
    const restored = initDatabase({ filename: workingAlayaDbPath(dataDir) });
    try {
      expect(snapshotSourceIndex(restored, WORKSPACE_A)).toEqual(packedA);
      expect(snapshotLexicalIndex(restored, WORKSPACE_A)).toEqual(lexicalA);
      expect(snapshotLexicalIndex(restored, WORKSPACE_B)).toEqual(snapshotLexicalIndex(restored, "absent"));
      expect(snapshotSourceIndex(restored, WORKSPACE_B)).toEqual(snapshotSourceIndex(restored, "absent"));
      assertLaneHits(restored, WORKSPACE_A, SOURCE_LATIN_A, SOURCE_TRIGRAM_A);
      assertLaneMisses(restored, WORKSPACE_A, SOURCE_LATIN_B, SOURCE_TRIGRAM_B);
      assertNativeVectorCurrentness(restored, WORKSPACE_A, packedA, FIXTURE_VECTOR_A);
      // Replace a live workspace set, not only an empty destination. Old domain triggers must
      // disappear with their tables; replacement triggers must still scrub both FTS lanes.
      const custom = restored.connection.prepare(`SELECT name FROM sqlite_master
        WHERE type='table' AND name GLOB 'source_lexical_*_unicode61'`).get() as { name: string };
      // A table-shaped trigger name is not one of the domain owner's exact trigger identities.
      restored.connection.exec(`CREATE TRIGGER ${custom.name} AFTER INSERT ON source_index_text BEGIN SELECT 1; END`);
      loadSliceIntoOpenDatabase(restored, sliceBPath);
      expect(restored.connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(custom.name)).toEqual(custom);
      expect(snapshotLexicalIndex(restored, WORKSPACE_B)).toEqual(lexicalB);
      expect(snapshotLexicalIndex(restored, WORKSPACE_A)).toEqual(snapshotLexicalIndex(restored, "absent"));
      assertLaneHits(restored, WORKSPACE_B, SOURCE_LATIN_B, SOURCE_TRIGRAM_B);
      const domains = restored.connection.prepare(`SELECT name FROM sqlite_master
        WHERE type='table' AND (name GLOB 'source_lexical_*_unicode61' OR name GLOB 'source_lexical_*_trigram')`)
        .all() as { name: string }[];
      expect(domains).toHaveLength(2);
      restored.connection.prepare("DELETE FROM source_index_text WHERE workspace_id=?").run(WORKSPACE_B);
      for (const { name } of domains) expect(restored.connection.prepare(`SELECT count(*) AS n FROM ${name}`).get()).toEqual({ n: 0 });
    } finally {
      restored.close();
    }
  });

  it("refuses unknown FTS names before rebuild mutations or snapshot receipts", async () => {
    const probe = initDatabase();
    try {
      const exec = vi.spyOn(probe.connection, "exec"), prepare = vi.spyOn(probe.connection, "prepare");
      expect(() => rebuildWorkspaceFts(probe.connection, ["memory_content_fts", "unhandled_fts_probe"]))
        .toThrow(/unhandled FTS table unhandled_fts_probe/u);
      expect(exec).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
      exec.mockRestore(); prepare.mockRestore();
    } finally { probe.close({ optimize: false }); }

    const packed = initDatabase({ filename: packedPath });
    packed.connection.exec("CREATE VIRTUAL TABLE unhandled_fts_probe USING fts5(body)");
    packed.close();
    const destDir = join(root, "slices-unknown-fts");
    await expect(explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    })).rejects.toThrow(/unhandled FTS table unhandled_fts_probe/u);
    expect(existsSync(join(
      dirname(workspaceSliceDbPath(destDir, WORKSPACE_A)),
      WORKSPACE_SLICE_SNAPSHOT_SIDECAR_FILENAME
    ))).toBe(false);
  });

  it.each(["v1", "v2", "v3"])("refuses a %s sidecar instead of relabelling it as a lexical-complete snapshot", async (recipeVersion) => {
    const dataDir = join(root, `${recipeVersion}-data`);
    installWorkspaceSlice({ dataDir, sliceDbPath: packedPath });
    const first = await explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: dataDir });
    expect(first).not.toBeNull();
    const sliceA = first!.sliceDbPaths[WORKSPACE_A]!;
    const sidecar = JSON.parse(readFileSync(sidecarPath(sliceA), "utf8")) as {
      readonly schema_version: number;
      readonly recipe_version: string;
      readonly sqlite_main_file_sha256: string;
      readonly snapshot_digest: string;
    };
    expect(sidecar.schema_version).toBe(1);
    expect(sidecar.recipe_version).toBe(WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION);
    writeFileSync(sidecarPath(sliceA), `${JSON.stringify({
      ...sidecar,
      recipe_version: recipeVersion,
      snapshot_digest: digestWorkspaceSliceSnapshotIdentity({
        workspaceId: WORKSPACE_A,
        sqliteMainFileSha256: sidecar.sqlite_main_file_sha256,
        recipeVersion
      })
    })}\n`);
    expect(readValidWorkspaceSliceSnapshotDigest({
      workspaceId: WORKSPACE_A,
      dbPath: sliceA
    })).toBeNull();
    expect(JSON.parse(readFileSync(sidecarPath(sliceA), "utf8"))).toMatchObject({
      schema_version: 1,
      recipe_version: recipeVersion
    });
  });
});

function sidecarPath(dbPath: string): string {
  return join(dirname(dbPath), WORKSPACE_SLICE_SNAPSHOT_SIDECAR_FILENAME);
}

function assertLaneHits(
  database: StorageDatabase,
  workspaceId: string,
  latin: string,
  trigram: string
): void {
  const lexical = lexicalHits(database, latin);
  expect(lexical.length).toBeGreaterThan(0);
  for (const row of lexical) {
    expect(row.workspace_id).toBe(workspaceId);
    expect(row.fts_rowid).toBe(row.id);
    expect(row.projection).toContain(latin);
  }
  const unicode61 = matchSourceIndexLane(database, "source_index_fts", latin, workspaceId);
  const trigramHits = matchSourceIndexLane(database, "source_index_fts_trigram", trigram, workspaceId);
  expect(unicode61.length).toBeGreaterThan(0);
  expect(trigramHits.length).toBeGreaterThan(0);
  for (const row of unicode61) {
    expect(row.fts_rowid).toBe(row.id);
    expect(row.id).toBeGreaterThan(SOURCE_INDEX_TEXT_ID_GAP);
    expect(row.body).toContain(latin);
  }
  for (const row of trigramHits) {
    expect(row.fts_rowid).toBe(row.id);
    expect(row.id).toBeGreaterThan(SOURCE_INDEX_TEXT_ID_GAP);
    expect(row.body).toContain(trigram);
  }
}

function assertLaneMisses(
  database: StorageDatabase,
  workspaceId: string,
  latin: string,
  trigram: string
): void {
  expect(lexicalHits(database, latin)).toEqual([]);
  expect(matchSourceIndexLane(database, "source_index_fts", latin, workspaceId)).toEqual([]);
  expect(matchSourceIndexLane(database, "source_index_fts_trigram", trigram, workspaceId)).toEqual([]);
}

function snapshotLexicalIndex(database: StorageDatabase, workspace: string) {
  const rows = (table: string, order: string) => database.connection.prepare(
    `SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY ${order}`
  ).all(workspace);
  return {
    source_index_lexical_selections: rows("source_index_lexical_selections", "workspace_id"),
    source_index_lexical_generations: rows("source_index_lexical_generations", "generation_id"),
    source_index_lexical_targets: rows("source_index_lexical_targets", "generation_id, root_key"),
    source_index_lexical_projections: rows("source_index_lexical_projections", "id")
  };
}

function lexicalHits(database: StorageDatabase, term: string) {
  const tables = database.connection.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name GLOB 'source_lexical_*_unicode61'`).all() as { name: string }[];
  return tables.flatMap(({ name }) => database.connection.prepare(`SELECT p.id, ${name}.rowid AS fts_rowid,
    p.workspace_id, p.projection FROM ${name}
    JOIN source_index_lexical_projections p ON p.id = ${name}.rowid
    WHERE ${name} MATCH ? ORDER BY p.id`).all(term) as {
      id: number; fts_rowid: number; workspace_id: string; projection: string
    }[]);
}

function assertNativeVectorCurrentness(
  database: StorageDatabase,
  workspaceId: string,
  packedSnapshot: ReturnType<typeof snapshotSourceIndex>,
  labelled: readonly number[]
): void {
  const generation = packedSnapshot.source_index_generations?.[0] as
    | { readonly generation_id: string; readonly status: string }
    | undefined;
  expect(generation?.status).toBe("ready");
  const blobs = database.connection.prepare(
    "SELECT embedding_blob FROM source_index_vectors WHERE workspace_id = ?"
  ).all(workspaceId) as Array<{ readonly embedding_blob: Buffer }>;
  expect(blobs.length).toBeGreaterThan(0);
  const expected = encodeFixtureVector(labelled);
  for (const row of blobs) {
    expect(row.embedding_blob.toString("hex")).toBe(expected);
  }
  const index = new SqliteSourceIndexRepository(database, fieldContractSha256);
  const scan = index.readVectorCandidates(workspaceId, null, 128, SOURCE_QUERY_BUDGET);
  expect(scan.state).toMatchObject({
    status: "ready",
    binding: { generation_id: generation!.generation_id }
  });
  expect(scan.candidates.length).toBeGreaterThan(0);
  const admitted = index.admitQueryCandidate(
    scan.candidates[0]!.source,
    "binding" in scan.state ? scan.state.binding : null,
    SOURCE_QUERY_BUDGET
  );
  expect(admitted).toMatchObject({ status: "ready" });
}

function encodeFixtureVector(values: readonly number[]): string {
  const blob = Buffer.alloc(values.length * Float32Array.BYTES_PER_ELEMENT);
  values.forEach((value, index) => blob.writeFloatLE(
    value,
    index * Float32Array.BYTES_PER_ELEMENT
  ));
  return blob.toString("hex");
}
