import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { snapshotSidecarPath } from "../snapshot.js";

export interface SnapshotArtifactIntegrity {
  readonly db_sha256: string;
  readonly sidecar_sha256: string;
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
  return Object.freeze({ db_sha256: dbSha, sidecar_sha256: sidecarSha });
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
}
