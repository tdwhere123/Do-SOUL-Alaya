import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCachedExtraction } from "../../../../bench/compile-seed/cache/cache-shard.js";
import { requireProviderBinding } from "../../../../bench/provider/catalog.js";
import { digest, loopRequest } from "../../diagnostic-loop/fixture.js";
import {
  readExtractionCacheManifestIdentity,
  writeExtractionCacheManifest
} from "../../../../bench/extraction/cache/extraction-cache-manifest.js";
import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  inspectExtractionRawJson
} from
  "../../../../bench/extraction/content-closure.js";
import {
  canonicalReplayContractDigests,
  rebuildCanonicalReplayKeys
} from
  "../../../../cli/provider-preflight/canonical-replay-contract.js";
import { manifestFor } from
  "../../extraction/extraction-cache-preflight-fixture.js";
import {
  buildRunnerQuestions,
  createRunnerFixture
} from "../../runner-integration/fixture.js";

export const MIMO = requireProviderBinding("mimo-v2.5");

export function writeCompleteMimoCache(
  cacheRoot: string,
  key: string
): { readonly systemPromptSha256: string } {
  return writeCompleteMimoCacheKeys(cacheRoot, [key], digest("dataset"));
}

function writeCompleteMimoCacheKeys(
  cacheRoot: string,
  keys: readonly string[],
  datasetRevision: string
): { readonly systemPromptSha256: string } {
  const rawJson = "{\"signals\":[]}";
  const inspected = inspectExtractionRawJson(rawJson);
  for (const key of keys) {
    writeCachedExtraction(cacheRoot, key, {
      model: MIMO.id,
      request_profile: MIMO.requestProfile,
      cache_key: key,
      raw_json: rawJson,
      extracted_at: "2026-08-17T00:00:00.000Z"
    });
  }
  const entries = keys.map((key) => ({
    cacheKey: key,
    model: MIMO.id,
    requestProfile: MIMO.requestProfile,
    ...inspected
  }));
  const manifest = manifestFor({
    extraction_model: MIMO.id,
    model_family: MIMO.id,
    request_profile: MIMO.requestProfile,
    provider_url: "mimo",
    dataset_revision: datasetRevision,
    requested_turns: keys.length,
    cached_turns: keys.length,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: 1,
    expected_turns: keys.length,
    expected_key_set_sha256: computeExtractionKeySetSha256(keys),
    content_closure_sha256: computeExtractionContentClosureSha256(entries),
    content_closure_index: Object.fromEntries(keys.map((key) => [key, [
        inspected.rawJsonSha256,
        inspected.rawSignalCount,
        inspected.parsedDraftCount
      ]]))
  });
  writeExtractionCacheManifest(cacheRoot, manifest);
  return { systemPromptSha256: manifest.system_prompt_sha256 };
}

export async function createCanonicalReplayManifestBody(
  registerRoot: (root: string) => void
) {
  const root = await mkdtemp(join(tmpdir(), "provider-preflight-"));
  registerRoot(root);
  const fixture = await createRunnerFixture({
    root,
    label: "canonical-replay",
    variant: "longmemeval_s",
    questions: buildRunnerQuestions("canonical-replay", 1)
  });
  const contract = canonicalReplayContractDigests();
  const requestWithoutKeys = loopRequest({
    datasetRevision: fixture.datasetSha256,
    requestedKeys: [],
    schemaDigest: contract.schemaDigest,
    operatorDigest: contract.operatorDigest,
    extractionCacheRoot: fixture.extractionCacheRoot,
    variant: fixture.variant,
    limit: 1,
    offset: 0
  });
  const keys = await rebuildCanonicalReplayKeys({
    request: requestWithoutKeys,
    dataDir: fixture.dataDir,
    pinnedMetaRoot: fixture.pinnedMetaRoot
  });
  const authority = writeCompleteMimoCacheKeys(
    fixture.extractionCacheRoot,
    keys,
    fixture.datasetSha256
  );
  const request = {
    ...requestWithoutKeys,
    requestedKeys: keys,
    promptDigest: authority.systemPromptSha256
  };
  return replayManifestBody(fixture.extractionCacheRoot, request, {
    data_dir: fixture.dataDir,
    pinned_meta_root: fixture.pinnedMetaRoot
  });
}

export function replayManifestBody(
  cacheRoot: string,
  request: ReturnType<typeof loopRequest>,
  datasetAuthority: Readonly<{ readonly data_dir?: string; readonly pinned_meta_root?: string }>
) {
  const cacheIdentity = readExtractionCacheManifestIdentity(cacheRoot)!;
  return {
    schema_version: 1 as const,
    kind: "provider_preflight_replay_request" as const,
    request,
    canonical_keys: {
      count: request.requestedKeys.length,
      key_set_sha256: computeExtractionKeySetSha256(request.requestedKeys)
    },
    cache_authority: {
      manifest_sha256: cacheIdentity.manifestSha256,
      content_closure_sha256: cacheIdentity.manifest.content_closure_sha256,
      expected_key_set_sha256: cacheIdentity.manifest.expected_key_set_sha256,
      shard_count: cacheIdentity.manifest.expected_turns,
      window_offset: cacheIdentity.manifest.window_offset,
      window_limit: cacheIdentity.manifest.window_limit
    },
    dataset_authority: datasetAuthority
  };
}

export function sealReplayManifest<T extends Record<string, unknown>>(
  body: T
): T & { readonly request_manifest_sha256: string } {
  return {
    ...body,
    request_manifest_sha256: createHash("sha256")
      .update(JSON.stringify(body), "utf8")
      .digest("hex")
  };
}
