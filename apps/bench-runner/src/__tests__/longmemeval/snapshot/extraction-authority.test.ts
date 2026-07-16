import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LongMemEvalRunProvenance } from
  "../../../longmemeval/provenance/run.js";
import type { ExtractionCacheManifestV3 } from
  "../../../longmemeval/extraction-cache-manifest.js";
import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  extractionContentClosureEntriesFromIndex
} from "../../../longmemeval/extraction/content-closure.js";
import {
  MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES,
  assertSnapshotExtractionAuthorityBinding,
  buildSnapshotExtractionAuthority,
  buildSnapshotExtractionSummary,
  parseSnapshotExtractionAuthorityBytes,
  renderSnapshotExtractionAuthority
} from "../../../longmemeval/snapshot/extraction-authority.js";
import {
  LongMemEvalSnapshotRunProvenanceSchema,
  bindSnapshotRunProvenanceAuthority,
  compactSnapshotRunProvenance
} from "../../../longmemeval/snapshot/run-provenance.js";
import { makeShardProvenance } from "../runner-concurrency-fixture.js";

const SOURCE_SHA = "a".repeat(64);

describe("snapshot extraction authority", () => {
  it("keeps provider identity out of the full authority artifact", () => {
    const manifest = extractionManifest(2, "provider-secret");
    const compact = buildSnapshotExtractionSummary(manifest, SOURCE_SHA);
    const authority = buildSnapshotExtractionAuthority(manifest, SOURCE_SHA, compact);
    const rendered = renderSnapshotExtractionAuthority(authority).toString("utf8");

    expect(compact.provider_url).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(rendered).not.toContain("provider_url");
    expect(rendered).not.toContain("provider-secret");
    expect(rendered).not.toContain("secret.example");
    expect(rendered).not.toContain(compact.provider_url);
  });

  it("strictly rejects provider fields and compact/full drift", () => {
    const manifest = extractionManifest(2, "strict");
    const compact = buildSnapshotExtractionSummary(manifest, SOURCE_SHA);
    const authority = buildSnapshotExtractionAuthority(manifest, SOURCE_SHA, compact);
    const injected = Buffer.from(JSON.stringify({
      ...authority,
      provider_url: "https://secret.example/?token=leak"
    }), "utf8");

    expect(() => parseSnapshotExtractionAuthorityBytes(injected, "injected"))
      .toThrow(/snapshot extraction authority is invalid at injected/u);
    expect(() => assertSnapshotExtractionAuthorityBinding(authority, {
      ...compact,
      content_closure_sha256: "0".repeat(64)
    })).toThrow(/compact summary differs/u);
  });

  it("rejects inline closure indices and run-summary drift", () => {
    const manifest = extractionManifest(2, "run-binding");
    const authority = buildSnapshotExtractionAuthority(manifest, SOURCE_SHA);
    const fullRun = runProvenance(manifest);
    const compactRun = compactSnapshotRunProvenance(fullRun);
    const cache = compactRun.extraction_cache!;
    if (cache.schema_version !== 3) throw new Error("expected current compact cache");

    expect(LongMemEvalSnapshotRunProvenanceSchema.safeParse({
      ...compactRun,
      extraction_cache: { ...cache, content_closure_index: manifest.content_closure_index }
    }).success).toBe(false);
    expect(() => bindSnapshotRunProvenanceAuthority({
      ...compactRun,
      extraction_cache: { ...cache, expected_turns: cache.expected_turns! + 1 }
    }, authority)).toThrow(/compact summary differs/u);
  });

  it("keeps 100Q and 500Q snapshot manifests near-constant in size", () => {
    const sizes = [23_807, 96_084].map((count) => sizeEvidence(count));

    for (const evidence of sizes) {
      expect(evidence.manifestBytes).toBeLessThan(4 * 1024 * 1024);
      expect(evidence.authorityBytes).toBeLessThan(
        MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES
      );
      expect(evidence.authorityRows).toBe(evidence.expectedRows);
      expect(evidence.manifestJson).not.toContain("content_closure_index");
    }
    expect(Math.abs(sizes[1]!.manifestBytes - sizes[0]!.manifestBytes))
      .toBeLessThan(1_024);
    expect(sizes[1]!.authorityBytes).toBeGreaterThan(sizes[0]!.authorityBytes);
  }, 30_000);
});

function sizeEvidence(count: number) {
  const manifest = extractionManifest(count, `scale-${count}`);
  const compact = buildSnapshotExtractionSummary(manifest, SOURCE_SHA);
  const authority = buildSnapshotExtractionAuthority(manifest, SOURCE_SHA, compact);
  const run = compactSnapshotRunProvenance(runProvenance(manifest));
  const manifestJson = JSON.stringify({
    extraction_provenance: compact,
    run_provenance: run
  });
  return {
    expectedRows: count,
    authorityRows: Object.keys(authority.content_closure_index).length,
    authorityBytes: renderSnapshotExtractionAuthority(authority).byteLength,
    manifestBytes: Buffer.byteLength(manifestJson),
    manifestJson
  };
}

function extractionManifest(count: number, seed: string): ExtractionCacheManifestV3 {
  const model = "fixture-model";
  const requestProfile = "provider-default-v1" as const;
  const contentClosureIndex = Object.fromEntries(Array.from(
    { length: count },
    (_, index) => [sha256(`${seed}:key:${index}`), [
      sha256(`${seed}:raw:${index}`), 0, 0
    ] as const]
  ));
  const entries = extractionContentClosureEntriesFromIndex(
    contentClosureIndex,
    model,
    requestProfile
  );
  return {
    schema_version: 3, extraction_model: model, model_family: model,
    request_profile: requestProfile,
    provider_url: "https://user:pass@secret.example/v1?api_key=provider-secret",
    system_prompt_sha256: "b".repeat(64), cache_key_algo: "fixture-v1",
    dataset: "longmemeval-s", dataset_revision: "c".repeat(64),
    requested_turns: count, cached_turns: count, coverage: 1,
    storage: "git-tracked", built_at: "2026-07-17T00:00:00.000Z", builder: "test",
    fill_status: "complete", window_offset: 0, window_limit: 500,
    expected_turns: count,
    expected_key_set_sha256: computeExtractionKeySetSha256(
      Object.keys(contentClosureIndex)
    ),
    content_closure_sha256: computeExtractionContentClosureSha256(entries),
    content_closure_index: contentClosureIndex
  };
}

function runProvenance(
  manifest: ExtractionCacheManifestV3
): LongMemEvalRunProvenance {
  return {
    ...makeShardProvenance(0, 1),
    extraction_cache: { manifest_sha256: SOURCE_SHA, ...manifest }
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
