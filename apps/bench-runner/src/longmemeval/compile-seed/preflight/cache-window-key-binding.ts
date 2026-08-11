import type { ExtractionCacheManifest } from
  "../../extraction/cache/extraction-cache-manifest.js";
import { computeExtractionKeySetSha256 } from
  "../../extraction/content-closure.js";
import type { LongMemEvalExtractionTurn } from
  "../../extraction/turn-contents.js";
import type { CompileSeedExtractionConfig } from "../compile-seed-types.js";
import {
  computeExtractionTurnCacheKeys,
  computeSourceTurnCacheKeys
} from "../compile-seed-cache.js";

export interface RequiredExtractionCacheKeysInput {
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly systemPrompt: string;
  readonly requiredTurnContents: readonly string[];
  readonly requiredExtractionTurns?: readonly LongMemEvalExtractionTurn[];
}

type V3WindowKeyBindingInput = RequiredExtractionCacheKeysInput & {
  readonly manifest: ExtractionCacheManifest;
};

export function assertV3ExactWindowKeyBinding(
  input: V3WindowKeyBindingInput
): boolean {
  const index = v3ClosureIndex(input.manifest);
  if (index === undefined) return false;
  const requiredKeys = new Set(requiredExtractionCacheKeys(input));
  const indexedKeys = new Set(Object.keys(index));
  if (requiredKeys.size !== indexedKeys.size ||
      [...requiredKeys].some((key) => !indexedKeys.has(key)) ||
      computeExtractionKeySetSha256(requiredKeys) !==
        input.manifest.expected_key_set_sha256) {
    throw new Error(
      "[longmemeval preflight] extraction cache complete fill does not match " +
        "this run's exact key set. Run extraction-fill for this question window."
    );
  }
  return true;
}

export function assertV3SubsetWindowKeyBinding(
  input: V3WindowKeyBindingInput
): boolean {
  const index = v3ClosureIndex(input.manifest);
  if (index === undefined) return false;
  const indexedKeys = new Set(Object.keys(index));
  const missing = [...new Set(requiredExtractionCacheKeys(input))]
    .filter((key) => !indexedKeys.has(key)).length;
  if (missing > 0) {
    throw new Error(
      "[longmemeval preflight] extraction cache complete fill has an invalid " +
        `consumer subwindow: ${missing} missing and 0 invalid required fixture(s).`
    );
  }
  return true;
}

export function requiredExtractionCacheKeys(
  input: RequiredExtractionCacheKeysInput
): readonly string[] {
  if (input.requiredExtractionTurns !== undefined) {
    return input.requiredExtractionTurns.flatMap((turn) =>
      computeExtractionTurnCacheKeys(
        input.model, input.requestProfile, input.systemPrompt, turn
      ));
  }
  return input.requiredTurnContents.flatMap((turnContent) =>
    computeSourceTurnCacheKeys(
      input.model, input.requestProfile, input.systemPrompt, { turnContent }
    ));
}

function v3ClosureIndex(manifest: ExtractionCacheManifest) {
  return manifest.schema_version === 3 ? manifest.content_closure_index : undefined;
}
