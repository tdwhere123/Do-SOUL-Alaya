import { assertSourcePacketShardCapacity } from "../cache/source-packet-artifact.js";
import { assertSourceSemanticShardCapacity } from "../cache/source-semantic-artifact.js";
import { buildOfficialApiSourceCorpus, sourceSemanticTransportUnits } from "@do-soul/alaya-soul";
import { extractionArtifactPrompt, extractionArtifactRequests, extractionTypedArtifactMode,
  sourceSemanticArtifactPreparations, prepareSourceSemanticRequestLine,
  type ExtractionArtifactSource, type SourceSemanticArtifactPreparation,
  type SourceRequestLine } from "../request-artifact.js";
import { inspectCachedExtractionArtifact } from "../../compile-seed/cache/cache-shard.js";
import { createHash } from "node:crypto";
import {
  planOfficialApiSemanticWorkset
} from "@do-soul/alaya-soul";
import {
  computeCacheKey,
  computeExtractionTurnCacheKeys
} from "../../compile-seed/compile-seed-cache.js";
import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import {
  extractionRequestCoverageMemoKey,
  type LongMemEvalExtractionTurn
} from "../turn-contents.js";
import type { PreparedExtractionFill } from "./fill-preparation.js";
import type { SourceCensusRecord } from "../../snapshot/source-records/census.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";

export type BatchExtractionSourceUnit = ReturnType<
  typeof planOfficialApiSemanticWorkset
>["units"][number] | ReturnType<typeof sourceSemanticTransportUnits>[number];

export interface SourceExtractionRequest {
  readonly line: SourceRequestLine;
  readonly request: ExtractionArtifactSource;
  readonly sourceTurn?: LongMemEvalExtractionTurn;
  readonly sourceCorpus: string;
  readonly units: readonly BatchExtractionSourceUnit[];
}

export interface SourceRequestWorkset {
  readonly lines: readonly SourceRequestLine[];
  readonly requests: readonly SourceExtractionRequest[];
  readonly deterministicEmptyRequests: readonly SourceExtractionRequest[];
  readonly cachedRequests: readonly SourceExtractionRequest[];
  readonly units: readonly BatchExtractionSourceUnit[];
  readonly unsupportedSources: readonly UnsupportedSourceRequest[];
}

export type UnsupportedSourceRequest = Readonly<{
  messageIds: readonly string[];
  datasetRevision: string;
  disposition: Extract<SourceSemanticArtifactPreparation, { status: "unsupported_source" }>["disposition"];
  sourceUnitCount: number;
}>;

type BatchPreparedSources = Pick<PreparedExtractionFill,
  "config" | "datasetRevision" | "executionExtractionTurns" | "occurrenceExtractionTurns" | "nativeSourceRecords">;

/** Cache request shards and source work units retain separate identities. */
export function prepareSourceRequestWorkset(input: {
  readonly prepared: BatchPreparedSources;
  readonly cacheRoot: string;
  readonly turns?: readonly LongMemEvalExtractionTurn[];
  readonly executionCacheKeys?: ReadonlySet<string>;
}): SourceRequestWorkset {
  const prepared = input.prepared;
  if (prepared.nativeSourceRecords !== undefined) {
    return prepareNativeSourceRequestWorkset(input, prepared.nativeSourceRecords);
  }
  const turns = input.turns ?? prepared.executionExtractionTurns;
  const selectedKeys = selectedRequestKeys(prepared, turns, input.executionCacheKeys);
  const requests = collectBatchRequests(prepared, turns, selectedKeys);
  const unsupportedSources = collectUnsupportedSources(prepared, prepared.occurrenceExtractionTurns ?? turns);
  const lines: SourceRequestLine[] = [];
  const deterministicEmptyRequests: SourceExtractionRequest[] = [];
  const cachedRequests: SourceExtractionRequest[] = [];
  for (const item of requests) {
    const cached = inspectCachedExtractionArtifact(input.cacheRoot, item.line.key,
      prepared.config.model, prepared.config.requestProfile, extractionTypedArtifactMode(prepared.config));
    if (cached.status === "invalid" || cached.status === "retired") {
      throw new ExtractionCacheInvariantError(
        `Batch selected cache shard ${item.line.key} is invalid: ${cached.reason}`
      );
    }
    if (cached.status === "hit") cachedRequests.push(item);
    else if (item.request.source_assertions.length === 0) deterministicEmptyRequests.push(item);
    else lines.push(item.line);
  }
  return Object.freeze({
    lines: Object.freeze(lines),
    requests,
    deterministicEmptyRequests: Object.freeze(deterministicEmptyRequests),
    cachedRequests: Object.freeze(cachedRequests),
    units: Object.freeze(requests.flatMap((item) => item.units)),
    unsupportedSources
  });
}

