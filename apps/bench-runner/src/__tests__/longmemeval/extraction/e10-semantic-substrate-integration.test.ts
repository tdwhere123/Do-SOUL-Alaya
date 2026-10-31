import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertRecallZeroLiveExtraction,
  parseExtractionBenchMode
} from "../../../runs/extraction/cache/semantic-artifact/bench-mode.js";
import { computeExtractionKeySetSha256 } from
  "../../../runs/extraction/content-closure.js";
import {
  assertLazySemanticAuthorityMatchesExtraction,
  captureSemanticRunSourceAuthority,
  SemanticRunSourceAuthoritySchema
} from "../../../runs/extraction/fill/semantic-fill-authority.js";
import {
  SEMANTIC_CAPABILITY as CAP,
  semanticTask
} from "./semantic-artifact-fixture.js";

describe("semantic substrate authority", () => {
  it("keeps historical lazy-mode attribution without live extraction", () => {
    expect(parseExtractionBenchMode({
      mode: "lazy_field",
      f0f2SubstrateIdentity: "f0f2",
      startingCacheIdentity: "cache",
      capabilityPolicy: [CAP],
      maxCalls: 0
    }).mode).toBe("lazy_field");
    expect(() => assertRecallZeroLiveExtraction({
      providerExecutorEntries: 0, extractionWrites: 0
    })).not.toThrow();
    expect(() => assertRecallZeroLiveExtraction({
      providerExecutorEntries: 1, extractionWrites: 0
    })).toThrow(/live extraction/u);
  });

  it("accepts sparse demand against a complete substrate and fail-closes a foreign key", () => {
    const task = semanticTask();
    const demandKeys = [...task.sourceAuthority.substrateCacheKeys];
    const emptyWorkKey = "ab".repeat(32);
    const fullKeys = [...demandKeys, emptyWorkKey].sort();
    const fullIndex = Object.fromEntries(fullKeys.map((cacheKey) => [
      cacheKey, ["aa".repeat(32), 0, 0] as const
    ]));
    const substrateManifest = {
      ...task.sourceAuthority.substrateManifest,
      expectedTurns: fullKeys.length,
      expectedKeySetSha256: computeExtractionKeySetSha256(fullKeys),
      contentClosureIndexSha256: createHash("sha256")
        .update(JSON.stringify(fullIndex), "utf8").digest("hex")
    };
    const captured = captureSemanticRunSourceAuthority([{
      ...task,
      sourceAuthority: { ...task.sourceAuthority, substrateManifest }
    }]);
    expect(SemanticRunSourceAuthoritySchema.parse(captured)).toEqual(captured);
    expect(computeExtractionKeySetSha256(
      captured.sourceCorpora.flatMap((entry) => entry.substrateCacheKeys)
    )).not.toBe(substrateManifest.expectedKeySetSha256);
    expect(captured.sourceCorpora.flatMap((entry) => entry.substrateCacheKeys).length)
      .toBeLessThan(substrateManifest.expectedTurns);

    const extraction = {
      schema_version: 3 as const,
      manifest_sha256: substrateManifest.manifestSha256,
      dataset: substrateManifest.dataset,
      dataset_revision: substrateManifest.datasetRevision,
      extraction_model: substrateManifest.extractionModel,
      model_family: substrateManifest.modelFamily,
      request_profile: substrateManifest.requestProfile,
      system_prompt_sha256: substrateManifest.systemPromptSha256,
      cache_key_algo: substrateManifest.cacheKeyAlgorithm,
      expected_turns: substrateManifest.expectedTurns,
      expected_key_set_sha256: substrateManifest.expectedKeySetSha256,
      content_closure_sha256: substrateManifest.contentClosureSha256,
      content_closure_index: fullIndex,
      window_offset: substrateManifest.windowOffset,
      window_limit: substrateManifest.windowLimit
    };
    expect(() => assertLazySemanticAuthorityMatchesExtraction({
      receipt: { sourceAuthority: captured },
      extraction
    })).not.toThrow();

    const foreign = SemanticRunSourceAuthoritySchema.parse({
      ...captured,
      sourceCorpora: captured.sourceCorpora.map((entry) => ({
        ...entry,
        substrateCacheKeys: [...entry.substrateCacheKeys, "ff".repeat(32)].sort()
      }))
    });
    expect(() => assertLazySemanticAuthorityMatchesExtraction({
      receipt: { sourceAuthority: foreign },
      extraction
    })).toThrow(/foreign source corpus substrate/u);
  });
});
