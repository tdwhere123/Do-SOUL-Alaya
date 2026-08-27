import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SNAPSHOT_SEED_IDENTITY } from "../../../../shared/version.js";
import { hashRegularFileNoFollow } from "../../bound-file.js";
import {
  explodePackedWorkingCopy,
  type ExplodedWorkspaceSlices
} from "./explode.js";
import { completeSlicesOrNull } from "./complete-slices.js";
import {
  packedWorkingDbPath,
  preservePackedWorkingCopy
} from "./install.js";
import {
  WORKSPACE_SLICE_EXPLODE_RECIPE_ID,
  WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION
} from "./slice-snapshot.js";
import type { WorkspaceSliceProgress } from "./stream-copy.js";

export const SEALED_SLICE_CACHE_IDENTITY_FILENAME = "identity.json";

export function sealedWorkspaceSliceCacheDir(snapshotDbPath: string): string {
  return `${snapshotDbPath}.workspace-slices`;
}

export async function reuseOrExplodeSealedSlices(input: {
  readonly snapshotDbPath: string;
  readonly packedDbPath: string;
  readonly workspaceIds: readonly string[];
  readonly requireReuse: boolean;
  readonly onProgress?: (progress: WorkspaceSliceProgress) => void;
}): Promise<ExplodedWorkspaceSlices> {
  const destDir = sealedWorkspaceSliceCacheDir(input.snapshotDbPath);
  const packedSha = hashRegularFileNoFollow(input.packedDbPath);
  const snapshotSha = hashRegularFileNoFollow(input.snapshotDbPath);
  const reused = completeSlicesOrNull(input.packedDbPath, destDir, input.workspaceIds);
  const identity = readSealedSliceIdentity(destDir);
  if (reused !== null && identityMatches(identity, packedSha, snapshotSha, reused)) {
    return reused;
  }
  if (identity !== null) {
    // A drifted cache must not explode: a stale slice would still score.
    throw new Error(
      "[recall-eval] sealed workspace slice identity drifted; refuse reuse"
    );
  }
  if (input.requireReuse) {
    throw new Error(
      "[recall-eval] sealed workspace-slice reuse is required and the cache is missing or drifted"
    );
  }
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  const exploded = await explodePackedWorkingCopy({
    packedDbPath: input.packedDbPath,
    destDir,
    workspaceIds: input.workspaceIds,
    onProgress: input.onProgress
  });
  writeSealedSliceIdentity(destDir, exploded, packedSha, snapshotSha);
  return exploded;
}

function identityMatches(
  identity: SealedSliceCacheIdentity | null,
  packedSha: string,
  snapshotSha: string,
  reused: ExplodedWorkspaceSlices
): boolean {
  if (identity === null) return false;
  return identity.packed_db_sha256 === packedSha &&
    identity.snapshot_db_sha256 === snapshotSha &&
    identity.recipe_id === WORKSPACE_SLICE_EXPLODE_RECIPE_ID &&
    identity.recipe_version === WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION &&
    identity.seed_identity === SNAPSHOT_SEED_IDENTITY &&
    sameStringList(identity.workspace_ids, reused.workspaceIds) &&
    sameDigestMap(identity.slice_snapshot_digests, reused.sliceSnapshotDigests);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameDigestMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key]);
}

interface SealedSliceCacheIdentity {
  readonly schema_version: 1;
  readonly packed_db_sha256: string;
  readonly snapshot_db_sha256: string;
  readonly recipe_id: string;
  readonly recipe_version: string;
  readonly seed_identity: string;
  readonly workspace_ids: readonly string[];
  readonly slice_snapshot_digests: Readonly<Record<string, string>>;
}

function readSealedSliceIdentity(destDir: string): SealedSliceCacheIdentity | null {
  const path = join(destDir, SEALED_SLICE_CACHE_IDENTITY_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return parseSealedSliceIdentity(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    throw new Error(
      "[recall-eval] sealed workspace slice identity drifted; refuse reuse"
    );
  }
}

function parseSealedSliceIdentity(value: unknown): SealedSliceCacheIdentity {
  if (!isRecord(value) ||
      value.schema_version !== 1 ||
      !isSha256Hex(value.packed_db_sha256) ||
      !isSha256Hex(value.snapshot_db_sha256) ||
      value.recipe_id !== WORKSPACE_SLICE_EXPLODE_RECIPE_ID ||
      typeof value.recipe_version !== "string" ||
      typeof value.seed_identity !== "string" ||
      !Array.isArray(value.workspace_ids) ||
      !value.workspace_ids.every((id) => typeof id === "string") ||
      !isStringRecord(value.slice_snapshot_digests)) {
    throw new Error("sealed workspace slice identity is invalid");
  }
  return Object.freeze({
    schema_version: 1,
    packed_db_sha256: value.packed_db_sha256,
    snapshot_db_sha256: value.snapshot_db_sha256,
    recipe_id: value.recipe_id,
    recipe_version: value.recipe_version,
    seed_identity: value.seed_identity,
    workspace_ids: Object.freeze([...value.workspace_ids]),
    slice_snapshot_digests: Object.freeze({ ...value.slice_snapshot_digests })
  });
}

function writeSealedSliceIdentity(
  destDir: string,
  exploded: ExplodedWorkspaceSlices,
  packedSha: string,
  snapshotSha: string
): void {
  const path = join(destDir, SEALED_SLICE_CACHE_IDENTITY_FILENAME);
  mkdirSync(destDir, { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({
    schema_version: 1,
    packed_db_sha256: packedSha,
    snapshot_db_sha256: snapshotSha,
    recipe_id: WORKSPACE_SLICE_EXPLODE_RECIPE_ID,
    recipe_version: WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION,
    seed_identity: SNAPSHOT_SEED_IDENTITY,
    workspace_ids: exploded.workspaceIds,
    slice_snapshot_digests: exploded.sliceSnapshotDigests
  } satisfies SealedSliceCacheIdentity)}\n`);
  renameSync(tmpPath, path);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function resolvePackedWorkingCopy(dataDirRoot: string): string {
  const packed = packedWorkingDbPath(dataDirRoot);
  if (existsSync(packed)) return packed;
  return preservePackedWorkingCopy(dataDirRoot);
}
