import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSnapshotArtifactIntegrity,
  sha256File,
  verifySnapshotArtifactIntegrity
} from "../../../bench/snapshot/integrity.js";
import { peekCachedFileSha256 } from "../../../bench/snapshot/bound-file.js";

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

  it("remembers a sealed digest until size or mtime changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "snapshot-integrity-cache-"));
    roots.push(root);
    const dbPath = join(root, "snapshot.db");
    await writeFile(dbPath, "db-v1", "utf8");

    const first = await sha256File(dbPath);
    expect(peekCachedFileSha256(dbPath)).toBe(first);
    expect(await sha256File(dbPath)).toBe(first);

    await writeFile(dbPath, "db-v2-longer", "utf8");
    expect(peekCachedFileSha256(dbPath)).toBeUndefined();
    expect(await sha256File(dbPath)).not.toBe(first);
  });

  it("rejects symlinked artifacts and detects inode replacement with preserved metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "snapshot-integrity-no-follow-"));
    roots.push(root);
    const dbPath = join(root, "snapshot.db");
    const replacement = join(root, "replacement.db");
    const symlinkPath = join(root, "snapshot-link.db");
    await writeFile(dbPath, "db-v1", "utf8");
    const first = await sha256File(dbPath);
    await writeFile(replacement, "db-v2", "utf8");
    await rename(replacement, dbPath);
    expect(await sha256File(dbPath)).not.toBe(first);
    await symlink(dbPath, symlinkPath);
    await expect(sha256File(symlinkPath)).rejects.toThrow();
  });
});
