import type { ExtractionAuthorityInspection } from
  "../../longmemeval/extraction/authority/inspection.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function emptyExtractionAuthorityShardStatus(): Pick<
  ExtractionAuthorityInspection,
  "invalidShards" | "preservedValidClosure"
> {
  return {
    invalidShards: [],
    preservedValidClosure: {
      shard_count: 0,
      key_set_sha256: EMPTY_SHA256,
      content_closure_sha256: EMPTY_SHA256
    }
  };
}
