import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCachingSignalExtractor } from "../../../runs/compile-seed.js";
import { inspectCachedRawExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import { computeCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import { fixtureAttemptAuthority, providerBackedResponseResult, writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";
import { extractionConfig, MODEL, REQUEST_PROFILE, SYSTEM_PROMPT, sourceCorpusWithAssertions, userPromptWithAssertions } from "../extraction/cache/cache-live-delegate/fixture.js";
import { inspectExtractionCacheInventory, hashExtractionCacheInventory } from "../../../runs/extraction/cache-audit/inventory.js";
import { decideExtractionCacheCompatibility } from "../../../runs/extraction/cache-audit/compatibility.js";
import { buildExtractionCacheAuditReceipt } from "../../../runs/extraction/cache-audit/receipt.js";
import { createFreshExtractionTargetSelection } from "../../../runs/extraction/authority/target-selection/receipt.js";
import { materializeAuditedExtractionCacheTarget } from "../../../runs/extraction/cache-audit/target-materializer.js";
import { computeExtractionKeySetSha256 } from "../../../runs/extraction/content-closure.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const rawJson = '{"interpretations":[]}';
function setup() {
  const root = mkdtempSync(join(tmpdir(), "materialization-provider-admission-"));
  const cacheRoot = join(root, "source");
  const config = extractionConfig();
  writeExtractionCacheTestManifest({ cacheRoot, model: MODEL, providerUrl: config.providerUrl,
    requestProfile: REQUEST_PROFILE, systemPrompt: SYSTEM_PROMPT });
  const manifestPath = join(cacheRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dataset_revision = "a".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const input = { systemPrompt: SYSTEM_PROMPT, sourceCorpus: sourceCorpusWithAssertions(),
    userPrompt: userPromptWithAssertions() };
  const key = computeCacheKey(MODEL, REQUEST_PROFILE, input.systemPrompt, input.userPrompt);
  const authority = fixtureAttemptAuthority({ cacheRoot, model: MODEL, requestProfile: REQUEST_PROFILE });
  return { root, cacheRoot, config, input, key, manifest, authority };
}

it("refuses a provider-backed shard before materialization commit without root-local evidence", async () => {
  const f = setup();
  try {
    const delegate = { extract: (input: typeof f.input) => providerBackedResponseResult(input, rawJson) };
    await createCachingSignalExtractor({ ...f.authority, cacheRoot: f.cacheRoot,
      config: f.config, delegate }).extract(f.input);
    expect(inspectCachedRawExtraction(f.cacheRoot, f.key, MODEL, REQUEST_PROFILE).status).toBe("hit");
    const keys = [f.key, "0".repeat(64)];
    const inventory = inspectExtractionCacheInventory({ cacheRoot: f.cacheRoot,
      cacheKeys: keys, model: MODEL, requestProfile: REQUEST_PROFILE });
    expect(inventory.counts).toMatchObject({ expected: 2, hit: 1, missing: 1, invalid: 0 });
    const identity = { raw: { sourcePacking: "reference-eight" as const,
      datasetRevision: f.manifest.dataset_revision, model: MODEL, requestProfile: REQUEST_PROFILE,
      providerUrl: f.config.providerUrl, systemPromptSha256: f.manifest.system_prompt_sha256,
      cacheKeyAlgorithm: f.manifest.cache_key_algo, rawClosureSha256: "b".repeat(64) },
      projection: { modelFamily: f.manifest.model_family, parserSemanticsSha256: "c".repeat(64),
        formationSemanticsSha256: "d".repeat(64), temporalSchemaRevision: "relation-assertion-v1" } };
    const decision = decideExtractionCacheCompatibility({ sourceRoot: f.cacheRoot, source: identity,
      final: identity, rawInventoryClosed: false, replay: { occurrenceCount: 0, accountedOccurrences: 0,
        elementCount: 0, accountedElements: 0, admitted: 0, deferred: 0, rejected: 0, invalid: 0,
        ledgerSha256: "e".repeat(64) } });
    const manifestRaw = readFileSync(join(f.cacheRoot, "manifest.json"), "utf8");
    const audit = buildExtractionCacheAuditReceipt({ createdAt: "2026-09-25T00:00:00.000Z",
      sourceRoot: f.cacheRoot, sourceManifestSha256: sha(manifestRaw),
      rawInventorySha256: hashExtractionCacheInventory(inventory), occurrenceIndexSha256: "f".repeat(64), decision });
    const targetRoot = join(f.root, "target");
    const observation = { revision: "review-synthetic", selectionDigest: "1".repeat(64),
      keyDigest: computeExtractionKeySetSha256(keys),
      dataset: { variant: "longmemeval_s", revisionSha256: f.manifest.dataset_revision,
        windowOffset: 0, windowLimit: 100 },
      extraction: { model: MODEL, modelFamily: f.manifest.model_family, requestProfile: REQUEST_PROFILE,
        sourcePacking: "reference-eight", providerUrl: f.config.providerUrl,
        systemPromptSha256: f.manifest.system_prompt_sha256, cacheKeyAlgorithm: f.manifest.cache_key_algo,
        manifestSha256: null, rawContentClosureSha256: null },
      inventory: { expectedTurns: 2, validTurns: 0, missingTurns: 2, invalidTurns: 0, orphanTurns: 0 } };
    const targetSelection = createFreshExtractionTargetSelection({ cacheRoot: targetRoot,
      auditReceipt: audit, observation: observation as Parameters<typeof createFreshExtractionTargetSelection>[0]["observation"] });
    expect(() => materializeAuditedExtractionCacheTarget({ sourceRoot: f.cacheRoot, targetRoot,
      auditReceipt: audit, inventory, targetSelection, auditedSourceManifestRaw: manifestRaw,
      now: () => "2026-09-25T00:00:00.000Z" }))
      .toThrow(/requires root-local admission evidence/u);
    expect(existsSync(join(targetRoot, ".alaya-extraction-cache-materialization-commit.json")))
      .toBe(false);
    expect(inspectCachedRawExtraction(f.cacheRoot, f.key, MODEL, REQUEST_PROFILE).status).toBe("hit");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
