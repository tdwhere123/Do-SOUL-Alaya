import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceAssertionSupplementBindingSchema } from
  "../../../runs/extraction/cache/semantic-supplement/source-assertion-supplement.js";
import { makeShardProvenance } from "../runner/runner-concurrency-fixture.js";
import {
  currentCanonicalQuestions as questions,
  currentSnapshotExtractionAuthority as authorityFor,
  currentSnapshotManifestFor as manifestFor,
  currentSnapshotSidecarFor as sidecarFor
} from "./current-snapshot-fixture.js";

const roots: string[] = [];

vi.mock("../../../datasets/longmemeval/ingestion/fetch.js", () => ({
  loadDatasetWithIdentity: vi.fn(async () => ({
    questions,
    sha256: makeShardProvenance(0, 1).dataset_sha256!,
    checksumSource: "fixture",
    sourcePath: "fixture",
    promotionAuthority: {}
  }))
}));
vi.mock("../../../runs/snapshot/integrity.js", async (loadOriginal) => ({
  ...await loadOriginal<typeof import("../../../runs/snapshot/integrity.js")>(),
  verifySnapshotArtifactIntegrity: vi.fn(async () => undefined)
}));
vi.mock("../../../runs/snapshot/substrate-binding.js", () => ({
  assertSnapshotDatasetSubstrateIdentity: vi.fn()
}));
const { assertSnapshotSeedLedgerBinding } = vi.hoisted(() => ({
  assertSnapshotSeedLedgerBinding: vi.fn()
}));
vi.mock("../../../runs/snapshot/seed-ledger/seed-ledger-binding.js", () => ({
  assertSnapshotSeedLedgerBinding
}));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("current snapshot execution-window authority", () => {
  it("makes the current loader reject a self-consistent question outside its window", async () => {
    const { verifyCurrentRecallSnapshotAuthority } = await import(
      "../../../runs/snapshot/current/current-substrate-authority.js"
    );
    const root = await mkdtemp(join(tmpdir(), "current-window-loader-"));
    roots.push(root);
    const snapshotDbPath = join(root, "snapshot.db");
    const manifest = manifestFor("q-99");
    await writeFile(`${snapshotDbPath}.manifest.json`, JSON.stringify(manifest), "utf8");

    await expect(verifyCurrentRecallSnapshotAuthority({
      snapshotDbPath,
      variant: "longmemeval_s",
      manifest,
      sidecar: sidecarFor("q-99"),
      extractionAuthority: authorityFor()
    })).rejects.toThrow(/execution window/iu);
  });

  it("makes the writer reject the same out-of-window question before DB access", async () => {
    const { assertCurrentSnapshotWriteAuthority } = await import(
      "../../../runs/snapshot/current/current-substrate-authority.js"
    );
    const manifest = manifestFor("q-99");
    const extraction = manifest.extraction_provenance;
    const authority = authorityFor();
    if (extraction?.schema_version !== 3) throw new Error("fixture requires v3 extraction");
    const { bindSnapshotRunProvenanceAuthority } = await import(
      "../../../runs/snapshot/run-provenance.js"
    );

    expect(() => assertCurrentSnapshotWriteAuthority({
      dbPath: "/missing/current-window.db",
      sidecar: sidecarFor("q-99"),
      canonicalQuestions: questions,
      extraction,
      extractionAuthority: authority,
      seedExtractionPath: manifest.seed_extraction_path!,
      runProvenance: bindSnapshotRunProvenanceAuthority(
        manifest.run_provenance!,
        authority
      ),
      datasetSha256: manifest.dataset_sha256!
    })).toThrow(/execution window/iu);
  });

  it("forwards semantic supplement authority into the writer substrate ledger", async () => {
    const { assertCurrentSnapshotWriteAuthority } = await import(
      "../../../runs/snapshot/current/current-substrate-authority.js"
    );
    const manifest = manifestFor("q-1");
    const extraction = manifest.extraction_provenance;
    const authority = authorityFor();
    if (extraction?.schema_version !== 3) throw new Error("fixture requires v3 extraction");
    const { bindSnapshotRunProvenanceAuthority } = await import(
      "../../../runs/snapshot/run-provenance.js"
    );
    const binding = supplementBinding();
    const runProvenance = {
      ...bindSnapshotRunProvenanceAuthority(manifest.run_provenance!, authority),
      semantic_supplement: binding
    };

    assertCurrentSnapshotWriteAuthority({
      dbPath: "/missing/current-supplement.db",
      sidecar: sidecarFor("q-1"),
      canonicalQuestions: questions,
      extraction,
      extractionAuthority: authority,
      seedExtractionPath: manifest.seed_extraction_path!,
      runProvenance,
      datasetSha256: manifest.dataset_sha256!,
      semanticSupplementBinding: binding
    });

    expect(assertSnapshotSeedLedgerBinding).toHaveBeenCalledWith(
      expect.objectContaining({ semanticSupplementBinding: binding })
    );
  });
});

function supplementBinding() {
  return SourceAssertionSupplementBindingSchema.parse({
    kind: "longmemeval-source-assertion-semantic-supplement",
    receipt_schema_version: 3,
    mapping_basis: "source-draft-to-current-anchor-v3",
    receipt_sha256: "3".repeat(64),
    entry_count: 1,
    assertion_count: 1,
    occurrence_count: 1,
    entry_set_sha256: "4".repeat(64),
    primary_manifest_sha256: "5".repeat(64),
    source_manifest_sha256: "6".repeat(64),
    parser_semantics: "test-parser",
    grounding_semantics: "test-grounding"
  });
}
