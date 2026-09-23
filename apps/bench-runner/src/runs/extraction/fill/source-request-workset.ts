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

export type BatchExtractionSourceUnit = ReturnType<
  typeof planOfficialApiSemanticWorkset
>["units"][number] | ReturnType<typeof sourceSemanticTransportUnits>[number];

export interface SourceExtractionRequest {
  readonly line: SourceRequestLine;
  readonly request: ExtractionArtifactSource;
  readonly sourceTurn: LongMemEvalExtractionTurn;
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
  "config" | "datasetRevision" | "executionExtractionTurns" | "occurrenceExtractionTurns">;

/** Cache request shards and source work units retain separate identities. */
export function prepareSourceRequestWorkset(input: {
  readonly prepared: BatchPreparedSources;
  readonly cacheRoot: string;
  readonly turns?: readonly LongMemEvalExtractionTurn[];
  readonly executionCacheKeys?: ReadonlySet<string>;
}): SourceRequestWorkset {
  const prepared = input.prepared;
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
    if (cached.status === "invalid") {
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
      return Object.freeze({ line, request: item.request, sourceTurn: item.sourceTurn, units });
    }));
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
