import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  canonicalReplayContractDigests,
  rebuildCanonicalReplayKeys
} from "../dist/cli/provider-preflight/canonical-replay-contract.js";
import {
  computeSystemPromptSha256,
  readExtractionCacheManifestIdentity
} from "../dist/bench/extraction/cache/extraction-cache-manifest.js";
import { computeExtractionKeySetSha256 } from
  "../dist/bench/extraction/content-closure.js";

const [outputPath, datasetRevision, promptDigest,
  cacheRoot, rawLimit, rawOffset, providerRoute, model, requestProfile,
  dataDir, pinnedMetaRoot] = process.argv.slice(2);
if ([outputPath, datasetRevision, promptDigest,
  cacheRoot, rawLimit, rawOffset, providerRoute, model, requestProfile]
  .some((value) => value === undefined || value.length === 0)) {
  throw new Error("usage: prove-cache-only-replay.mjs <output> <dataset> <prompt> " +
    "<cache-root> <limit> <offset> <provider> <model> <profile>");
}
const limit = Number(rawLimit);
const offset = Number(rawOffset);
if (!Number.isSafeInteger(limit) || limit < 1 ||
    !Number.isSafeInteger(offset) || offset < 0) {
  throw new Error("replay window requires a positive limit and non-negative offset");
}

const cacheIdentity = readExtractionCacheManifestIdentity(cacheRoot);
if (cacheIdentity === undefined) throw new Error("replay cache manifest is missing");
const cacheManifest = cacheIdentity.manifest;
if (cacheManifest.schema_version !== 3 || cacheManifest.fill_status !== "complete" ||
    cacheManifest.content_closure_index === undefined) {
  throw new Error("replay requires a sealed v3 complete cache manifest");
}
const currentPromptDigest = computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT);
if (datasetRevision !== cacheManifest.dataset_revision ||
    model !== cacheManifest.extraction_model ||
    requestProfile !== cacheManifest.request_profile ||
    providerRoute !== cacheManifest.provider_url ||
    promptDigest !== cacheManifest.system_prompt_sha256 ||
    promptDigest !== currentPromptDigest) {
  throw new Error("replay request authority disagrees with the sealed cache");
}

const contract = canonicalReplayContractDigests();
const request = {
  datasetRevision,
  requestedKeys: [],
  providerRoute,
  model,
  requestProfile,
  promptDigest,
  schemaDigest: contract.schemaDigest,
  operatorDigest: contract.operatorDigest,
  cacheMode: "cache_only",
  variant: "longmemeval_s",
  limit,
  offset,
  worker: false,
  extractionCacheRoot: cacheRoot
};
const keys = await rebuildCanonicalReplayKeys({
  request,
  ...(dataDir === undefined ? {} : { dataDir }),
  ...(pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot })
});
const indexed = new Set(Object.keys(cacheManifest.content_closure_index));
const missing = keys.filter((key) => !indexed.has(key));
if (missing.length > 0) {
  throw new Error(`sealed cache omits ${missing.length} canonical window key(s)`);
}
const keySetSha256 = computeExtractionKeySetSha256(keys);
request.requestedKeys = keys;
const manifest = {
  schema_version: 1,
  kind: "provider_preflight_replay_request",
  request,
  canonical_keys: { count: keys.length, key_set_sha256: keySetSha256 },
  cache_authority: {
    manifest_sha256: cacheIdentity.manifestSha256,
    content_closure_sha256: cacheManifest.content_closure_sha256,
    expected_key_set_sha256: cacheManifest.expected_key_set_sha256,
    shard_count: cacheManifest.expected_turns,
    window_offset: cacheManifest.window_offset,
    window_limit: cacheManifest.window_limit
  },
  dataset_authority: {
    ...(dataDir === undefined ? {} : { data_dir: dataDir }),
    ...(pinnedMetaRoot === undefined ? {} : { pinned_meta_root: pinnedMetaRoot })
  }
};
const requestManifestSha256 = createHash("sha256")
  .update(JSON.stringify(manifest), "utf8")
  .digest("hex");
await writeFile(outputPath, `${JSON.stringify({
  ...manifest,
  request_manifest_sha256: requestManifestSha256
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(
  `Prepared canonical replay request keys=${keys.length} key_set_sha256=${keySetSha256} ` +
  `request_manifest_sha256=${requestManifestSha256}\n`
);
