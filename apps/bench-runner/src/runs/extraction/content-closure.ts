import { createHash } from "node:crypto";
import { parseOfficialApiSignals } from "@do-soul/alaya-soul";
import { SourceInterpretationResponseEnvelopeSchema, SourceInterpretationRelationSchema } from "@do-soul/alaya-protocol";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { ExtractionCacheInvariantError } from "./cache/cache-invariant-error.js";
import {
  catalogEligibilityOfAssertionCount,
  classifyExtractionEnvelope,
  extractionEnvelopeCountsTowardCoverage,
  EXTRACTION_SEMANTIC_PRESERVATION_FROM_REQUEST,
  type ExtractionCatalogEligibility,
  type ExtractionRequestCompletion,
  type ExtractionEmptyClassification
} from "./empty-classification.js";

export interface ExtractionRawJsonInspection {
  readonly rawJsonSha256: string;
  readonly rawSignalCount: number;
  readonly parsedDraftCount: number;
  readonly emptyClassification?: ExtractionEmptyClassification;
}

export type ExtractionRawEnvelopeInspection = Readonly<{
  readonly rawJsonSha256: string;
  readonly rawSignalCount: number;
  readonly emptyClassification?: ExtractionEmptyClassification;
  readonly catalogEligibility?: ExtractionCatalogEligibility;
  readonly semanticPreservation?: typeof EXTRACTION_SEMANTIC_PRESERVATION_FROM_REQUEST;
}>;

export type ExtractionEnvelopeClassificationContext = Readonly<{
  readonly sourceAssertionCount: number;
  readonly planMembership: "in_plan" | "skipped";
  readonly requestCompletion?: ExtractionRequestCompletion;
}>;

export interface ExtractionContentClosureEntry extends ExtractionRawJsonInspection {
  readonly cacheKey: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
}

export type ExtractionRawContentClosureEntry = Omit<
  ExtractionContentClosureEntry,
  "parsedDraftCount"
>;

export type ExtractionContentClosureIndexValue = readonly [
  rawJsonSha256: string,
  rawSignalCount: number,
  parsedDraftCount: number
];

export type ExtractionContentClosureIndex = Readonly<Record<
  string,
  ExtractionContentClosureIndexValue
>>;

export function computeExtractionRawJsonSha256(rawJson: string): string {
  return createHash("sha256").update(rawJson, "utf8").digest("hex");
}

export function inspectExtractionRawJson(
  rawJson: string,
  classificationContext?: ExtractionEnvelopeClassificationContext
): ExtractionRawJsonInspection {
  const envelope = inspectExtractionRawEnvelope(rawJson, classificationContext);
  return { ...envelope, parsedDraftCount: countParsedDrafts(rawJson) };
}

export function inspectExtractionRawEnvelope(
  rawJson: string,
  classificationContext?: ExtractionEnvelopeClassificationContext
): ExtractionRawEnvelopeInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch (cause) {
    throw new Error("extraction raw_json is not strict JSON", { cause });
  }
  const rawSignalCount = countRawEnvelopeSignals(parsed);
  if (rawSignalCount === null) {
    if (isPlanSkippedRawEnvelope(parsed)) {
      return classifiedEnvelope(rawJson, 0, {
        sourceAssertionCount: classificationContext?.sourceAssertionCount ?? 0,
        planMembership: "skipped"
      });
    }
    throw new Error("signals array missing");
  }
  if (classificationContext !== undefined) {
    return classifiedEnvelope(rawJson, rawSignalCount, classificationContext);
  }
  // Empty envelopes without assertion context stay unclassified so callers
  // cannot treat them as coverage-valid success by rawSignalCount alone.
  return {
    rawJsonSha256: computeExtractionRawJsonSha256(rawJson),
    rawSignalCount
  };
}

function classifiedEnvelope(
  rawJson: string,
  rawSignalCount: number,
  classificationContext: ExtractionEnvelopeClassificationContext
): ExtractionRawEnvelopeInspection {
  return {
    rawJsonSha256: computeExtractionRawJsonSha256(rawJson),
    rawSignalCount,
    emptyClassification: classifyExtractionEnvelope({
      rawSignalCount,
      sourceAssertionCount: classificationContext.sourceAssertionCount,
      planMembership: classificationContext.planMembership,
      requestCompletion: classificationContext.requestCompletion
    }),
    catalogEligibility: catalogEligibilityOfAssertionCount(
      classificationContext.sourceAssertionCount
    ),
    semanticPreservation: EXTRACTION_SEMANTIC_PRESERVATION_FROM_REQUEST
  };
}

