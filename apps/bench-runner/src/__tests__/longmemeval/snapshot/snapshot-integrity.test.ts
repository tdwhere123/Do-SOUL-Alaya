import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSnapshotArtifactIntegrity,
  verifySnapshotArtifactIntegrity
} from "../../../longmemeval/snapshot/integrity.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("snapshot artifact integrity", () => {
  it("binds the frozen DB and sidecar bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "snapshot-integrity-"));
    roots.push(root);
    const dbPath = join(root, "snapshot.db");
    const sidecarPath = `${dbPath}.sidecar.json`;
    await writeFile(dbPath, "db-v1", "utf8");
    await writeFile(sidecarPath, "sidecar-v1", "utf8");

    const integrity = await buildSnapshotArtifactIntegrity(dbPath);
    expect(integrity.db_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(integrity.sidecar_sha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(verifySnapshotArtifactIntegrity(dbPath, integrity)).resolves.toBeUndefined();

    await writeFile(sidecarPath, "tampered", "utf8");
    await expect(verifySnapshotArtifactIntegrity(dbPath, integrity)).rejects.toThrow(
      /sidecar SHA-256 mismatch/u
    );
  });
});
