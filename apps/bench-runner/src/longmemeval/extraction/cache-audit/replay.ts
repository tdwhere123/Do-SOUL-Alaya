import { createHash } from "node:crypto";
import { auditOfficialApiSignalFormation } from "@do-soul/alaya-soul";
import {
  inspectCachedExtraction,
  type CachedExtractionInspection
} from "../../compile-seed/compile-seed-cache.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import type { ExtractionOccurrence } from "./occurrence-index.js";

export type ExtractionReplayDisposition = "admitted" | "deferred" | "rejected" | "invalid";

export interface ExtractionReplayEntry {
  readonly index: number;
  readonly disposition: ExtractionReplayDisposition;
  readonly stage: string;
  readonly reason: string;
  readonly sourceAssertion?: string;
  readonly formedContentSha256?: string;
}

export interface ExtractionReplayOccurrence {
  readonly occurrence: ExtractionOccurrence;
  readonly rawJsonSha256: string | null;
  readonly entries: readonly ExtractionReplayEntry[];
}

export interface ExtractionReplayResult {
  readonly occurrences: readonly ExtractionReplayOccurrence[];
  readonly closure: Readonly<{
    occurrenceCount: number;
    accountedOccurrences: number;
    elementCount: number;
    accountedElements: number;
    admitted: number;
    deferred: number;
    rejected: number;
    invalid: number;
    ledgerSha256: string;
  }>;
}

export type ExtractionReplayAuditor = (
  input: Parameters<typeof auditOfficialApiSignalFormation>[0]
) => Readonly<{
  entries: ReturnType<typeof auditOfficialApiSignalFormation>["entries"];
}>;

export function replayExtractionOccurrences(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly occurrences: readonly ExtractionOccurrence[];
  readonly audit?: ExtractionReplayAuditor;
}): ExtractionReplayResult {
  const cached = new Map<string, CachedExtractionInspection>();
  const audit = input.audit ?? auditOfficialApiSignalFormation;
  const occurrences = input.occurrences.map((occurrence) => replayOccurrence({
    ...input, occurrence, cached, audit
  })).sort(compareReplayOccurrences);
  return Object.freeze({ occurrences: Object.freeze(occurrences), closure: closeReplay(occurrences) });
}

export function hashExtractionReplay(result: ExtractionReplayResult): string {
  return hashReplayOccurrences(result.occurrences);
}

function hashReplayOccurrences(occurrences: readonly ExtractionReplayOccurrence[]): string {
  const canonical = occurrences.map((occurrence) => ({
    occurrence_id: occurrence.occurrence.id,
    cache_key: occurrence.occurrence.cacheKey,
    source_observed_at: occurrence.occurrence.sourceObservedAt,
    raw_json_sha256: occurrence.rawJsonSha256,
    entries: occurrence.entries
  }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function replayOccurrence(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly occurrence: ExtractionOccurrence;
  readonly cached: Map<string, CachedExtractionInspection>;
  readonly audit: ExtractionReplayAuditor;
}): ExtractionReplayOccurrence {
  const cached = cachedExtraction(input);
  if (cached.status !== "hit") return unavailableOccurrence(input.occurrence, cached);
  const result = input.audit({
    raw_json: cached.rawJson,
    turn_content: input.occurrence.turnContent,
    turn_messages: input.occurrence.turnMessages,
    workspace_id: replayScopedId("workspace", input.occurrence.id),
    run_id: replayScopedId("run", input.occurrence.id),
    surface_id: null,
    created_at: input.occurrence.sourceObservedAt,
    source_observed_at: input.occurrence.sourceObservedAt,
    require_source_observed_at: true,
    signal_id_for: (index) => replayScopedId("signal", `${input.occurrence.id}:${index}`)
  });
  return Object.freeze({
    occurrence: input.occurrence,
    rawJsonSha256: cached.rawJsonSha256,
    entries: Object.freeze(result.entries.map((entry) => Object.freeze({
      index: entry.index,
      disposition: entry.disposition,
      stage: entry.stage,
      reason: entry.reason,
      ...formationCommitment(entry.signal)
    })))
  });
}

function formationCommitment(
  signal: ReturnType<typeof auditOfficialApiSignalFormation>["entries"][number]["signal"]
): Pick<ExtractionReplayEntry, "sourceAssertion" | "formedContentSha256"> {
  if (signal === undefined) return {};
  const raw = signal.raw_payload;
  const sourceAssertion = typeof raw.source_assertion === "string"
    ? raw.source_assertion
    : undefined;
  const content = {
    source_assertion: sourceAssertion ?? null,
    matched_text: typeof raw.matched_text === "string" ? raw.matched_text : null,
    distilled_fact: typeof raw.distilled_fact === "string" ? raw.distilled_fact : null,
    full_turn_content: typeof raw.full_turn_content === "string" ? raw.full_turn_content : null
  };
  return {
    ...(sourceAssertion === undefined ? {} : { sourceAssertion }),
    formedContentSha256: createHash("sha256")
      .update(JSON.stringify(content), "utf8")
      .digest("hex")
  };
}

function cachedExtraction(input: Parameters<typeof replayOccurrence>[0]): CachedExtractionInspection {
  const existing = input.cached.get(input.occurrence.cacheKey);
  if (existing !== undefined) return existing;
  const inspected = inspectCachedExtraction(
    input.cacheRoot, input.occurrence.cacheKey, input.model, input.requestProfile
  );
  input.cached.set(input.occurrence.cacheKey, inspected);
  return inspected;
}

function unavailableOccurrence(
  occurrence: ExtractionOccurrence,
  cached: Exclude<CachedExtractionInspection, { readonly status: "hit" }>
): ExtractionReplayOccurrence {
  const reason = cached.status === "missing" ? "shard_missing" : `shard_invalid:${cached.reason}`;
  return Object.freeze({
    occurrence,
    rawJsonSha256: null,
    entries: Object.freeze([{
      index: -1,
      disposition: "invalid" as const,
      stage: "cache",
      reason
    }])
  });
}

function closeReplay(
  occurrences: readonly ExtractionReplayOccurrence[]
): ExtractionReplayResult["closure"] {
  const entries = occurrences.flatMap((occurrence) => occurrence.entries);
  const count = (disposition: ExtractionReplayDisposition) =>
    entries.filter((entry) => entry.disposition === disposition).length;
  return Object.freeze({
    occurrenceCount: occurrences.length,
    accountedOccurrences: occurrences.length,
    elementCount: entries.length,
    accountedElements: entries.length,
    admitted: count("admitted"),
    deferred: count("deferred"),
    rejected: count("rejected"),
    invalid: count("invalid"),
    ledgerSha256: hashReplayOccurrences(occurrences)
  });
}

function replayScopedId(prefix: string, value: string): string {
  return `cache-audit-${prefix}-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function compareReplayOccurrences(
  left: ExtractionReplayOccurrence,
  right: ExtractionReplayOccurrence
): number {
  return left.occurrence.id.localeCompare(right.occurrence.id);
}