function collectUnsupportedSources(prepared: BatchPreparedSources,
  turns: readonly LongMemEvalExtractionTurn[]): readonly UnsupportedSourceRequest[] {
  if (prepared.config.openSemantics === undefined) return [];
  const rows: UnsupportedSourceRequest[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const messageIds = turn.turnMessages.map((message) => message.message_id);
    for (const item of sourceSemanticArtifactPreparations(
      buildOfficialApiSourceCorpus(turn.turnContent, turn.turnMessages), prepared.config.sourcePacking, prepared.config.openSemantics)) {
      if (item.status !== "unsupported_source") continue;
      const identity = JSON.stringify([prepared.datasetRevision, messageIds, item.disposition.source_digest]);
      if (seen.has(identity)) throw new ExtractionCacheInvariantError("Batch unsupported source occurrence is duplicated");
      seen.add(identity);
      rows.push(Object.freeze({ messageIds, datasetRevision: prepared.datasetRevision,
        disposition: item.disposition, sourceUnitCount: item.source.source_assertions.length }));
    }
  }
  return Object.freeze(rows);
}

function selectedRequestKeys(
  prepared: BatchPreparedSources,
  turns: readonly LongMemEvalExtractionTurn[],
  allowlist: ReadonlySet<string> | undefined
): ReadonlySet<string> {
  const available = new Set(turns.flatMap((turn) => computeExtractionTurnCacheKeys(
    prepared.config.model, prepared.config.requestProfile, extractionArtifactPrompt(prepared.config.sourceInterpretationProfile, prepared.config.openSemantics), turn, prepared.config.sourcePacking, prepared.config.sourceInterpretationProfile, prepared.config.openSemantics
  )));
  if (allowlist === undefined) return available;
  for (const key of allowlist) {
    if (!available.has(key)) throw new ExtractionCacheInvariantError(
      "Batch execution key is outside the selected source window"
    );
  }
  return new Set(allowlist);
}

