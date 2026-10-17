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
      expect(snapshotSourceIndex(restored, WORKSPACE_B)).toEqual(snapshotSourceIndex(restored, "absent"));
      assertLaneHits(restored, WORKSPACE_A, SOURCE_LATIN_A, SOURCE_TRIGRAM_A);
      assertLaneMisses(restored, WORKSPACE_A, SOURCE_LATIN_B, SOURCE_TRIGRAM_B);
      assertNativeVectorCurrentness(restored, WORKSPACE_A, packedA, FIXTURE_VECTOR_A);
    } finally {
      restored.close();
    }
  });

  it("refuses unknown FTS names before rebuild mutations or snapshot receipts", async () => {
    const recorded: string[] = [];
    expect(() => rebuildWorkspaceFts({
      exec(sql: string) { recorded.push(sql); },
      prepare(sql: string) {
        recorded.push(sql);
        return { all: () => [] };
      }
    }, ["memory_content_fts", "unhandled_fts_probe"])).toThrow(
      /unhandled FTS table unhandled_fts_probe/u
    );
    expect(recorded).toEqual([]);

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

  it("refuses a v1 sidecar instead of relabelling it v2", async () => {
    const dataDir = join(root, "v1-data");
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
      recipe_version: "v1",
      snapshot_digest: digestWorkspaceSliceSnapshotIdentity({
        workspaceId: WORKSPACE_A,
        sqliteMainFileSha256: sidecar.sqlite_main_file_sha256,
        recipeVersion: "v1"
      })
    })}\n`);
    expect(readValidWorkspaceSliceSnapshotDigest({
      workspaceId: WORKSPACE_A,
      dbPath: sliceA
    })).toBeNull();
    expect(JSON.parse(readFileSync(sidecarPath(sliceA), "utf8"))).toMatchObject({
      schema_version: 1,
      recipe_version: "v1"
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
  expect(matchSourceIndexLane(database, "source_index_fts", latin, workspaceId)).toEqual([]);
  expect(matchSourceIndexLane(database, "source_index_fts_trigram", trigram, workspaceId)).toEqual([]);
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
