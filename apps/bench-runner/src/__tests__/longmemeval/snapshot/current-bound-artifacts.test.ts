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
import { initDatabase } from "@do-soul/alaya-storage";
import { bindCurrentSnapshotArtifacts } from
  "../../../runs/snapshot/current/current-bound-artifacts.js";
import {
  currentSnapshotExtractionAuthority,
  currentSnapshotManifestFor,
  currentSnapshotSidecarFor
} from "./current-snapshot-fixture.js";
import { renderSnapshotExtractionAuthority } from
  "../../../runs/snapshot/extraction-authority.js";
import {
  MAX_SNAPSHOT_MANIFEST_BYTES,
  MAX_SNAPSHOT_SIDECAR_BYTES
} from "../../../runs/snapshot/artifact-limits.js";
import { seedValidV1VerifiedAssertionReceipt } from
  "./fixtures/valid-v1-assertion-receipt-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("current snapshot immutable artifact binding", () => {
  it("seals the source DB in place instead of duplicating it", async () => {
    const fixture = await snapshotFixture();
    const original = await readFile(fixture.snapshotDbPath);

    const bound = bindCurrentSnapshotArtifacts({
      sourceDbPath: fixture.snapshotDbPath,
      targetRoot: fixture.targetRoot
    });

    expect(bound.snapshotDbPath).toBe(fixture.snapshotDbPath);
    expect(await readFile(bound.snapshotDbPath)).toEqual(original);
    expect(bound.manifestSha256).toBe(
      sha256(await readFile(`${fixture.snapshotDbPath}.manifest.json`))
    );
  }, 20_000);

  it("rejects an in-place DB mutation against the sealed digest", async () => {
    const fixture = await snapshotFixture();
    bindCurrentSnapshotArtifacts({
      sourceDbPath: fixture.snapshotDbPath,
      targetRoot: fixture.targetRoot
    });
    await writeFile(fixture.snapshotDbPath, "replacement DB", "utf8");
    expect(() => bindCurrentSnapshotArtifacts({
      sourceDbPath: fixture.snapshotDbPath,
      targetRoot: fixture.targetRoot
    })).toThrow(/SHA-256 mismatch/u);
  }, 20_000);

  it.skipIf(process.platform === "win32")("rejects a symlinked current snapshot DB instead of following it", async () => {
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

  it("rejects a hash-consistent current snapshot with a valid v1 receipt", async () => {
    const fixture = await snapshotFixture({ validV1AssertionReceipt: true });

    expect(() => bindCurrentSnapshotArtifacts({
      sourceDbPath: fixture.snapshotDbPath,
      targetRoot: fixture.targetRoot
    })).toThrow(/current snapshot requires a v2 assertion receipt/u);
  });

  it.each(["missing", "replacement"] as const)(
    "rejects a %s extraction authority artifact",
    async (kind) => {
      const fixture = await snapshotFixture();
      const authorityPath = `${fixture.snapshotDbPath}.extraction-authority.json`;
      if (kind === "missing") await rm(authorityPath);
      if (kind === "replacement") await writeFile(authorityPath, "{}", "utf8");

      expect(() => bindCurrentSnapshotArtifacts({
        sourceDbPath: fixture.snapshotDbPath,
        targetRoot: fixture.targetRoot
      })).toThrow();
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlink extraction authority artifact",
    async () => {
      const fixture = await snapshotFixture();
      const authorityPath = `${fixture.snapshotDbPath}.extraction-authority.json`;
      const referent = join(fixture.root, "authority-referent.json");
      await writeFile(referent, await readFile(authorityPath));
      await rm(authorityPath);
      await symlink(referent, authorityPath);

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

  it("binds a diagnostic_attributed snapshot without a promotion gate contract", async () => {
    const fixture = await snapshotFixture({ diagnostic: true });
    const bound = bindCurrentSnapshotArtifacts({
      sourceDbPath: fixture.snapshotDbPath,
      targetRoot: fixture.targetRoot,
      snapshotConsumeAuthority: "diagnostic"
    });
    expect(bound.manifest.attribution).toEqual({
      status: "diagnostic_attributed",
      gate_eligible: false
    });
  });

  it("keeps promotion binding rejected for a diagnostic_attributed snapshot", async () => {
    const fixture = await snapshotFixture({ diagnostic: true });
    expect(() => bindCurrentSnapshotArtifacts({
      sourceDbPath: fixture.snapshotDbPath,
      targetRoot: fixture.targetRoot
    })).toThrow(/stored gate_eligible claim is false/u);
  });
});

async function snapshotFixture(options: {
  readonly validV1AssertionReceipt?: boolean;
  readonly diagnostic?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "current-bound-snapshot-"));
  roots.push(root);
  const targetRoot = join(root, "bound");
  await mkdir(targetRoot);
  const snapshotDbPath = join(root, "snapshot.db");
  const database = initDatabase({ filename: snapshotDbPath });
  database.close();
  if (options.validV1AssertionReceipt === true) {
    seedValidV1VerifiedAssertionReceipt(snapshotDbPath);
  }
  const dbBytes = await readFile(snapshotDbPath);
  const sidecarBytes = Buffer.from(
    `${JSON.stringify(currentSnapshotSidecarFor("q-1"), null, 2)}\n`,
    "utf8"
  );
  const authorityBytes = renderSnapshotExtractionAuthority(
    currentSnapshotExtractionAuthority()
  );
  const manifest = diagnosticManifest(currentSnapshotManifestFor("q-1", {
    db_sha256: sha256(dbBytes),
    sidecar_sha256: sha256(sidecarBytes),
    extraction_authority_filename: "snapshot.db.extraction-authority.json",
    extraction_authority_sha256: sha256(authorityBytes),
    extraction_authority_bytes: authorityBytes.byteLength
  }), options.diagnostic === true);
  await Promise.all([
    writeFile(snapshotDbPath, dbBytes),
    writeFile(`${snapshotDbPath}.sidecar.json`, sidecarBytes),
    writeFile(`${snapshotDbPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(`${snapshotDbPath}.extraction-authority.json`, authorityBytes)
  ]);
  return { root, targetRoot, snapshotDbPath };
}

function diagnosticManifest(
  manifest: ReturnType<typeof currentSnapshotManifestFor>,
  diagnostic: boolean
): ReturnType<typeof currentSnapshotManifestFor> {
  if (!diagnostic) return manifest;
  const provenance = manifest.run_provenance!;
  return {
    ...manifest,
    attribution: { status: "diagnostic_attributed", gate_eligible: false },
    run_provenance: {
      ...provenance,
      code: {
        commit_sha7: provenance.code.commit_sha7,
        gate_sha256: null,
        worktree_state_sha256: null,
        executed_dist: provenance.code.executed_dist
      }
    }
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
