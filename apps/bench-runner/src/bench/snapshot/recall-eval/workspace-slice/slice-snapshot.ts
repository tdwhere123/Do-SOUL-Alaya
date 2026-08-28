import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { hashRegularFileNoFollow } from "../../bound-file.js";

export const WORKSPACE_SLICE_SQLITE_KIND = "alaya.bench.workspace_slice_sqlite";
export const WORKSPACE_SLICE_EXPLODE_RECIPE_ID = "alaya.bench.workspace-slice-explode";
export const WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION = "v1";
export const WORKSPACE_SLICE_SNAPSHOT_SIDECAR_FILENAME = "workspace-slice-snapshot.json";

export type WorkspaceSliceSnapshotReceipt = Readonly<{
  readonly schema_version: 1;
  readonly kind: typeof WORKSPACE_SLICE_SQLITE_KIND;
  readonly recipe_id: typeof WORKSPACE_SLICE_EXPLODE_RECIPE_ID;
  readonly recipe_version: string;
  readonly workspace_id: string;
  readonly sqlite_main_file_sha256: string;
  readonly snapshot_digest: RecallFieldDigest;
}>;

export function digestWorkspaceSliceSnapshotIdentity(input: Readonly<{
  readonly workspaceId: string;
  readonly sqliteMainFileSha256: string;
  readonly recipeVersion?: string;
}>): RecallFieldDigest {
  return digestRecallFieldIdentity({
    kind: WORKSPACE_SLICE_SQLITE_KIND,
    recipe_id: WORKSPACE_SLICE_EXPLODE_RECIPE_ID,
    recipe_version: input.recipeVersion ?? WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION,
    sqlite_main_file_sha256: input.sqliteMainFileSha256,
    workspace_id: input.workspaceId
  });
}

export function sealFinalizedWorkspaceSlice(dest: Readonly<{
  readonly workspaceId: string;
  readonly dbPath: string;
  readonly database: StorageDatabase;
}>): RecallFieldDigest {
  if (dest.database.isClosed()) {
    throw new Error("cannot seal workspace slice: database is already closed");
  }
  truncateWalOrThrow(dest.database);
  dest.database.close({ optimize: false });
  return persistWorkspaceSliceSnapshot(dest.workspaceId, dest.dbPath);
}

export function readValidWorkspaceSliceSnapshotDigest(input: Readonly<{
  readonly workspaceId: string;
  readonly dbPath: string;
}>): RecallFieldDigest | null {
  return readValidWorkspaceSliceSnapshotReceipt(input)?.snapshot_digest ?? null;
}

export function readValidWorkspaceSliceSnapshotReceipt(input: Readonly<{
  readonly workspaceId: string;
  readonly dbPath: string;
}>): WorkspaceSliceSnapshotReceipt | null {
  const receipt = readWorkspaceSliceSnapshotReceipt(sidecarPath(input.dbPath));
  if (receipt === null) return null;
  try {
    assertQuiescentMainDb(input.dbPath);
    assertMatchingWorkspaceSliceSnapshot(
      receipt,
      input.workspaceId,
      hashRegularFileNoFollow(input.dbPath)
    );
    return receipt;
  } catch {
    return null;
  }
}

function persistWorkspaceSliceSnapshot(
  workspaceId: string,
  dbPath: string
): RecallFieldDigest {
  assertQuiescentMainDb(dbPath);
  const sqliteMainFileSha256 = hashRegularFileNoFollow(dbPath);
  const snapshotDigest = digestWorkspaceSliceSnapshotIdentity({
    workspaceId,
    sqliteMainFileSha256
  });
  writeFileSync(sidecarPath(dbPath), `${JSON.stringify({
    schema_version: 1,
    kind: WORKSPACE_SLICE_SQLITE_KIND,
    recipe_id: WORKSPACE_SLICE_EXPLODE_RECIPE_ID,
    recipe_version: WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION,
    workspace_id: workspaceId,
    sqlite_main_file_sha256: sqliteMainFileSha256,
    snapshot_digest: snapshotDigest
  } satisfies WorkspaceSliceSnapshotReceipt)}\n`);
  return snapshotDigest;
}

export function assertQuiescentMainDb(dbPath: string): void {
  const walPath = `${dbPath}-wal`;
  if (existsSync(walPath) && statSync(walPath).size > 0) {
    throw new Error("cannot seal workspace slice: leftover WAL");
  }
  // Leftover -shm is the WAL-index sidecar. After TRUNCATE+close it may remain;
  // it is not part of the main-file preimage, so it cannot change the digest.
}

function truncateWalOrThrow(database: StorageDatabase): void {
  const [checkpoint] = database.connection.pragma("wal_checkpoint(TRUNCATE)") as Array<{
    readonly busy: number;
    readonly log: number;
    readonly checkpointed: number;
  }>;
  if (checkpoint === undefined || checkpoint.busy !== 0 ||
      checkpoint.log !== checkpoint.checkpointed) {
    const detail = checkpoint === undefined
      ? "missing checkpoint status"
      : `busy=${checkpoint.busy} log=${checkpoint.log} checkpointed=${checkpoint.checkpointed}`;
    throw new Error(`cannot seal workspace slice: incomplete WAL checkpoint (${detail})`);
  }
}

function sidecarPath(dbPath: string): string {
  return join(dirname(dbPath), WORKSPACE_SLICE_SNAPSHOT_SIDECAR_FILENAME);
}

function readWorkspaceSliceSnapshotReceipt(
  path: string
): WorkspaceSliceSnapshotReceipt | null {
  if (!existsSync(path)) return null;
  try {
    return parseWorkspaceSliceSnapshotReceipt(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function parseWorkspaceSliceSnapshotReceipt(value: unknown): WorkspaceSliceSnapshotReceipt {
  if (!isRecord(value) ||
      value.schema_version !== 1 ||
      value.kind !== WORKSPACE_SLICE_SQLITE_KIND ||
      value.recipe_id !== WORKSPACE_SLICE_EXPLODE_RECIPE_ID ||
      typeof value.recipe_version !== "string" ||
      typeof value.workspace_id !== "string" ||
      typeof value.sqlite_main_file_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.sqlite_main_file_sha256) ||
      typeof value.snapshot_digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.snapshot_digest)) {
    throw new Error("workspace slice snapshot sidecar is invalid");
  }
  return Object.freeze({
    schema_version: 1,
    kind: WORKSPACE_SLICE_SQLITE_KIND,
    recipe_id: WORKSPACE_SLICE_EXPLODE_RECIPE_ID,
    recipe_version: value.recipe_version,
    workspace_id: value.workspace_id,
    sqlite_main_file_sha256: value.sqlite_main_file_sha256,
    snapshot_digest: value.snapshot_digest as RecallFieldDigest
  });
}

function assertMatchingWorkspaceSliceSnapshot(
  receipt: WorkspaceSliceSnapshotReceipt,
  workspaceId: string,
  sqliteMainFileSha256: string
): void {
  if (receipt.recipe_version !== WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION ||
      receipt.workspace_id !== workspaceId ||
      receipt.sqlite_main_file_sha256 !== sqliteMainFileSha256) {
    throw new Error("workspace slice snapshot sidecar does not match");
  }
  const expected = digestWorkspaceSliceSnapshotIdentity({
    workspaceId,
    sqliteMainFileSha256
  });
  if (receipt.snapshot_digest !== expected) {
    throw new Error("workspace slice snapshot sidecar digest mismatch");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
