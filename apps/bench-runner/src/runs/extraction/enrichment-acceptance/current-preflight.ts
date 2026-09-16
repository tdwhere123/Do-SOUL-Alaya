import { createHash } from "node:crypto";
import {
  DEFAULT_EXTRACTION_SOURCE_PACKING,
  extractionSourcePackingSize,
  SOURCE_INTERPRETATION_CONTRACT,
  type ExtractionSourcePacking
} from "@do-soul/alaya-protocol";
import {
  OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
  OFFICIAL_API_FORMATION_AUDIT_SEMANTICS_VERSION,
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
  OFFICIAL_API_SYSTEM_PROMPT,
  officialApiSemanticWorksetFromUnits,
  planOfficialApiTransport,
  type OfficialApiSemanticWorkUnit,
  type TransportPack
} from "@do-soul/alaya-soul";
import { loadDatasetWindowWithIdentity } from "../../../datasets/longmemeval/ingestion/fetch.js";
import { EXTRACTION_CACHE_KEY_ALGO } from "../cache/extraction-cache-manifest.js";
import type { PreparedExtractionFill } from "../fill/fill-preparation.js";
import { prepareBatchExtractionWorkset } from "../fill/batch-workset.js";
import {
  batchDigest,
  canonicalBatchPlan,
  prepareBatchJobs
} from "../fill/batch/plan.js";
import { acquireExtractionCacheWriteLease } from "../fill/manifest/fill-root-guard.js";
import { prepareSemanticFill } from "../fill/semantic-fill-plan.js";
import { collectSemanticFillTasks } from "../fill/semantic-workset-tasks.js";
import type { SemanticFillAttempt } from "../fill/semantic-fill-executor.js";
import {
  inspectTurnContentKeySpace,
  type LongMemEvalExtractionTurn
} from "../turn-contents.js";
import type { FrozenAssertion } from "./frozen-population.js";
import { collectEnrichmentOccurrenceProvenance, type EnrichmentOccurrenceProvenance } from "./source-provenance.js";

export const ENRICHMENT_PREFLIGHT_MODEL = "gemini-3.1-flash-lite";
export const ENRICHMENT_PREFLIGHT_REQUEST_PROFILE = "gemini-3.1-low-v1";
export const ENRICHMENT_PREFLIGHT_MAX_OUTPUT_TOKENS = 4096;
export const ENRICHMENT_PREFLIGHT_CAPABILITY = "official_api_signals:v1";
const ENRICHMENT_PREFLIGHT_PROVIDER_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";

const SIZING_LIMITS = Object.freeze({
  maxJobs: 400,
  maxRequestsPerJob: 400,
  maxFileBytes: 8 * 1024 * 1024,
  maxInputTokensPerJob: 8_000_000,
  maxEnqueuedTokens: 8_000_000,
  maxOutputTokens: ENRICHMENT_PREFLIGHT_MAX_OUTPUT_TOKENS,
  maxUsd: 17,
  inputUsdPerMillion: 0.125,
  outputUsdPerMillion: 0.75,
  deadlineMs: 86_400_000,
  requestTimeoutMs: 30_000,
  maxPolls: 96
});

export interface EnrichmentPreflightIdentities {
  readonly capability: typeof ENRICHMENT_PREFLIGHT_CAPABILITY;
  readonly wire_contract: typeof SOURCE_INTERPRETATION_CONTRACT;
  readonly prompt_sha256: string;
  readonly parser: string;
  readonly request_schema_version: number;
  readonly source_locator_contract_version: number;
  readonly formation_audit: string;
  readonly model: string;
  readonly request_profile: string;
  readonly max_output_tokens: number;
  readonly source_packing: ExtractionSourcePacking;
  readonly cache_key_algorithm: string;
  readonly dataset_sha256: string | null;
}

