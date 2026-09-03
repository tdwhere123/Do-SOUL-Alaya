import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeCachedDatabase } from "@do-soul/alaya-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPackedTwoWorkspaceDb,
  TOKEN_A,
  TOKEN_B,
  WORKSPACE_A,
  WORKSPACE_B
} from "./workspace-slice-fixture.js";
import {
  explodeRecallEvalWorkingCopyIfNeeded,
  installWorkspaceSlice,
  SEALED_SLICE_RESTORE_ENV,
  SKIP_WORKSPACE_SLICE_ENV,
  workingAlayaDbPath,
  type ExplodedWorkspaceSlices
} from "../../../runs/snapshot/recall-eval/workspace-slice/index.js";
import * as loadOpenModule from "../../../runs/snapshot/recall-eval/workspace-slice/load-open.js";
import {
  closeRecallEvalPagerChild,
  openRecallEvalPagerChild,
  pagerSwitchWorkingDataDir,
  recallRecallEvalPagerChild
} from "../../../runs/lifecycle/recall-eval/recall-eval-process/child-runtime.js";
import { readRecallEvalPagerMapsHint } from "../../../runs/lifecycle/recall-eval/recall-eval-process/maps-hint.js";
import { createBenchDaemonLaunchConfig } from "../../../harness/daemon/daemon-environment.js";
import {
  hashRegularFileNoFollow
} from "../../../runs/snapshot/bound-file.js";
import { readSchemaMigrationVersion } from "../../../runs/snapshot/snapshot-seed-identity.js";
import { SNAPSHOT_SEED_IDENTITY } from "../../../shared/version.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import type {
  LongMemEvalSnapshotManifest,
  LongMemEvalSnapshotQuestion
} from "../../../runs/snapshot/materialize.js";
import type {
  RecallEvalPagerOpenPayload,
  RecallEvalPagerRecallPayload
} from "../../../runs/lifecycle/recall-eval/recall-eval-process/payload.js";

const previousWriteQueue = process.env.ALAYA_SQLITE_WRITE_QUEUE;

let root: string;
let packedPath: string;
let snapshotDbPath: string;
let sealedSlices: ExplodedWorkspaceSlices;

beforeEach(async () => {
  process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
  process.env[SEALED_SLICE_RESTORE_ENV] = "1";
  root = await mkdtemp(join(tmpdir(), "sealed-slice-working-copy-"));
  packedPath = join(root, "packed.alaya.db");
  await createPackedTwoWorkspaceDb(packedPath);
  snapshotDbPath = join(root, "snapshot.db");
  copyFileSync(packedPath, snapshotDbPath);
  const initDir = join(root, "init-explode");
  installWorkspaceSlice({ dataDir: initDir, sliceDbPath: snapshotDbPath });
  const first = await explodeRecallEvalWorkingCopyIfNeeded({
    dataDirRoot: initDir,
    snapshotDbPath,
    env: { [SEALED_SLICE_RESTORE_ENV]: "0" }
  });
  if (first === null) throw new Error("failed to explode test slices");
  sealedSlices = first;
});

afterEach(async () => {
  delete process.env[SEALED_SLICE_RESTORE_ENV];
  delete process.env[SKIP_WORKSPACE_SLICE_ENV];
  await closeRecallEvalPagerChild().catch(() => undefined);
  closeCachedDatabase(packedPath);
  closeCachedDatabase(snapshotDbPath);
  if (previousWriteQueue === undefined) {
    delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
  } else {
    process.env.ALAYA_SQLITE_WRITE_QUEUE = previousWriteQueue;
  }
  await removeTempDirectory(root);
});

function buildOpenPayload(dataDirRoot: string): RecallEvalPagerOpenPayload {
  const packedSha = hashRegularFileNoFollow(snapshotDbPath);
  return {
    dataDirRoot,
    daemonLaunch: createBenchDaemonLaunchConfig({
      dataDir: dataDirRoot,
      embeddingMode: "disabled",
      embeddingProviderKind: "local_onnx"
    }),
    recallWeightOverrides: undefined,
    options: {
      snapshotDbPath,
      historyRoot: join(dataDirRoot, "history"),
      variant: "longmemeval_s" as const
    },
    manifest: {
      recall_pipeline_version: SNAPSHOT_SEED_IDENTITY,
      schema_migration_version: readSchemaMigrationVersion(snapshotDbPath),
      artifact_integrity: {
        db_sha256: packedSha,
        manifest_sha256: "manifest-stub-sha"
      }
    } as unknown as LongMemEvalSnapshotManifest,
    overlayExpected: undefined,
    sourceExtractionSystemPromptSha256: undefined,
    embeddingMode: "disabled",
    simulateReport: "none",
    captureOpenSemanticFactorCandidateActivations: false
  };
}

