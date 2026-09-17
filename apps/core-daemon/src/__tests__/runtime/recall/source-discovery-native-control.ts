import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXTRACTION_SOURCE_PACKING } from "@do-soul/alaya-protocol";
import { OFFICIAL_API_SYSTEM_PROMPT, stringifyOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest } from "@do-soul/alaya-soul";
import { importExtractionResponse } from "../../../../../../apps/bench-runner/src/runs/compile-seed/compile-seed-cache.js";
import { acquireExtractionCacheWriteLease } from "../../../../../../apps/bench-runner/src/runs/extraction/fill/manifest/fill-root-guard.js";
import { writeExtractionCacheTestManifest, TEST_PROVIDER_COMPLETION_METADATA,
  TEST_EXTRACTION_PROVIDER_URL } from "../../../../../../apps/bench-runner/src/__tests__/longmemeval/extraction/extraction-cache-test-fixture.js";
import { bindNativeAdmittedControlShard, expectedExtractionCacheKey } from "./source-discovery-admitted-public-publication.js";

/** Synthetic transport metadata exercises native admission only; never empirical model evidence. */
export function bindNativeControl(input: {
  readonly rawJson: string; readonly sourceCorpus: string;
  readonly request: OfficialApiExtractionRequest; readonly artifactKey: string;
}) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "alaya-native-control-"));
  const model = "native-admitted-control";
  const requestProfile = "provider-default-v1" as const;
  const config = { model, modelFamily: model, requestProfile, providerUrl: TEST_EXTRACTION_PROVIDER_URL };
  writeExtractionCacheTestManifest({ cacheRoot, model, systemPrompt: OFFICIAL_API_SYSTEM_PROMPT });
  const lease = acquireExtractionCacheWriteLease(cacheRoot);
  try {
    const expectedCacheKey = expectedExtractionCacheKey({ ...config, systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      request: input.request });
    importExtractionResponse({ cacheRoot, config, writeLease: lease,
      expectedCacheKey, systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: stringifyOfficialApiExtractionRequest(input.request), sourceCorpus: input.sourceCorpus,
      result: { rawJson: input.rawJson, responseMetadata: TEST_PROVIDER_COMPLETION_METADATA } });
    return bindNativeAdmittedControlShard({ ...input, ...config, cacheRoot,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, sourcePacking: DEFAULT_EXTRACTION_SOURCE_PACKING });
  } finally {
    lease.release();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}
