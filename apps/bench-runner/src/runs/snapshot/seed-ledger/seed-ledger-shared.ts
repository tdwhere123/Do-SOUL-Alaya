import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExtractionContentClosureEntry } from
  "../../compile-seed/compile-seed-cache.js";
import type { ExtractionFillQuestionWindow } from
  "../../extraction/fill/manifest/fill-manifest-contract.js";
import type {
  LongMemEvalSnapshotSeedRound,
  SnapshotExtractionProvenanceV3
} from "../materialize.js";

export interface SnapshotSeedLedgerClosureAuthority {
  readonly kind: "exact" | "contained";
  readonly questionWindow: ExtractionFillQuestionWindow;
}

export interface LedgerTotals {
  attempts: number;
  factsProduced: number;
  parseDropped: number;
  compileOverflowDropped: number;
  candidateAbsent: number;
  materializationDrop: number;
}

export type CompleteExtraction = SnapshotExtractionProvenanceV3 & Required<Pick<
  SnapshotExtractionProvenanceV3,
  "expected_turns" | "expected_key_set_sha256" | "content_closure_sha256"
>>;

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function emptyTotals(): LedgerTotals {
  return {
    attempts: 0,
    factsProduced: 0,
    parseDropped: 0,
    compileOverflowDropped: 0,
    candidateAbsent: 0,
    materializationDrop: 0
  };
}

export function readRoundExtractionShards(
  round: LongMemEvalSnapshotSeedRound
): readonly NonNullable<LongMemEvalSnapshotSeedRound["extractionShards"]>[number][] {
  if (round.extractionShards !== undefined) return round.extractionShards;
  if (round.cacheKey === null || round.rawJsonSha256 === null ||
      round.rawSignalCount === null || round.draftCount === null) return [];
  return [{
    cacheKey: round.cacheKey,
    rawJsonSha256: round.rawJsonSha256,
    rawSignalCount: round.rawSignalCount,
    draftCount: round.draftCount
  }];
}

export function addClosureEntry(
  closure: Map<string, ExtractionContentClosureEntry>,
  round: LongMemEvalSnapshotSeedRound,
  extraction: CompleteExtraction
): void {
  for (const shard of readRoundExtractionShards(round)) {
    const entry = {
      cacheKey: shard.cacheKey,
      model: extraction.extraction_model,
      requestProfile: extraction.request_profile,
      rawJsonSha256: shard.rawJsonSha256,
      rawSignalCount: shard.rawSignalCount,
      parsedDraftCount: shard.draftCount
    };
    const prior = closure.get(entry.cacheKey);
    if (prior !== undefined && !isDeepStrictEqual(prior, entry)) {
      throw new Error("snapshot seed ledger repeats a cache key with different content");
    }
    closure.set(entry.cacheKey, entry);
  }
}

export function addTotals(totals: LedgerTotals, round: LongMemEvalSnapshotSeedRound): void {
  totals.attempts += readRoundExtractionShards(round).length;
  totals.factsProduced += round.factsProduced;
  totals.parseDropped += round.parseDropped;
  totals.compileOverflowDropped += round.compileOverflowDropped;
  totals.candidateAbsent += round.candidateAbsent;
  totals.materializationDrop += round.materializationDrop;
}
