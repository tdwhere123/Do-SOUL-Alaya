import { createHash } from "node:crypto";
import {
  stringifyOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import type { CachedExtractionEntry } from "../../../compile-seed/cache/cache-shard.js";
import { computeCacheKey } from "../../../compile-seed/cache/cache-key.js";
import type { VerifiedLegacyExtractionEntry } from "./legacy-sealed-entry.js";

export interface VerifiedLegacyWitness {
  readonly cache_key: string;
  readonly request_sha256: string;
  readonly prompt_sha256: string;
  readonly completion_witness_sha256: string;
  readonly sealed_entry_sha256: string;
  readonly source_authority_sha256: string;
  readonly source_manifest_sha256: string;
  readonly raw_json_sha256: string;
  readonly response_metadata_sha256: string;
  readonly transport_provenance_sha256: string;
}

export function verifyLegacyShardIdentity(input: {
  readonly entry: CachedExtractionEntry;
  readonly request: OfficialApiExtractionRequest;
  readonly expectedSystemPrompt: string;
  readonly authority: VerifiedLegacyExtractionEntry;
}): VerifiedLegacyWitness {
  const serializedRequest = stringifyOfficialApiExtractionRequest(input.request);
  const expectedCacheKey = computeCacheKey(
    input.entry.model,
    input.entry.request_profile,
    input.expectedSystemPrompt,
    serializedRequest
  );
  if (input.entry.cache_key !== expectedCacheKey) {
    throw new Error("legacy shard cache key does not match prompt, request, model, and profile");
  }
  const promptSha256 = digest(input.expectedSystemPrompt);
  if (promptSha256 !== input.authority.systemPromptSha256 ||
      input.entry.model !== input.authority.model ||
      input.entry.request_profile !== input.authority.requestProfile ||
      input.entry.transport_provenance?.model !== input.authority.transportModel) {
    throw new Error("legacy execution identity is not bound by snapshot extraction authority");
  }
  return Object.freeze({
    cache_key: input.entry.cache_key,
    request_sha256: digest(serializedRequest),
    prompt_sha256: promptSha256,
    completion_witness_sha256: input.authority.completionWitnessSha256,
    sealed_entry_sha256: input.authority.fileSha256,
    source_authority_sha256: input.authority.sourceAuthoritySha256,
    source_manifest_sha256: input.authority.sourceManifestSha256,
    raw_json_sha256: input.authority.rawJsonSha256,
    response_metadata_sha256: input.authority.responseMetadataSha256,
    transport_provenance_sha256: input.authority.transportProvenanceSha256
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
