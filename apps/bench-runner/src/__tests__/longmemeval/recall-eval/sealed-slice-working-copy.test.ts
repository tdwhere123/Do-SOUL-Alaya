import { readFileSync, statSync } from "node:fs";
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
  explodePackedWorkingCopy,
  workingAlayaDbPath
} from "../../../runs/snapshot/recall-eval/workspace-slice/index.js";
import * as loadOpenModule from "../../../runs/snapshot/recall-eval/workspace-slice/load-open.js";
import {
  closeRecallEvalPagerChild,
  openRecallEvalPagerChild,
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

beforeEach(async () => {
  process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
  root = await mkdtemp(join(tmpdir(), "sealed-slice-working-copy-"));
  packedPath = join(root, "packed.alaya.db");
  await createPackedTwoWorkspaceDb(packedPath);
});

afterEach(async () => {
  await closeRecallEvalPagerChild().catch(() => undefined);
  closeCachedDatabase(packedPath);
  if (previousWriteQueue === undefined) {
    delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
  } else {
    process.env.ALAYA_SQLITE_WRITE_QUEUE = previousWriteQueue;
  }
  await removeTempDirectory(root);
});

function buildOpenPayload(dataDirRoot: string): RecallEvalPagerOpenPayload {
  const packedSha = hashRegularFileNoFollow(packedPath);
  return {
    dataDirRoot,
    daemonLaunch: createBenchDaemonLaunchConfig({
      dataDir: dataDirRoot,
      embeddingMode: "disabled",
      embeddingProviderKind: "local_onnx"
    }),
    recallWeightOverrides: undefined,
    options: {
      snapshotDbPath: packedPath,
      variant: "longmemeval_s" as const
    },
    manifest: {
      recall_pipeline_version: SNAPSHOT_SEED_IDENTITY,
      schema_migration_version: readSchemaMigrationVersion(packedPath),
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
    const destDir = join(root, "slices");
    const dataDirRoot = join(root, "data-child");
    const exploded = await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });

    const slicePathA = exploded.sliceDbPaths[WORKSPACE_A]!;
    const statBefore = statSync(slicePathA);
    const shaBefore = hashRegularFileNoFollow(slicePathA);
    const bytesBefore = readFileSync(slicePathA);

    await openRecallEvalPagerChild(buildOpenPayload(dataDirRoot));
    const result = await recallRecallEvalPagerChild(
      buildRecallPayload("q1", WORKSPACE_A, TOKEN_A)
    );
    expect(result).toBeDefined();

    // Verify EventLog on the working copy has appended entries
    const workingDb = initDatabase({ filename: workingAlayaDbPath(dataDirRoot) });
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
  });

  it("load-open ATTACH/DELETE sequence is never called on the pager question path", async () => {
    const destDir = join(root, "slices-load-open");
    const dataDirRoot = join(root, "data-no-load-open");
    await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });

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
    const destDir = join(root, "slices-seq");
    const dataDirRoot = join(root, "data-seq");
    await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });

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

    expect(hint2.alaya_db_mappings).toBeLessThanOrEqual(hint1.alaya_db_mappings);
    expect(hint3.alaya_db_mappings).toBeLessThanOrEqual(hint1.alaya_db_mappings);

    await closeRecallEvalPagerChild();
  });
});
