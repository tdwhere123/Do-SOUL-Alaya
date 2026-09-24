import { extractionArtifactRequests } from "../../extraction/request-artifact.js";
import type { SourceInterpretationProfile, ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import type { ExtractionOpenSemanticsGeneration } from "../../extraction/request-artifact.js";
import { createHash } from "node:crypto";
import { geminiGenerationSchemaCacheMaterial } from "../../extraction/fill/batch/generation-schema.js";
import {
  officialApiExtractionResponseSchemaPreimage, retainedOfficialApiExtractionResponseSchemaPreimage
} from "@do-soul/alaya-soul";
import { ExtractionCacheInvariantError } from
  "../../extraction/cache/cache-invariant-error.js";
import type { LongMemEvalExtractionTurn } from
  "../../extraction/turn-contents.js";
import type { CompileSeedExtractionConfig } from "../compile-seed-types.js";

export const EXTRACTION_CACHE_KEY_GOLDEN_VECTOR = Object.freeze({
  model: "alaya-cache-key-golden-model",
  requestProfile: "provider-default-v1" as CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: "alaya-cache-key-golden-system-prompt",
  extractionRequest: '{"schema_version":2,"source_locator_contract_version":4,"batch_contract_version":1,"source_corpus_identity":"5cfbac30da538a52d242938adeb5c71ff1b3dc07bc4ce8330878da4318a01a2b","batch_index":0,"batch_count":1,"source_assertions":[{"assertion_id":1,"text":"User: I enjoy coffee."}]}'
});

export function computeCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  extractionRequest: string
): string {
  return hashCacheIdentity(
    model,
    requestProfile,
    systemPrompt,
    extractionRequest,
    generationSchemaCacheMaterial(extractionRequest, model)
  );
}

/** Original cache-key material is reconstructed for retained evidence, never for a fresh request. */
export function computeRetainedCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  extractionRequest: string
): string {
  return hashCacheIdentity(model, requestProfile, systemPrompt, extractionRequest,
    generationSchemaCacheMaterial(extractionRequest, model, true));
}

export function computeOfficialApiRequestCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  extractionRequest: string
): string {
  return computeCacheKey(model, requestProfile, systemPrompt, extractionRequest);
}

function generationSchemaCacheMaterial(extractionRequest: string, model: string, retained = false): string {
  const preimage = retained ? retainedOfficialApiExtractionResponseSchemaPreimage(extractionRequest)
    : officialApiExtractionResponseSchemaPreimage(extractionRequest);
  return model.startsWith("gemini-") ? geminiGenerationSchemaCacheMaterial(preimage) : preimage;
}

export function computeExtractionTurnCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  turn: LongMemEvalExtractionTurn,
  sourcePacking?: ExtractionSourcePacking,
  sourceInterpretationProfile?: SourceInterpretationProfile,
  openSemantics?: ExtractionOpenSemanticsGeneration
): string {
  return requireSingleCacheKey(computeExtractionTurnCacheKeys(
    model, requestProfile, systemPrompt, turn, sourcePacking, sourceInterpretationProfile, openSemantics
  ));
}

export function computeExtractionTurnCacheKeys(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  turn: LongMemEvalExtractionTurn,
  sourcePacking?: ExtractionSourcePacking,
  sourceInterpretationProfile?: SourceInterpretationProfile,
  openSemantics?: ExtractionOpenSemanticsGeneration
): readonly string[] {
  return computeSourceTurnCacheKeys(model, requestProfile, systemPrompt, turn, sourcePacking, sourceInterpretationProfile, openSemantics);
}

export function computeSourceTurnCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  input: Pick<LongMemEvalExtractionTurn, "turnContent"> &
    Partial<Pick<LongMemEvalExtractionTurn, "turnMessages">>,
  sourcePacking?: ExtractionSourcePacking,
  sourceInterpretationProfile?: SourceInterpretationProfile,
  openSemantics?: ExtractionOpenSemanticsGeneration
): string {
  return requireSingleCacheKey(computeSourceTurnCacheKeys(
    model, requestProfile, systemPrompt, input, sourcePacking, sourceInterpretationProfile, openSemantics
  ));
}

export function computeSourceTurnCacheKeys(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  input: Pick<LongMemEvalExtractionTurn, "turnContent"> &
    Partial<Pick<LongMemEvalExtractionTurn, "turnMessages">>,
  sourcePacking?: ExtractionSourcePacking,
  sourceInterpretationProfile?: SourceInterpretationProfile,
  openSemantics?: ExtractionOpenSemanticsGeneration
): readonly string[] {
  return Object.freeze(extractionArtifactRequests(input, sourcePacking, sourceInterpretationProfile, openSemantics)
    .map(({ userPrompt }) => computeCacheKey(model, requestProfile, systemPrompt, userPrompt)));
}

function hashCacheIdentity(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  extractionRequest: string,
  responseSchemaJson: string
): string {
  return createHash("sha256")
    .update(model, "utf8")
    .update("\u0000", "utf8")
    .update(requestProfile, "utf8")
    .update("\u0000", "utf8")
    .update(systemPrompt, "utf8")
    .update("\u0000", "utf8")
    .update(extractionRequest, "utf8")
    .update("\u0000", "utf8")
    .update(responseSchemaJson, "utf8")
    .digest("hex");
}

function requireSingleCacheKey(keys: readonly string[]): string {
  if (keys.length !== 1) {
    throw new ExtractionCacheInvariantError(
      "turn spans multiple extraction cache shards; use the plural cache-key API"
    );
  }
  return keys[0]!;
}