function buildRecallPayload(
  questionId: string,
  workspaceId: string,
  token: string
): RecallEvalPagerRecallPayload {
  return {
    question: {
      questionId,
      workspaceId,
      runId: `run-${questionId}`,
      question: token,
      questionDate: "2026-08-10T00:00:00.000Z",
      sidecar: [],
      answerSessionIds: []
    } as unknown as LongMemEvalSnapshotQuestion,
    turnIndex: 1,
    recallOptions: { maxResults: 10 },
    measurement: undefined
  };
}

describe("H02 — sealed slice private working copy", () => {
  it("sealed source inode and bytes are unchanged after a recall that appends EventLog on the working copy", async () => {
    const dataDirRoot = join(root, "data-child");
    const slicePathA = sealedSlices.sliceDbPaths[WORKSPACE_A]!;
    const statBefore = statSync(slicePathA);
    const shaBefore = hashRegularFileNoFollow(slicePathA);
    const bytesBefore = readFileSync(slicePathA);

    await openRecallEvalPagerChild(buildOpenPayload(dataDirRoot));
    const result = await recallRecallEvalPagerChild(
      buildRecallPayload("q1", WORKSPACE_A, TOKEN_A)
    );
    expect(result).toBeDefined();

    const workingDb = initDatabase({
      filename: workingAlayaDbPath(
        pagerSwitchWorkingDataDir(dataDirRoot, 1, WORKSPACE_A)
      )
    });
    try {
      const row = workingDb.connection.prepare(
        "SELECT COUNT(*) AS count FROM event_log WHERE event_type = 'soul.recall.completed'"
      ).get() as { count: number };
      expect(row.count).toBeGreaterThanOrEqual(1);
    } finally {
      workingDb.close();
    }

    // Verify sealed slice source inode, size, mtime, and bytes are completely unchanged
    const statAfter = statSync(slicePathA);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(hashRegularFileNoFollow(slicePathA)).toBe(shaBefore);
    expect(readFileSync(slicePathA)).toEqual(bytesBefore);

    await closeRecallEvalPagerChild();
  }, 15_000);

  it("load-open ATTACH/DELETE sequence is never called on the pager question path", async () => {
    const dataDirRoot = join(root, "data-no-load-open");
    const spy = vi.spyOn(loadOpenModule, "loadSliceIntoOpenDatabase");

    await openRecallEvalPagerChild(buildOpenPayload(dataDirRoot));
    await recallRecallEvalPagerChild(
      buildRecallPayload("q1", WORKSPACE_A, TOKEN_A)
    );
    await recallRecallEvalPagerChild(
      buildRecallPayload("q2", WORKSPACE_B, TOKEN_B)
    );

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    await closeRecallEvalPagerChild();
  });

  it("serves sequential questions across workspaces without accumulating alaya.db mappings", async () => {
    const dataDirRoot = join(root, "data-seq");

    await openRecallEvalPagerChild(buildOpenPayload(dataDirRoot));

    await recallRecallEvalPagerChild(
      buildRecallPayload("q1", WORKSPACE_A, TOKEN_A)
    );
    const hint1 = readRecallEvalPagerMapsHint(process.pid);

    await recallRecallEvalPagerChild(
      buildRecallPayload("q2", WORKSPACE_B, TOKEN_B)
    );
    const hint2 = readRecallEvalPagerMapsHint(process.pid);

    await recallRecallEvalPagerChild(
      buildRecallPayload("q3", WORKSPACE_A, TOKEN_A)
    );
    const hint3 = readRecallEvalPagerMapsHint(process.pid);

    if (hint1 === null || hint2 === null || hint3 === null) {
      expect(hint1).toBeNull();
      expect(hint2).toBeNull();
      expect(hint3).toBeNull();
    } else {
      expect(hint1.alaya_db_mappings).toBeGreaterThanOrEqual(1);
      expect(hint2.alaya_db_mappings).toBeGreaterThanOrEqual(1);
      expect(hint3.alaya_db_mappings).toBeGreaterThanOrEqual(1);
      expect(hint2.alaya_db_mappings).toBeLessThanOrEqual(hint1.alaya_db_mappings);
      expect(hint3.alaya_db_mappings).toBeLessThanOrEqual(hint1.alaya_db_mappings);
    }

    await closeRecallEvalPagerChild();
  });

  it("recycled child respawn against existing dataDirRoot never calls loadSliceIntoOpenDatabase", async () => {
    const dataDirRoot = join(root, "data-respawn");
    const spy = vi.spyOn(loadOpenModule, "loadSliceIntoOpenDatabase");

    // Question 1 in first child process
    await openRecallEvalPagerChild(buildOpenPayload(dataDirRoot));
    await recallRecallEvalPagerChild(
      buildRecallPayload("q1", WORKSPACE_A, TOKEN_A)
    );
    await closeRecallEvalPagerChild();

    // Question 2 in recycled child process against the SAME dataDirRoot
    await openRecallEvalPagerChild(buildOpenPayload(dataDirRoot));
    await recallRecallEvalPagerChild(
      buildRecallPayload("q2", WORKSPACE_B, TOKEN_B)
    );
    await closeRecallEvalPagerChild();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("sequential questions targeting the same workspace reset working copy cleanly without dirty state leak", async () => {
    const dataDirRoot = join(root, "data-same-ws");

    await openRecallEvalPagerChild(buildOpenPayload(dataDirRoot));

    // Question 1 in WORKSPACE_A
    await recallRecallEvalPagerChild(
      buildRecallPayload("q1", WORKSPACE_A, TOKEN_A)
    );

    // Question 2 in SAME WORKSPACE_A without process recycle
    await recallRecallEvalPagerChild(
      buildRecallPayload("q2", WORKSPACE_A, TOKEN_A)
    );

    const workingDb = initDatabase({
      filename: workingAlayaDbPath(
        pagerSwitchWorkingDataDir(dataDirRoot, 2, WORKSPACE_A)
      )
    });
    try {
      const row = workingDb.connection.prepare(
        "SELECT COUNT(*) AS count FROM event_log WHERE event_type = 'soul.recall.completed'"
      ).get() as { count: number };
      expect(row.count).toBe(1);
    } finally {
      workingDb.close();
    }

    await closeRecallEvalPagerChild();
  });

  it("path-switch with slices=null still produces a working alaya.db", async () => {
    delete process.env[SEALED_SLICE_RESTORE_ENV];
    process.env[SKIP_WORKSPACE_SLICE_ENV] = "1";
    const dataDirRoot = join(root, "data-null-slices");
    mkdirSync(dataDirRoot, { recursive: true });
    copyFileSync(snapshotDbPath, workingAlayaDbPath(dataDirRoot));
    const spy = vi.spyOn(loadOpenModule, "loadSliceIntoOpenDatabase");

    await openRecallEvalPagerChild(buildOpenPayload(dataDirRoot));
    const result = await recallRecallEvalPagerChild(
      buildRecallPayload("q1", WORKSPACE_A, TOKEN_A)
    );
    expect(result).toBeDefined();
    expect(existsSync(workingAlayaDbPath(
      pagerSwitchWorkingDataDir(dataDirRoot, 1, WORKSPACE_A)
    ))).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    await closeRecallEvalPagerChild();
  }, 15_000);

  it("path-switch with slices=null fails closed when the working copy is missing", async () => {
    delete process.env[SEALED_SLICE_RESTORE_ENV];
    process.env[SKIP_WORKSPACE_SLICE_ENV] = "1";
    const dataDirRoot = join(root, "data-null-slices-missing");
    mkdirSync(dataDirRoot, { recursive: true });
    copyFileSync(snapshotDbPath, workingAlayaDbPath(dataDirRoot));

    await openRecallEvalPagerChild(buildOpenPayload(dataDirRoot));
    const source = workingAlayaDbPath(dataDirRoot);
    closeCachedDatabase(source);
    rmSync(source, { force: true });

    await expect(recallRecallEvalPagerChild(
      buildRecallPayload("q1", WORKSPACE_A, TOKEN_A)
    )).rejects.toThrow(/pager working copy is missing/);
    expect(existsSync(workingAlayaDbPath(
      pagerSwitchWorkingDataDir(dataDirRoot, 1, WORKSPACE_A)
    ))).toBe(false);

    await closeRecallEvalPagerChild();
  });
});
