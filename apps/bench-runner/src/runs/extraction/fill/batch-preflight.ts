import { AlayaError } from "@do-soul/alaya-protocol";
import { parseExtractionSampleKeys } from "../authority/sample-scope.js";
import { inspectExtractionFillPreparation } from "./fill-preparation.js";
import { prepareBatchExtractionWorkset } from "./batch-workset.js";
import { batchDigest, canonicalBatchPlan, prepareBatchJobs } from "./batch/plan.js";
import { isGeminiGenerateContentProfile } from "./batch/native-codec.js";
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
  const workset = prepareBatchExtractionWorkset({ prepared: inspected, cacheRoot: options.cacheRoot,
    ...(selectedKeys === undefined ? {} : { executionCacheKeys: new Set(selectedKeys) }) });
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
  return { contract: "extraction-batch-preflight-v1" as const, execution_authorized: false as const,
    provider_calls: 0 as const, dataset_revision: inspected.datasetRevision,
    total_requests: inspected.completion.expectedTurns, selected_requests: lines.length,
    selected_keys: selectedKeys ?? lines.map((line) => line.key),
    cached_requests: workset.cachedRequests.length, config: { ...inspected.config, apiKey: null },
    planned_requests: lines, native_jobs: jobs, limits: options.batch.limits,
    input_bytes: jobs.reduce((sum, job) => sum + job.inputBytes, 0),
    input_token_bound: jobs.reduce((sum, job) => sum + job.inputTokenBound, 0),
    cost_bound_usd: jobs.reduce((sum, job) => sum + job.costBoundUsd, 0) };
}
