import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { basename } from "node:path";
import {
  snapshotExtractionAuthorityPath,
  snapshotSidecarPath
} from "./materialize.js";
import { readRegularFileNoFollow, sha256Buffer } from "./bound-file.js";
import { MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES } from
  "./extraction-authority.js";

export interface SnapshotArtifactIntegrity {
  readonly db_sha256: string;
  readonly sidecar_sha256: string;
  readonly extraction_authority_filename?: string;
  readonly extraction_authority_sha256?: string;
  readonly extraction_authority_bytes?: number;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function buildSnapshotArtifactIntegrity(
  snapshotDbPath: string
): Promise<SnapshotArtifactIntegrity> {
  const [dbSha, sidecarSha] = await Promise.all([
    sha256File(snapshotDbPath),
    sha256File(snapshotSidecarPath(snapshotDbPath))
  ]);
  const authorityPath = snapshotExtractionAuthorityPath(snapshotDbPath);
  const authority = existsSync(authorityPath)
    ? readRegularFileNoFollow(authorityPath, MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES)
    : undefined;
  return Object.freeze({
    db_sha256: dbSha,
    sidecar_sha256: sidecarSha,
    ...(authority === undefined ? {} : {
      extraction_authority_filename: basename(authorityPath),
      extraction_authority_sha256: sha256Buffer(authority),
      extraction_authority_bytes: authority.byteLength
    })
  });
}

export async function verifySnapshotArtifactIntegrity(
  snapshotDbPath: string,
  expected: SnapshotArtifactIntegrity
): Promise<void> {
  const actual = await buildSnapshotArtifactIntegrity(snapshotDbPath);
  if (actual.db_sha256 !== expected.db_sha256) {
    throw new Error("recall-eval snapshot DB SHA-256 mismatch");
  }
  if (actual.sidecar_sha256 !== expected.sidecar_sha256) {
    throw new Error("recall-eval snapshot sidecar SHA-256 mismatch");
  }
  if (expected.extraction_authority_sha256 !== undefined && (
    actual.extraction_authority_filename !== expected.extraction_authority_filename ||
    actual.extraction_authority_sha256 !== expected.extraction_authority_sha256 ||
    actual.extraction_authority_bytes !== expected.extraction_authority_bytes
  )) {
    throw new Error("recall-eval snapshot extraction authority mismatch");
  }
}
