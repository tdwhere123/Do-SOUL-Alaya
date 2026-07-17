import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindCurrentSnapshotArtifacts } from
  "../../../longmemeval/snapshot/current/current-bound-artifacts.js";
import {
  currentSnapshotExtractionAuthority,
  currentSnapshotManifestFor,
  currentSnapshotSidecarFor
} from "./current-snapshot-fixture.js";
import { renderSnapshotExtractionAuthority } from
  "../../../longmemeval/snapshot/extraction-authority.js";
import {
  MAX_SNAPSHOT_MANIFEST_BYTES,
  MAX_SNAPSHOT_SIDECAR_BYTES
} from "../../../longmemeval/snapshot/artifact-limits.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("current snapshot immutable artifact binding", () => {
  it("keeps consuming the owned copies after every source path is replaced", async () => {
    const fixture = await snapshotFixture();
    const original = await Promise.all([
      readFile(fixture.snapshotDbPath),
      readFile(`${fixture.snapshotDbPath}.manifest.json`),
      readFile(`${fixture.snapshotDbPath}.sidecar.json`),
      readFile(`${fixture.snapshotDbPath}.extraction-authority.json`)
    ]);

    const bound = bindCurrentSnapshotArtifacts({
      sourceDbPath: fixture.snapshotDbPath,
      targetRoot: fixture.targetRoot
    });
    await Promise.all([
      writeFile(fixture.snapshotDbPath, "replacement DB", "utf8"),
      writeFile(`${fixture.snapshotDbPath}.manifest.json`, "{}", "utf8"),
      writeFile(`${fixture.snapshotDbPath}.sidecar.json`, "{}", "utf8"),
      writeFile(`${fixture.snapshotDbPath}.extraction-authority.json`, "{}", "utf8")
    ]);

    expect(await readFile(bound.snapshotDbPath)).toEqual(original[0]);
    expect(await readFile(`${bound.snapshotDbPath}.manifest.json`)).toEqual(original[1]);
    expect(await readFile(`${bound.snapshotDbPath}.sidecar.json`)).toEqual(original[2]);
    expect(await readFile(`${bound.snapshotDbPath}.extraction-authority.json`))
      .toEqual(original[3]);
    expect(bound.manifestSha256).toBe(sha256(original[1]!));
  });

  it("rejects a symlinked current snapshot DB instead of following it", async () => {
    const fixture = await snapshotFixture();
    const referent = join(fixture.root, "referent.db");
    await writeFile(referent, await readFile(fixture.snapshotDbPath));
    await rm(fixture.snapshotDbPath);
    await symlink(referent, fixture.snapshotDbPath);

    expect(() => bindCurrentSnapshotArtifacts({
      sourceDbPath: fixture.snapshotDbPath,
      targetRoot: fixture.targetRoot
    })).toThrow();
  });

  it.each(["missing", "replacement", "symlink"] as const)(
    "rejects a %s extraction authority artifact",
    async (kind) => {
      const fixture = await snapshotFixture();
      const authorityPath = `${fixture.snapshotDbPath}.extraction-authority.json`;
      if (kind === "missing") await rm(authorityPath);
      if (kind === "replacement") await writeFile(authorityPath, "{}", "utf8");
      if (kind === "symlink") {
        const referent = join(fixture.root, "authority-referent.json");
        await writeFile(referent, await readFile(authorityPath));
        await rm(authorityPath);
        await symlink(referent, authorityPath);
      }

      expect(() => bindCurrentSnapshotArtifacts({
        sourceDbPath: fixture.snapshotDbPath,
        targetRoot: fixture.targetRoot
      })).toThrow();
    }
  );

  it("rejects run compact closure drift against unchanged authority", async () => {
    const fixture = await snapshotFixture();
    const manifestPath = `${fixture.snapshotDbPath}.manifest.json`;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      run_provenance: { extraction_cache: { content_closure_sha256: string } };
    };
    manifest.run_provenance.extraction_cache.content_closure_sha256 = "f".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    expect(() => bindCurrentSnapshotArtifacts({
      sourceDbPath: fixture.snapshotDbPath,
      targetRoot: fixture.targetRoot
    })).toThrow(/attribution|compact summary differs|overclaims gate eligibility/u);
  });

  it.each([
    ["manifest", ".manifest.json", MAX_SNAPSHOT_MANIFEST_BYTES],
    ["sidecar", ".sidecar.json", MAX_SNAPSHOT_SIDECAR_BYTES]
  ] as const)("rejects an oversized %s before reading it", async (_label, suffix, limit) => {
    const fixture = await snapshotFixture();
    await truncate(`${fixture.snapshotDbPath}${suffix}`, limit + 1);

    expect(() => bindCurrentSnapshotArtifacts({
      sourceDbPath: fixture.snapshotDbPath,
      targetRoot: fixture.targetRoot
    })).toThrow(/exceeds its size budget/u);
  });
});

async function snapshotFixture() {
  const root = await mkdtemp(join(tmpdir(), "current-bound-snapshot-"));
  roots.push(root);
  const targetRoot = join(root, "bound");
  await mkdir(targetRoot);
  const snapshotDbPath = join(root, "snapshot.db");
  const dbBytes = Buffer.from("trusted current snapshot DB", "utf8");
  const sidecarBytes = Buffer.from(
    `${JSON.stringify(currentSnapshotSidecarFor("q-1"), null, 2)}\n`,
    "utf8"
  );
  const authorityBytes = renderSnapshotExtractionAuthority(
    currentSnapshotExtractionAuthority()
  );
  const manifest = currentSnapshotManifestFor("q-1", {
    db_sha256: sha256(dbBytes),
    sidecar_sha256: sha256(sidecarBytes),
    extraction_authority_filename: "snapshot.db.extraction-authority.json",
    extraction_authority_sha256: sha256(authorityBytes),
    extraction_authority_bytes: authorityBytes.byteLength
  });
  await Promise.all([
    writeFile(snapshotDbPath, dbBytes),
    writeFile(`${snapshotDbPath}.sidecar.json`, sidecarBytes),
    writeFile(`${snapshotDbPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(`${snapshotDbPath}.extraction-authority.json`, authorityBytes)
  ]);
  return { root, targetRoot, snapshotDbPath };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
