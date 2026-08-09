import { createHash } from "node:crypto";
import {
  buildOfficialApiExtractionRequests,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { ExtractionCacheInvariantError } from
  "../../extraction/cache/cache-invariant-error.js";
import type { LongMemEvalExtractionTurn } from
  "../../extraction/turn-contents.js";
import type { CompileSeedExtractionConfig } from "../compile-seed-types.js";

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
    .digest("hex");
}

export function computeExtractionTurnCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  turn: LongMemEvalExtractionTurn
): string {
  return requireSingleCacheKey(computeExtractionTurnCacheKeys(
    model, requestProfile, systemPrompt, turn
  ));
}

export function computeExtractionTurnCacheKeys(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  turn: LongMemEvalExtractionTurn
): readonly string[] {
  return computeSourceTurnCacheKeys(model, requestProfile, systemPrompt, turn);
}

export function computeSourceTurnCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  input: Pick<LongMemEvalExtractionTurn, "turnContent"> &
    Partial<Pick<LongMemEvalExtractionTurn, "turnMessages">>
): string {
  return requireSingleCacheKey(computeSourceTurnCacheKeys(
    model, requestProfile, systemPrompt, input
  ));
}

export function computeSourceTurnCacheKeys(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  input: Pick<LongMemEvalExtractionTurn, "turnContent"> &
    Partial<Pick<LongMemEvalExtractionTurn, "turnMessages">>
): readonly string[] {
  return Object.freeze(buildOfficialApiExtractionRequests(
    input.turnContent,
    input.turnMessages ?? []
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