function collectBatchRequests(
  prepared: BatchPreparedSources,
  turns: readonly LongMemEvalExtractionTurn[],
  selectedKeys: ReadonlySet<string>
): readonly SourceExtractionRequest[] {
  const collected = new Map<string, {
    request: ExtractionArtifactSource;
    sourceTurn: LongMemEvalExtractionTurn;
    userPrompt: string;
    units: Map<string, BatchExtractionSourceUnit>;
  }>();
  const coverageMemo = new Map<string, readonly {
    request: ExtractionArtifactSource;
    userPrompt: string;
    key: string;
  }[]>();
  const occurrences = prepared.occurrenceExtractionTurns ?? turns;
  for (const turn of occurrences) {
    const prompts = coveragePrompts(prepared, turn, coverageMemo);
    if (!prompts.some((item) => selectedKeys.has(item.key))) continue;
    const units: readonly BatchExtractionSourceUnit[] = prepared.config.openSemantics === undefined
      ? planOfficialApiSemanticWorkset(turn.turnContent, turn.turnMessages, prepared.datasetRevision).units
      : sourceSemanticTransportUnits(buildOfficialApiSourceCorpus(turn.turnContent, turn.turnMessages),
        turn.turnMessages.map((message) => message.message_id), prepared.datasetRevision);
    const byAssertion = new Map(units.map((unit) => [unit.assertionId, unit]));
    for (const { request, userPrompt, key } of prompts) {
      if (!selectedKeys.has(key)) continue;
      const item = collected.get(key) ?? {
        request, sourceTurn: structuredClone(turn), userPrompt,
        units: new Map<string, BatchExtractionSourceUnit>()
      };
      for (const assertion of request.source_assertions) {
        const unit = byAssertion.get(assertion.assertion_id);
        if (unit === undefined || unit.text !== assertion.text) {
          throw new ExtractionCacheInvariantError("Batch request lost its source assertion binding");
        }
        item.units.set(unit.binding.occurrenceIdentity, unit);
      }
      collected.set(key, item);
    }
  }
  if (collected.size !== selectedKeys.size) throw new ExtractionCacheInvariantError(
    "Batch occurrence inventory does not cover the selected request window"
  );
  return Object.freeze([...collected].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => {
      const units = Object.freeze([...item.units.values()].sort((a, b) =>
        a.binding.occurrenceIdentity.localeCompare(b.binding.occurrenceIdentity)));
      const unitKeys = Object.freeze(units.map((unit) => unit.binding.occurrenceIdentity));
      const line: SourceRequestLine = prepared.config.openSemantics === undefined ? Object.freeze({
        key,
        unitKeys,
        requestSha256: createHash("sha256").update(item.userPrompt, "utf8").digest("hex"),
        systemPrompt: extractionArtifactPrompt(prepared.config.sourceInterpretationProfile, prepared.config.openSemantics),
        userPrompt: item.userPrompt
      }) : Object.freeze(prepareSourceSemanticRequestLine(JSON.parse(item.userPrompt), unitKeys, prepared.config));
      if (line.key !== key || line.userPrompt !== item.userPrompt) {
        throw new ExtractionCacheInvariantError("source request descriptor differs from its selected cache key");
      }
      const corpus = buildOfficialApiSourceCorpus(item.sourceTurn.turnContent, item.sourceTurn.turnMessages);
      if (prepared.config.sourceInterpretationProfile !== undefined) assertSourcePacketShardCapacity(corpus, line);
      if (prepared.config.openSemantics !== undefined) assertSourceSemanticShardCapacity(corpus, line);
      return Object.freeze({ line, request: item.request, sourceTurn: item.sourceTurn, sourceCorpus: corpus, units });
    }));
}

/** One exact native occurrence keeps its source record identity, without dialogue rendering. */
export function nativeSourceOccurrenceId(source: SourceCensusRecord): string {
  if (source.native_record_id === undefined) {
    throw new ExtractionCacheInvariantError("native source occurrence lacks its verified record identity");
  }
  return JSON.stringify([source.source_id, source.source_version, source.native_record_id]);
}

export function nativeSourceRequestInventory(
  records: readonly SourceCensusRecord[], datasetRevision: string,
  config: Pick<CompileSeedExtractionConfig,
    "model" | "requestProfile" | "sourcePacking" | "sourceInterpretationProfile" | "openSemantics">
): Readonly<{ requests: readonly SourceExtractionRequest[]; unsupportedSources: readonly UnsupportedSourceRequest[] }> {
  if (config.openSemantics === undefined || config.sourcePacking !== "complete-source") {
    throw new ExtractionCacheInvariantError("native source requests require complete-source semantics");
  }
  const collected = new Map<string, { line: SourceRequestLine; request: ExtractionArtifactSource;
    sourceCorpus: string; units: Map<string, BatchExtractionSourceUnit> }>();
  const unsupported: UnsupportedSourceRequest[] = [];
  for (const source of records) {
    const occurrenceId = nativeSourceOccurrenceId(source);
    const prepared = sourceSemanticArtifactPreparations(source.content_bytes, "complete-source", config.openSemantics,
      source.attribution_context);
    for (const item of prepared) {
      if (item.status === "unsupported_source") {
        unsupported.push(Object.freeze({ messageIds: [occurrenceId], datasetRevision,
          disposition: item.disposition, sourceUnitCount: item.source.source_assertions.length }));
        continue;
      }
      const units = sourceSemanticTransportUnits(source.content_bytes, [occurrenceId], datasetRevision);
      const byAssertion = new Map(units.map(unit => [unit.assertionId, unit]));
      const assigned = item.source.source_assertions.map(assertion => {
        const unit = byAssertion.get(assertion.assertion_id);
        if (unit === undefined || unit.text !== assertion.text) {
          throw new ExtractionCacheInvariantError("native source request lost exact assertion occurrence");
        }
        return unit;
      });
      const expectedLine = prepareSourceSemanticRequestLine(item.semantic, [], config);
      const existing = collected.get(expectedLine.key);
      if (existing !== undefined && (existing.sourceCorpus !== source.content_bytes ||
          existing.line.requestSha256 !== expectedLine.requestSha256)) {
        throw new ExtractionCacheInvariantError("native source request key spans different complete records");
      }
      const unitsByOccurrence = existing?.units ?? new Map<string, BatchExtractionSourceUnit>();
      for (const unit of assigned) unitsByOccurrence.set(unit.binding.occurrenceIdentity, unit);
      collected.set(expectedLine.key, { line: expectedLine, request: item.source,
        sourceCorpus: source.content_bytes, units: unitsByOccurrence });
    }
  }
  const requests = [...collected].sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => {
    const units = Object.freeze([...item.units.values()].sort((a, b) =>
      a.binding.occurrenceIdentity.localeCompare(b.binding.occurrenceIdentity)));
    const line = prepareSourceSemanticRequestLine(JSON.parse(item.line.userPrompt),
      units.map(unit => unit.binding.occurrenceIdentity), config);
    if (line.key !== key) throw new ExtractionCacheInvariantError("native source request key changed with occurrence assignment");
    assertSourceSemanticShardCapacity(item.sourceCorpus, line);
    return Object.freeze({ line, request: item.request, sourceCorpus: item.sourceCorpus, units });
  });
  return Object.freeze({ requests: Object.freeze(requests), unsupportedSources: Object.freeze(unsupported) });
}