/** Reject envelopes that must not count as coverage-valid success. */
export function assertCoverageValidExtractionEnvelope(
  inspection: Pick<ExtractionRawEnvelopeInspection, "emptyClassification" | "rawSignalCount">,
  classificationContext?: ExtractionEnvelopeClassificationContext
): ExtractionEmptyClassification {
  const emptyClassification = inspection.emptyClassification ?? (
    classificationContext === undefined
      ? undefined
      : classifyExtractionEnvelope({
        rawSignalCount: inspection.rawSignalCount,
        sourceAssertionCount: classificationContext.sourceAssertionCount,
        planMembership: classificationContext.planMembership,
        requestCompletion: classificationContext.requestCompletion
      })
  );
  if (emptyClassification === undefined) {
    throw new Error(
      "empty extraction envelope lacks classification; assertion context is required"
    );
  }
  if (!extractionEnvelopeCountsTowardCoverage(emptyClassification)) {
    throw new Error(
      `${emptyClassification} is not a coverage-valid extraction envelope`
    );
  }
  return emptyClassification;
}

export function computeExtractionKeySetSha256(keys: Iterable<string>): string {
  return createHash("sha256")
    .update([...new Set(keys)].sort().join("\n"), "utf8")
    .digest("hex");
}

export function computeExtractionContentClosureSha256(
  entries: readonly ExtractionContentClosureEntry[]
): string {
  const rows = [...uniqueEntriesByKey(entries).values()]
    .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey))
    .map((entry) => JSON.stringify([
      entry.cacheKey,
      entry.model,
      entry.requestProfile,
      entry.rawJsonSha256,
      entry.rawSignalCount,
      entry.parsedDraftCount
    ]));
  return createHash("sha256").update(rows.join("\n"), "utf8").digest("hex");
}

export function computeExtractionRawContentClosureSha256(
  entries: readonly ExtractionRawContentClosureEntry[]
): string {
  const rows = [...uniqueEntriesByKey(entries).values()]
    .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey))
    .map((entry) => JSON.stringify([
      entry.cacheKey,
      entry.model,
      entry.requestProfile,
      entry.rawJsonSha256,
      entry.rawSignalCount
    ]));
  return createHash("sha256").update(rows.join("\n"), "utf8").digest("hex");
}

export function buildExtractionContentClosureIndex(
  entries: readonly ExtractionContentClosureEntry[]
): ExtractionContentClosureIndex {
  return Object.fromEntries([...uniqueEntriesByKey(entries).values()]
    .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey))
    .map((entry) => [entry.cacheKey, [
      entry.rawJsonSha256,
      entry.rawSignalCount,
      entry.parsedDraftCount
    ] as const]));
}

export function extractionContentClosureEntriesFromIndex(
  index: ExtractionContentClosureIndex,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]
): readonly ExtractionContentClosureEntry[] {
  return Object.entries(index).map(([
    cacheKey,
    [rawJsonSha256, rawSignalCount, parsedDraftCount]
  ]) => ({
    cacheKey,
    model,
    requestProfile,
    rawJsonSha256,
    rawSignalCount,
    parsedDraftCount
  }));
}

function uniqueEntriesByKey<T extends { readonly cacheKey: string }>(
  entries: readonly T[]
): ReadonlyMap<string, T> {
  const byKey = new Map(entries.map((entry) => [entry.cacheKey, entry] as const));
  if (byKey.size === entries.length) return byKey;
  throw new ExtractionCacheInvariantError(
    "extraction content closure contains duplicate cache keys"
  );
}

function countRawEnvelopeSignals(parsed: unknown): number | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const interpretations = (parsed as { readonly interpretations?: unknown }).interpretations;
  if (Array.isArray(interpretations)) return interpretations.length;
  const signals = (parsed as { readonly signals?: unknown }).signals;
  return Array.isArray(signals) ? signals.length : null;
}

function countParsedDrafts(rawJson: string): number {
  const parsed = JSON.parse(rawJson) as { readonly interpretations?: unknown; readonly signals?: unknown };
  if (Array.isArray(parsed.interpretations)) {
    const envelope = SourceInterpretationResponseEnvelopeSchema.parse(parsed);
    return envelope.interpretations.filter((entry) => entry.relations.some((relation) =>
      SourceInterpretationRelationSchema.safeParse(relation).success)).length;
  }
  return parseOfficialApiSignals(rawJson).length;
}

function isPlanSkippedRawEnvelope(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  return (parsed as { readonly extraction_skip?: unknown }).extraction_skip ===
    "plan_skipped";
}
