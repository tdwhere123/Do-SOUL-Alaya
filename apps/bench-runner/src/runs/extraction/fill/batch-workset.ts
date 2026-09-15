import { createHash } from "node:crypto";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  collectOfficialApiExtractionCoverage,
  planOfficialApiSemanticWorkset,
  stringifyOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  computeOfficialApiRequestCacheKey,
  computeExtractionTurnCacheKeys,
  inspectCachedExtraction
} from "../../compile-seed/compile-seed-cache.js";
import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import {
  extractionRequestCoverageMemoKey,
  type LongMemEvalExtractionTurn
} from "../turn-contents.js";
import type { GeminiBatchLine } from "./batch/contract.js";
import type { PreparedExtractionFill } from "./fill-preparation.js";

export type BatchExtractionSourceUnit = ReturnType<
  typeof planOfficialApiSemanticWorkset
>["units"][number];

export interface BatchExtractionRequest {
  readonly line: GeminiBatchLine;
  readonly request: OfficialApiExtractionRequest;
  readonly sourceTurn: LongMemEvalExtractionTurn;
  readonly units: readonly BatchExtractionSourceUnit[];
}

export interface BatchExtractionWorkset {
  readonly lines: readonly GeminiBatchLine[];
  readonly requests: readonly BatchExtractionRequest[];
  readonly deterministicEmptyRequests: readonly BatchExtractionRequest[];
  readonly cachedRequests: readonly BatchExtractionRequest[];
  readonly units: readonly BatchExtractionSourceUnit[];
}

type BatchPreparedSources = Pick<PreparedExtractionFill,
  "config" | "datasetRevision" | "executionExtractionTurns" | "occurrenceExtractionTurns">;

/** Cache request shards and source work units retain separate identities. */
export function prepareBatchExtractionWorkset(input: {
  readonly prepared: BatchPreparedSources;
  readonly cacheRoot: string;
  readonly turns?: readonly LongMemEvalExtractionTurn[];
  readonly executionCacheKeys?: ReadonlySet<string>;
}): BatchExtractionWorkset {
  const prepared = input.prepared;
  const turns = input.turns ?? prepared.executionExtractionTurns;
  const selectedKeys = selectedRequestKeys(prepared, turns, input.executionCacheKeys);
  const requests = collectBatchRequests(prepared, turns, selectedKeys);
  const lines: GeminiBatchLine[] = [];
  const deterministicEmptyRequests: BatchExtractionRequest[] = [];
  const cachedRequests: BatchExtractionRequest[] = [];
  for (const item of requests) {
    const cached = inspectCachedExtraction(input.cacheRoot, item.line.key,
      prepared.config.model, prepared.config.requestProfile);
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
    units: Object.freeze(requests.flatMap((item) => item.units))
  });
}

function selectedRequestKeys(
  prepared: BatchPreparedSources,
  turns: readonly LongMemEvalExtractionTurn[],
  allowlist: ReadonlySet<string> | undefined
): ReadonlySet<string> {
  const available = new Set(turns.flatMap((turn) => computeExtractionTurnCacheKeys(
    prepared.config.model, prepared.config.requestProfile, OFFICIAL_API_SYSTEM_PROMPT, turn, prepared.config.sourcePacking
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
): readonly BatchExtractionRequest[] {
  const collected = new Map<string, {
    request: OfficialApiExtractionRequest;
    sourceTurn: LongMemEvalExtractionTurn;
    userPrompt: string;
    units: Map<string, BatchExtractionSourceUnit>;
  }>();
  const coverageMemo = new Map<string, readonly {
    request: OfficialApiExtractionRequest;
    userPrompt: string;
    key: string;
  }[]>();
  const occurrences = prepared.occurrenceExtractionTurns ?? turns;
  for (const turn of occurrences) {
    const prompts = coveragePrompts(prepared, turn, coverageMemo);
    if (!prompts.some((item) => selectedKeys.has(item.key))) continue;
    const workset = planOfficialApiSemanticWorkset(
      turn.turnContent, turn.turnMessages, prepared.datasetRevision
    );
    const byAssertion = new Map(workset.units.map((unit) => [unit.assertionId, unit]));
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
      const line: GeminiBatchLine = Object.freeze({
        key,
        unitKeys: Object.freeze(units.map((unit) => unit.binding.occurrenceIdentity)),
        requestSha256: createHash("sha256").update(item.userPrompt, "utf8").digest("hex"),
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        userPrompt: item.userPrompt
      });
      return Object.freeze({ line, request: item.request, sourceTurn: item.sourceTurn, units });
    }));
}

function coveragePrompts(
  prepared: BatchPreparedSources,
  turn: LongMemEvalExtractionTurn,
  memo: Map<string, readonly {
    request: OfficialApiExtractionRequest;
    userPrompt: string;
    key: string;
  }[]>
): readonly {
  request: OfficialApiExtractionRequest;
  userPrompt: string;
  key: string;
}[] {
  const memoKey = extractionRequestCoverageMemoKey(
    turn.turnContent, turn.turnMessages, prepared.config.sourcePacking
  );
  const cached = memo.get(memoKey);
  if (cached !== undefined) return cached;
  const prompts = Object.freeze(collectOfficialApiExtractionCoverage(
    turn.turnContent, turn.turnMessages, prepared.config.sourcePacking
  ).requests.map((request) => {
    const userPrompt = stringifyOfficialApiExtractionRequest(request);
    return Object.freeze({
      request,
      userPrompt,
      key: computeOfficialApiRequestCacheKey(
        prepared.config.model, prepared.config.requestProfile, OFFICIAL_API_SYSTEM_PROMPT, userPrompt
      )
    });
  }));
  memo.set(memoKey, prompts);
  return prompts;
}
