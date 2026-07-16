import { createHash } from "node:crypto";
import type { ExtractionRequestProfile } from
  "../../longmemeval/extraction-cache-manifest.js";
import {
  buildExtractionContentClosureIndex,
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256
} from "../../longmemeval/extraction/content-closure.js";

export function syntheticExtractionClosure(input: {
  readonly count: number;
  readonly model: string;
  readonly requestProfile: ExtractionRequestProfile;
  readonly seed?: string;
}) {
  const seed = input.seed ?? "fixture";
  const entries = Array.from({ length: input.count }, (_, index) => ({
    cacheKey: sha256(`${seed}:cache:${index}`),
    model: input.model,
    requestProfile: input.requestProfile,
    rawJsonSha256: sha256(`${seed}:raw:${index}`),
    rawSignalCount: 1,
    parsedDraftCount: 1
  }));
  return {
    expected_turns: entries.length,
    expected_key_set_sha256: computeExtractionKeySetSha256(
      entries.map((entry) => entry.cacheKey)
    ),
    content_closure_sha256: computeExtractionContentClosureSha256(entries),
    content_closure_index: buildExtractionContentClosureIndex(entries)
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
