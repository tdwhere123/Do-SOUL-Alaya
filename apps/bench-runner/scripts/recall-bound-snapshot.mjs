// Reuse the ordinary snapshot owner so every offline reader sees the originally sealed file.
import { hashRegularFileNoFollow, withCachedSqliteSnapshot } from "../dist/runs/snapshot/bound-file.js";

export function withRecallSnapshot(row, operation) {
  if (typeof row.snapshot_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.snapshot_sha256)) {
    throw new Error("captured snapshot digest is unavailable");
  }
  if (hashRegularFileNoFollow(row.snapshot) !== row.snapshot_sha256) throw new Error("captured snapshot digest changed");
  return withCachedSqliteSnapshot({ filePath: row.snapshot, expectedSha256: row.snapshot_sha256, operation });
}
