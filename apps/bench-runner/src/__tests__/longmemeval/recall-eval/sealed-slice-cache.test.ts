import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  explodeRecallEvalWorkingCopyIfNeeded,
  installWorkspaceSlice,
  packedWorkingDbPath,
  SEALED_SLICE_RESTORE_ENV,
  sealedWorkspaceSliceCacheDir
} from "../../../bench/snapshot/recall-eval/workspace-slice/index.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import {
  createPackedTwoWorkspaceDb,
  WORKSPACE_A
} from "./workspace-slice-fixture.js";

const previousWriteQueue = process.env.ALAYA_SQLITE_WRITE_QUEUE;

let root: string;
let packedPath: string;

beforeEach(async () => {
  process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
  root = await mkdtemp(join(tmpdir(), "sealed-slice-cache-"));
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

describe("sealed workspace slices beside the snapshot", () => {
  it("ranking-only and harness-only reruns reuse slices without exploding", async () => {
    const snapshotDbPath = join(root, "snapshot.db");
    copyFileSync(packedPath, snapshotDbPath);
    const firstDir = join(root, "data-1");
    installWorkspaceSlice({ dataDir: firstDir, sliceDbPath: snapshotDbPath });
    const first = await explodeRecallEvalWorkingCopyIfNeeded({
      dataDirRoot: firstDir,
      snapshotDbPath
    });
    expect(first).not.toBeNull();
    const sealedDir = sealedWorkspaceSliceCacheDir(snapshotDbPath);
    expect(first!.destDir).toBe(sealedDir);
    expect(existsSync(join(sealedDir, "KEEP"))).toBe(false);
    writeFileSync(join(sealedDir, "KEEP"), "1");

    const secondDir = join(root, "data-2");
    installWorkspaceSlice({ dataDir: secondDir, sliceDbPath: snapshotDbPath });
    const reused = await explodeRecallEvalWorkingCopyIfNeeded({
      dataDirRoot: secondDir,
      snapshotDbPath,
      requireReuse: true
    });
    expect(reused?.destDir).toBe(sealedDir);
    expect(reused?.sliceDbPaths[WORKSPACE_A]).toBe(first!.sliceDbPaths[WORKSPACE_A]);
    expect(reused?.sliceSnapshotDigests).toEqual(first!.sliceSnapshotDigests);
    expect(readFileSync(join(sealedDir, "KEEP"), "utf8")).toBe("1");
  });

  it("refuses a drifted packed identity instead of exploding or scoring stale slices", async () => {
    const snapshotDbPath = join(root, "snapshot.db");
    copyFileSync(packedPath, snapshotDbPath);
    const firstDir = join(root, "data-ok");
    installWorkspaceSlice({ dataDir: firstDir, sliceDbPath: snapshotDbPath });
    const first = await explodeRecallEvalWorkingCopyIfNeeded({
      dataDirRoot: firstDir,
      snapshotDbPath
    });
    expect(first).not.toBeNull();
    const sealedDir = sealedWorkspaceSliceCacheDir(snapshotDbPath);
    writeFileSync(join(sealedDir, "KEEP"), "1");
    const identityPath = join(sealedDir, "identity.json");
    const identity = JSON.parse(readFileSync(identityPath, "utf8")) as {
      packed_db_sha256: string;
    };
    writeFileSync(identityPath, `${JSON.stringify({
      ...identity,
      packed_db_sha256: "0".repeat(64)
    })}\n`);

    const driftedDir = join(root, "data-drift");
    installWorkspaceSlice({ dataDir: driftedDir, sliceDbPath: snapshotDbPath });
    await expect(explodeRecallEvalWorkingCopyIfNeeded({
      dataDirRoot: driftedDir,
      snapshotDbPath,
      requireReuse: true
    })).rejects.toThrow(/refuse|identity/u);
    expect(readFileSync(join(sealedDir, "KEEP"), "utf8")).toBe("1");
    expect(packedWorkingDbPath(driftedDir)).not.toBe(first!.packedDbPath);
  });

  it("require-reuse refuses when sealed slices are missing", async () => {
    const snapshotDbPath = join(root, "snapshot.db");
    copyFileSync(packedPath, snapshotDbPath);
    const dataDir = join(root, "data-missing");
    installWorkspaceSlice({ dataDir, sliceDbPath: snapshotDbPath });
    await expect(explodeRecallEvalWorkingCopyIfNeeded({
      dataDirRoot: dataDir,
      snapshotDbPath,
      requireReuse: true
    })).rejects.toThrow(/reuse/u);
  });

  it("seed-identity drift refuses instead of exploding", async () => {
    const { snapshotDbPath, sealedDir } = await explodeOnce("data-seed");
    writeFileSync(join(sealedDir, "KEEP"), "1");
    patchSealedIdentity(sealedDir, { seed_identity: "stale-seed-v0" });
    const driftedDir = join(root, "data-seed-drift");
    installWorkspaceSlice({ dataDir: driftedDir, sliceDbPath: snapshotDbPath });
    await expect(explodeRecallEvalWorkingCopyIfNeeded({
      dataDirRoot: driftedDir,
      snapshotDbPath,
      requireReuse: true
    })).rejects.toThrow(/refuse|identity/u);
    expect(readFileSync(join(sealedDir, "KEEP"), "utf8")).toBe("1");
  });

  it("corrupt identity refuses instead of exploding", async () => {
    const { snapshotDbPath, sealedDir } = await explodeOnce("data-corrupt");
    writeFileSync(join(sealedDir, "KEEP"), "1");
    writeFileSync(join(sealedDir, "identity.json"), "{not-json");
    const driftedDir = join(root, "data-corrupt-run");
    installWorkspaceSlice({ dataDir: driftedDir, sliceDbPath: snapshotDbPath });
    await expect(explodeRecallEvalWorkingCopyIfNeeded({
      dataDirRoot: driftedDir,
      snapshotDbPath
    })).rejects.toThrow(/refuse|identity/u);
    expect(readFileSync(join(sealedDir, "KEEP"), "utf8")).toBe("1");
  });

  it("sealed restore reuses slices without copying packed into the worker dir", async () => {
    const { snapshotDbPath } = await explodeOnce("data-seal");
    const workerDir = join(root, "worker-empty");
    mkdirSync(workerDir);
    const reused = await explodeRecallEvalWorkingCopyIfNeeded({
      dataDirRoot: workerDir,
      snapshotDbPath,
      requireReuse: true,
      env: { [SEALED_SLICE_RESTORE_ENV]: "1" }
    });
    expect(reused).not.toBeNull();
    expect(existsSync(join(workerDir, "alaya.db"))).toBe(false);
    expect(existsSync(packedWorkingDbPath(workerDir))).toBe(false);
    installWorkspaceSlice({
      dataDir: workerDir,
      sliceDbPath: reused!.sliceDbPaths[WORKSPACE_A]!
    });
    expect(existsSync(join(workerDir, "alaya.db"))).toBe(true);
    expect(existsSync(packedWorkingDbPath(workerDir))).toBe(false);
  });

  it("sealed restore refuses a missing cache without materializing packed in the worker dir", async () => {
    const snapshotDbPath = join(root, "snapshot-missing-cache.db");
    copyFileSync(packedPath, snapshotDbPath);
    const workerDir = join(root, "worker-missing-cache");
    mkdirSync(workerDir);
    await expect(explodeRecallEvalWorkingCopyIfNeeded({
      dataDirRoot: workerDir,
      snapshotDbPath,
      requireReuse: true,
      env: { [SEALED_SLICE_RESTORE_ENV]: "1" }
    })).rejects.toThrow(/reuse/u);
    expect(existsSync(join(workerDir, "alaya.db"))).toBe(false);
    expect(existsSync(packedWorkingDbPath(workerDir))).toBe(false);
  });
});

async function explodeOnce(dataDirName: string): Promise<{
  readonly snapshotDbPath: string;
  readonly sealedDir: string;
}> {
  const snapshotDbPath = join(root, "snapshot.db");
  if (!existsSync(snapshotDbPath)) {
    copyFileSync(packedPath, snapshotDbPath);
  }
  const dataDir = join(root, dataDirName);
  installWorkspaceSlice({ dataDir, sliceDbPath: snapshotDbPath });
  const first = await explodeRecallEvalWorkingCopyIfNeeded({
    dataDirRoot: dataDir,
    snapshotDbPath
  });
  expect(first).not.toBeNull();
  return { snapshotDbPath, sealedDir: sealedWorkspaceSliceCacheDir(snapshotDbPath) };
}

function patchSealedIdentity(
  sealedDir: string,
  patch: Record<string, unknown>
): void {
  const identityPath = join(sealedDir, "identity.json");
  const identity = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
  writeFileSync(identityPath, `${JSON.stringify({ ...identity, ...patch })}\n`);
}