export interface EnrichmentPreflightRequest {
  readonly key: string;
  readonly source_corpus_identity: string;
  readonly assertion_ids: readonly number[];
  readonly assertion_texts: readonly string[];
  readonly occurrence_provenance: readonly EnrichmentOccurrenceProvenance[];
  readonly user_prompt: string;
  readonly unit_keys: readonly string[];
  readonly message_ids: readonly string[];
}

export interface EnrichmentNativeLineBound {
  readonly key: string;
  readonly status: "sized" | "unresolved";
  readonly input_bound?: number;
  readonly file_bytes?: number;
  readonly cost_bound_usd?: number;
  readonly reason?: string;
}

export interface EnrichmentSemanticFillCapture {
  readonly status: "prepared" | "not_run";
  readonly reason: string | null;
  readonly unresolved: number | null;
  readonly uniqueUnits: number | null;
  readonly occurrenceCount: number | null;
  readonly bindingCount: number | null;
}

export interface EnrichmentPreflight {
  readonly identities: EnrichmentPreflightIdentities;
  readonly requests: readonly EnrichmentPreflightRequest[];
  readonly packs: readonly TransportPack[];
  readonly units: readonly OfficialApiSemanticWorkUnit[];
  readonly bounds: {
    readonly max_output_tokens: number;
    readonly dispatch_authorized: false;
    readonly lines: readonly EnrichmentNativeLineBound[];
    readonly unresolved_native_bound: boolean;
  };
  readonly semantic_fill: EnrichmentSemanticFillCapture;
  readonly annotation_interpolation: "absent";
  readonly attempted_fetches: number;
  readonly nonempty_request_count: number;
  readonly deterministic_empty_request_count: number;
  readonly cached_request_count: number;
}