function prepareNativeSourceRequestWorkset(input: Parameters<typeof prepareSourceRequestWorkset>[0],
  records: readonly SourceCensusRecord[]): SourceRequestWorkset {
  const inventory = nativeSourceRequestInventory(records, input.prepared.datasetRevision, input.prepared.config);
  const available = new Set(inventory.requests.map(item => item.line.key));
  const selected = input.executionCacheKeys ?? available;
  if ([...selected].some(key => !available.has(key))) {
    throw new ExtractionCacheInvariantError("native execution key is outside the verified source population");
  }
  const requests = inventory.requests.filter(item => selected.has(item.line.key));
  const lines: SourceRequestLine[] = [], cachedRequests: SourceExtractionRequest[] = [];
  const deterministicEmptyRequests: SourceExtractionRequest[] = [];
  for (const item of requests) {
    const cached = inspectCachedExtractionArtifact(input.cacheRoot, item.line.key,
      input.prepared.config.model, input.prepared.config.requestProfile, "open_semantics");
    if (cached.status === "invalid" || cached.status === "retired") {
      throw new ExtractionCacheInvariantError(`native source shard ${item.line.key} is ${cached.status}`);
    }
    if (cached.status === "hit") cachedRequests.push(item);
    else if (item.request.source_assertions.length === 0) deterministicEmptyRequests.push(item);
    else lines.push(item.line);
  }
  return Object.freeze({ requests: Object.freeze(requests), lines: Object.freeze(lines),
    cachedRequests: Object.freeze(cachedRequests), deterministicEmptyRequests: Object.freeze(deterministicEmptyRequests),
    units: Object.freeze(requests.flatMap(item => item.units)), unsupportedSources: inventory.unsupportedSources });
}

function coveragePrompts(
  prepared: BatchPreparedSources,
  turn: LongMemEvalExtractionTurn,
  memo: Map<string, readonly {
    request: ExtractionArtifactSource;
    userPrompt: string;
    key: string;
  }[]>
): readonly {
  request: ExtractionArtifactSource;
  userPrompt: string;
  key: string;
}[] {
  const memoKey = extractionRequestCoverageMemoKey(
    turn.turnContent, turn.turnMessages, prepared.config.sourcePacking
  );
  const cached = memo.get(memoKey);
  if (cached !== undefined) return cached;
  const prompts = Object.freeze(extractionArtifactRequests(turn, prepared.config.sourcePacking, prepared.config.sourceInterpretationProfile, prepared.config.openSemantics)
    .map(({ source: request, userPrompt }) => {
    return Object.freeze({
      request,
      userPrompt,
      key: computeCacheKey(
        prepared.config.model, prepared.config.requestProfile, extractionArtifactPrompt(prepared.config.sourceInterpretationProfile, prepared.config.openSemantics), userPrompt
      )
    });
  }));
  memo.set(memoKey, prompts);
  return prompts;
}
