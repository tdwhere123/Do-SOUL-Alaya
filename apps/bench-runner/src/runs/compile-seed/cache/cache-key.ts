import type { ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import { createHash } from "node:crypto";
import {
  buildOfficialApiExtractionRequests,
  officialApiExtractionResponseSchema,
  stringifyOfficialApiExtractionRequest
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
  extractionRequest: '{"schema_version":2,"source_locator_contract_version":3,"batch_contract_version":1,"source_corpus_identity":"4f59a38bf6928c41ab6efd0c80fb480d2336a8ce210459597d2a816eb88066cd","batch_index":0,"batch_count":1,"source_assertions":[{"assertion_id":1,"text":"User: I enjoy coffee."}]}'
});

export function computeCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  extractionRequest: string
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
    .update(JSON.stringify(officialApiExtractionResponseSchema(extractionRequest) ?? null), "utf8")
    .digest("hex");
}

export function computeExtractionTurnCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  turn: LongMemEvalExtractionTurn,
  sourcePacking?: ExtractionSourcePacking
): string {
  return requireSingleCacheKey(computeExtractionTurnCacheKeys(
    model, requestProfile, systemPrompt, turn, sourcePacking
  ));
}

export function computeExtractionTurnCacheKeys(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  turn: LongMemEvalExtractionTurn,
  sourcePacking?: ExtractionSourcePacking
): readonly string[] {
  return computeSourceTurnCacheKeys(model, requestProfile, systemPrompt, turn, sourcePacking);
}

export function computeSourceTurnCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  input: Pick<LongMemEvalExtractionTurn, "turnContent"> &
    Partial<Pick<LongMemEvalExtractionTurn, "turnMessages">>,
  sourcePacking?: ExtractionSourcePacking
): string {
  return requireSingleCacheKey(computeSourceTurnCacheKeys(
    model, requestProfile, systemPrompt, input, sourcePacking
  ));
}

export function computeSourceTurnCacheKeys(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  input: Pick<LongMemEvalExtractionTurn, "turnContent"> &
    Partial<Pick<LongMemEvalExtractionTurn, "turnMessages">>,
  sourcePacking?: ExtractionSourcePacking
): readonly string[] {
  return Object.freeze(buildOfficialApiExtractionRequests(
    input.turnContent,
    input.turnMessages ?? [], sourcePacking
  ).map((request) => computeCacheKey(
    model,
    requestProfile,
    systemPrompt,
    stringifyOfficialApiExtractionRequest(request)
  )));
}

function requireSingleCacheKey(keys: readonly string[]): string {
  if (keys.length !== 1) {
    throw new ExtractionCacheInvariantError(
      "turn spans multiple extraction cache shards; use the plural cache-key API"
    );
  }
  return keys[0]!;
}