export async function runCurrentEnrichmentPreflight(options: {
  readonly cacheRoot: string;
  readonly sourcePacking?: ExtractionSourcePacking;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly frozenRows?: readonly FrozenAssertion[];
  readonly turns?: readonly LongMemEvalExtractionTurn[];
  readonly datasetRevision?: string;
  readonly preparedFill?: PreparedExtractionFill;
}): Promise<EnrichmentPreflight> {
  const packing = options.sourcePacking ?? DEFAULT_EXTRACTION_SOURCE_PACKING;
  const previousFetch = globalThis.fetch;
  let attemptedFetches = 0;
  globalThis.fetch = async () => {
    attemptedFetches += 1;
    throw new Error("provider forbidden in enrichment preflight");
  };
  try {
    const loaded = options.turns === undefined
      ? await loadDatasetWindowWithIdentity("longmemeval_s", {
          ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
          ...(options.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: options.pinnedMetaRoot }),
          offset: 0,
          limit: 100
        })
      : null;
    const keySpace = options.turns === undefined
      ? inspectTurnContentKeySpace(loaded!.questions, packing)
      : null;
    const executionTurns = options.turns ?? keySpace!.distinctExtractionTurns;
    const occurrenceTurns = options.turns ?? keySpace!.occurrenceExtractionTurns;
    const datasetRevision = options.datasetRevision ?? loaded?.sha256;
    if (datasetRevision === undefined) {
      throw new TypeError("enrichment preflight requires a dataset revision");
    }
    const workset = prepareBatchExtractionWorkset({
      cacheRoot: options.cacheRoot,
      prepared: {
        config: {
          model: ENRICHMENT_PREFLIGHT_MODEL,
          modelFamily: ENRICHMENT_PREFLIGHT_MODEL,
          requestProfile: ENRICHMENT_PREFLIGHT_REQUEST_PROFILE,
          sourcePacking: packing,
          apiKey: null,
          providerUrl: ENRICHMENT_PREFLIGHT_PROVIDER_URL
        },
        datasetRevision,
        executionExtractionTurns: executionTurns,
        occurrenceExtractionTurns: occurrenceTurns
      }
    });
    assertNoAnnotationInterpolation(workset.requests.map((item) => item.line), options.frozenRows);
    const packs = planCurrentPacks(workset.units, packing);
    const bounds = sizeWorksetLines(workset.lines);
    const semanticFill = captureSemanticFill(options, executionTurns);
    const provenance = collectEnrichmentOccurrenceProvenance(occurrenceTurns ?? executionTurns, datasetRevision);
    if (attemptedFetches !== 0) {
      throw new Error(`enrichment preflight attempted ${attemptedFetches} provider fetches`);
    }
    return Object.freeze({
      identities: Object.freeze({
        capability: ENRICHMENT_PREFLIGHT_CAPABILITY,
        wire_contract: SOURCE_INTERPRETATION_CONTRACT,
        prompt_sha256: createHash("sha256").update(OFFICIAL_API_SYSTEM_PROMPT, "utf8").digest("hex"),
        parser: OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
        request_schema_version: OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
        source_locator_contract_version: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
        formation_audit: OFFICIAL_API_FORMATION_AUDIT_SEMANTICS_VERSION,
        model: ENRICHMENT_PREFLIGHT_MODEL,
        request_profile: ENRICHMENT_PREFLIGHT_REQUEST_PROFILE,
        max_output_tokens: ENRICHMENT_PREFLIGHT_MAX_OUTPUT_TOKENS,
        source_packing: packing,
        cache_key_algorithm: EXTRACTION_CACHE_KEY_ALGO,
        dataset_sha256: loaded?.sha256 ?? null
      }),
      requests: Object.freeze(workset.requests.map((item) => {
        return Object.freeze({
          key: item.line.key,
          source_corpus_identity: item.request.source_corpus_identity,
          assertion_ids: Object.freeze(item.request.source_assertions.map((row) => row.assertion_id)),
          assertion_texts: Object.freeze(item.request.source_assertions.map((row) => row.text)),
          occurrence_provenance: Object.freeze(item.units.map((unit) => {
            const evidence = provenance.get(unit.binding.occurrenceIdentity);
            if (evidence === undefined) throw new Error("native occurrence provenance missing");
            return evidence;
          })),
          user_prompt: item.line.userPrompt,
          unit_keys: item.line.unitKeys,
          message_ids: Object.freeze(item.sourceTurn.turnMessages.map((message) => message.message_id))
        });
      })),
      packs: packs.packs,
      units: workset.units,
      bounds: Object.freeze({
        max_output_tokens: ENRICHMENT_PREFLIGHT_MAX_OUTPUT_TOKENS,
        dispatch_authorized: false as const,
        lines: bounds,
        unresolved_native_bound: bounds.some((line) => line.status === "unresolved")
      }),
      semantic_fill: semanticFill,
      annotation_interpolation: "absent",
      attempted_fetches: attemptedFetches,
      nonempty_request_count: workset.lines.length,
      deterministic_empty_request_count: workset.deterministicEmptyRequests.length,
      cached_request_count: workset.cachedRequests.length
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function assertNoAnnotationInterpolation(
  lines: readonly { readonly systemPrompt: string; readonly userPrompt: string }[],
  frozenRows: readonly FrozenAssertion[] | undefined
): void {
  if (frozenRows === undefined) return;
  const annotations = frozenRows.flatMap((row) => [...row.obligations, ...row.forbidden]);
  for (const line of lines) {
    const payload = `${line.systemPrompt}\n${line.userPrompt}`;
    for (const annotation of annotations) {
      if (annotation.length > 0 && payload.includes(annotation)) {
        throw new Error("frozen annotation text entered a current request payload");
      }
    }
  }
}

function planCurrentPacks(
  units: readonly OfficialApiSemanticWorkUnit[],
  packing: ExtractionSourcePacking
): { readonly packs: readonly TransportPack[] } {
  const byCorpus = new Map<string, Map<string, OfficialApiSemanticWorkUnit>>();
  for (const unit of units) {
    if (unit.sourceCorpus === undefined || unit.semanticIdentity === undefined) continue;
    const group = byCorpus.get(unit.binding.sourceCorpusIdentity) ?? new Map();
    if (!group.has(unit.semanticKey)) group.set(unit.semanticKey, unit);
    byCorpus.set(unit.binding.sourceCorpusIdentity, group);
  }
  const packs: TransportPack[] = [];
  const size = extractionSourcePackingSize(packing);
  const policy = size === 1
    ? { kind: "reference_batch" as const, assertionsPerPack: 1 as const }
    : { kind: "reference_batch_8" as const };
  for (const group of byCorpus.values()) {
    const planned = planOfficialApiTransport(
      officialApiSemanticWorksetFromUnits([...group.values()]),
      policy
    );
    packs.push(...planned.packs);
  }
  return Object.freeze({ packs: Object.freeze(packs) });
}

function sizeWorksetLines(
  lines: readonly {
    readonly key: string;
    readonly unitKeys: readonly string[];
    readonly requestSha256: string;
    readonly systemPrompt: string;
    readonly userPrompt: string;
  }[]
): readonly EnrichmentNativeLineBound[] {
  return Object.freeze(lines.map((line) => {
    try {
      const plan = canonicalBatchPlan({
        identity: batchDigest(JSON.stringify({
          kind: "enrichment-acceptance-wire-sizing",
          model: ENRICHMENT_PREFLIGHT_MODEL,
          requestProfile: ENRICHMENT_PREFLIGHT_REQUEST_PROFILE,
          key: line.key
        })),
        model: ENRICHMENT_PREFLIGHT_MODEL,
        requestProfile: ENRICHMENT_PREFLIGHT_REQUEST_PROFILE,
        lines: [line],
        limits: SIZING_LIMITS
      });
      const job = prepareBatchJobs(plan)[0];
      if (job === undefined) {
        return Object.freeze({
          key: line.key,
          status: "unresolved" as const,
          reason: "native sizer produced no job"
        });
      }
      return Object.freeze({
        key: line.key,
        status: "sized" as const,
        input_bound: job.inputTokenBound,
        file_bytes: job.inputBytes,
        cost_bound_usd: job.costBoundUsd
      });
    } catch (cause) {
      return Object.freeze({
        key: line.key,
        status: "unresolved" as const,
        reason: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }));
}

function captureSemanticFill(
  options: {
    readonly cacheRoot: string;
    readonly sourcePacking?: ExtractionSourcePacking;
    readonly preparedFill?: PreparedExtractionFill;
  },
  turns: readonly LongMemEvalExtractionTurn[]
): EnrichmentSemanticFillCapture {
  if (options.preparedFill === undefined) {
    return Object.freeze({
      status: "not_run",
      reason: "missing F0-F2 substrate manifest",
      unresolved: null,
      uniqueUnits: null,
      occurrenceCount: null,
      bindingCount: null
    });
  }
  try {
    const tasks = collectSemanticFillTasks(turns, options.preparedFill);
    const attempts: SemanticFillAttempt[] = [];
    const packing = options.sourcePacking ?? DEFAULT_EXTRACTION_SOURCE_PACKING;
    const size = extractionSourcePackingSize(packing);
    const policy = size === 1
      ? { kind: "reference_batch" as const, assertionsPerPack: 1 as const }
      : { kind: "reference_batch_8" as const };
    const lease = acquireExtractionCacheWriteLease(options.cacheRoot);
    try {
      const prepared = prepareSemanticFill(options.cacheRoot, tasks, attempts, policy, lease);
      return Object.freeze({
        status: "prepared",
        reason: null,
        unresolved: prepared.unresolved,
        uniqueUnits: prepared.uniqueUnits,
        occurrenceCount: prepared.occurrenceCount,
        bindingCount: prepared.bindingCount
      });
    } finally {
      lease.release();
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/substrate manifest/u.test(message)) {
      return Object.freeze({
        status: "not_run",
        reason: message,
        unresolved: null,
        uniqueUnits: null,
        occurrenceCount: null,
        bindingCount: null
      });
    }
    throw cause;
  }
}
