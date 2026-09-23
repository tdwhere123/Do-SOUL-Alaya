import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { z } from "zod";
import { parseExtractionSampleKeys } from "../authority/sample-scope.js";
import { inspectExtractionFillPreparation } from "./fill-preparation.js";
import { prepareSourceRequestWorkset } from "./source-request-workset.js";
import { batchDigest, canonicalBatchPlan, prepareBatchJobs } from "./batch/plan.js";
import { isGeminiGenerateContentProfile } from "./batch/native-codec.js";
import { SourceRequestLineSchema } from "../request-artifact.js";
import type { GeminiBatchPlan } from "./batch/contract.js";
import { resolveExtractionTransportRoute } from "../transport-route.js";
import type { ExtractionFillOptions } from "../extraction-fill.js";

/** Read-only sizing never pins a manifest, grants authority, reserves, or creates HTTP transport. */
export async function preflightExtractionBatch(options: ExtractionFillOptions & { readonly cacheRoot: string; readonly preflightKeys?: unknown }) {
  if (options.batch?.operation !== "prepare" || options.authorityReceiptPath !== undefined ||
      options.batch.reconcile !== undefined || options.ingestionMode === "lazy_field" ||
      options.expansionCapability !== undefined || options.extractorFactory !== undefined) {
    throw new AlayaError("VALIDATION", "Batch dry preflight requires prepare settings without execution authority or alternate execution modes");
  }
  const inspected = await inspectExtractionFillPreparation(options, options.cacheRoot, undefined);
  const selectedKeys = options.preflightKeys === undefined ? undefined : parseExtractionSampleKeys(options.preflightKeys);
  if (selectedKeys !== undefined && options.batch.requestLimit !== undefined) {
    throw new AlayaError("VALIDATION", "explicit preflight keys cannot combine a request limit");
  }
  const workset = prepareSourceRequestWorkset({ prepared: inspected, cacheRoot: options.cacheRoot,
    ...(selectedKeys === undefined ? {} : { executionCacheKeys: new Set(selectedKeys) }) });
  if (workset.unsupportedSources.length !== inspected.unsupportedSourceOccurrences) {
    throw new AlayaError("CONFLICT", "Batch host preparation lost unsupported source occurrences");
  }
  const route = resolveExtractionTransportRoute(inspected.config);
  if (!isGeminiGenerateContentProfile(inspected.config.requestProfile)) {
    throw new AlayaError("VALIDATION", "unsupported Batch request profile");
  }
  const requestLimit = options.batch.requestLimit;
  if (requestLimit !== undefined && (!Number.isSafeInteger(requestLimit) || requestLimit <= 0)) {
    throw new AlayaError("VALIDATION", "invalid preflight request limit");
  }
  const lines = workset.lines.slice(0, requestLimit);
  const content = { model: route.model, requestProfile: inspected.config.requestProfile, lines, limits: options.batch.limits };
  const preview = canonicalBatchPlan({ ...content, identity: batchDigest(JSON.stringify(content)) });
  const jobs = prepareBatchJobs(preview);
  return parseRetainedBatchPreflight({ contract: "extraction-batch-preflight-v2" as const, execution_authorized: false as const,
    provider_calls: 0 as const, dataset_revision: inspected.datasetRevision,
    source_occurrences: inspected.sourceOccurrences,
    unsupported_source_occurrences: workset.unsupportedSources.length,
    unsupported_sources: workset.unsupportedSources.map((source) => ({
      message_ids: source.messageIds, dataset_revision: source.datasetRevision,
      ...source.disposition, provider_attempts: 0 as const
    })),
    total_requests: inspected.completion.expectedTurns, selected_requests: lines.length,
    selected_keys: selectedKeys ?? lines.map((line) => line.key),
    cached_requests: workset.cachedRequests.length, config: { ...inspected.config, apiKey: null },
    planned_requests: lines, native_jobs: jobs, limits: options.batch.limits,
    input_bytes: jobs.reduce((sum, job) => sum + job.inputBytes, 0),
    input_token_bound: jobs.reduce((sum, job) => sum + job.inputTokenBound, 0),
    cost_bound_usd: jobs.reduce((sum, job) => sum + job.costBoundUsd, 0) });
}

/** Re-admit retained Batch sizing through the same native plan and wire owner that produced it. */
export function parseRetainedBatchPreflight(value: unknown) {
  const report = z.object({
    contract: z.literal("extraction-batch-preflight-v2"), execution_authorized: z.literal(false),
    provider_calls: z.literal(0), dataset_revision: z.string(),
    source_occurrences: z.number().int().nonnegative(), unsupported_source_occurrences: z.number().int().nonnegative(),
    unsupported_sources: z.array(z.unknown()), total_requests: z.number().int().nonnegative(),
    selected_requests: z.number().int().nonnegative(), selected_keys: z.array(z.string()),
    cached_requests: z.number().int().nonnegative(),
    config: z.object({ providerUrl: z.string(), model: z.string(), requestProfile: z.string(),
      transportProviderUrl: z.string().optional(), transportModel: z.string().optional(),
      sourcePacking: z.unknown().optional(), openSemantics: z.unknown().optional(), apiKey: z.null() }).passthrough(),
    planned_requests: z.array(SourceRequestLineSchema), native_jobs: z.array(z.unknown()),
    limits: z.object({ maxJobs: z.number(), maxRequestsPerJob: z.number(), maxFileBytes: z.number(),
      maxInputTokensPerJob: z.number(), maxEnqueuedTokens: z.number(), maxOutputTokens: z.number(),
      maxUsd: z.number(), inputUsdPerMillion: z.number(), outputUsdPerMillion: z.number(),
      deadlineMs: z.number(), requestTimeoutMs: z.number(), maxPolls: z.number() }).strict(),
    input_bytes: z.number().int().nonnegative(), input_token_bound: z.number().int().nonnegative(),
    cost_bound_usd: z.number().nonnegative()
  }).passthrough().parse(value);
  if (!isGeminiGenerateContentProfile(report.config.requestProfile)) {
    throw new AlayaError("VALIDATION", "retained Batch preflight has an unsupported request profile");
  }
  const route = resolveExtractionTransportRoute(report.config);
  const content = { model: route.model, requestProfile: report.config.requestProfile,
    lines: report.planned_requests, limits: report.limits } satisfies Omit<GeminiBatchPlan, "identity">;
  const plan = canonicalBatchPlan({ ...content, identity: batchDigest(JSON.stringify(content)) });
  const jobs = prepareBatchJobs(plan);
  const keys = report.planned_requests.map(line => line.key);
  const selected = new Set(report.selected_keys);
  if (report.selected_requests !== report.planned_requests.length ||
      selected.size !== report.selected_keys.length || keys.some(key => !selected.has(key)) ||
      report.selected_requests + report.cached_requests > report.total_requests ||
      report.unsupported_source_occurrences !== report.unsupported_sources.length ||
      canonicalJson(report.native_jobs) !== canonicalJson(jobs) ||
      report.input_bytes !== jobs.reduce((sum, job) => sum + job.inputBytes, 0) ||
      report.input_token_bound !== jobs.reduce((sum, job) => sum + job.inputTokenBound, 0) ||
      report.cost_bound_usd !== jobs.reduce((sum, job) => sum + job.costBoundUsd, 0)) {
    throw new AlayaError("CONFLICT", "retained Batch preflight differs from its native plan or source inventory");
  }
  return report;
}
