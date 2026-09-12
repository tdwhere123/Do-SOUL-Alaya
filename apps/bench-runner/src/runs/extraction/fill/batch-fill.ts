import { join } from "node:path";
import { existsSync } from "node:fs";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import { createCachingSignalExtractor, importExtractionResponse, ExtractionResponseAdmissionError } from "../../compile-seed/compile-seed-cache.js";
import type { ExtractionFillOptions, ExtractionFillResult } from "../extraction-fill.js";
import { readBoundedCanonicalUtf8Artifact } from "../cache-audit/bounded-artifact-reader.js";
import { readExtractionCacheManifestIdentity, writeExtractionCacheManifest } from "../cache/extraction-cache-manifest.js";
import { resolveExtractionTransportRoute } from "../transport-route.js";
import type { ExecutionExtractionAuthority } from "./fill-execution.js";
import { inspectFillWindow, type PreparedExtractionFill } from "./fill-preparation.js";
import { newFillStats, readFillRetryTelemetry } from "./fill-stats.js";
import { buildFillManifest } from "./manifest/fill-manifest.js";
import { replaceBytesDurable } from "./manifest/durable-exclusive-publication.js";
import type { ExtractionCacheWriteLease } from "./manifest/fill-root-guard.js";
import { prepareBatchExtractionWorkset, type BatchExtractionWorkset } from "./batch-workset.js";
import type { GeminiBatchInvocation, GeminiBatchPlan } from "./batch/contract.js";
import { batchDigest, canonicalBatchPlan, MAX_BATCH_ARTIFACT_BYTES } from "./batch/plan.js";
import { createGeminiBatchHttp } from "./batch/http.js";
import { encodeGeminiGenerateContent, isGeminiGenerateContentProfile } from "./batch/native-codec.js";
import { executeGeminiBatchOperation } from "./batch/executor.js";
import { isBatchPlanAdmitted } from "./batch/store.js";

interface BatchFillInput {
  readonly options: ExtractionFillOptions;
  readonly prepared: PreparedExtractionFill;
  readonly cacheRoot: string;
  readonly writeLease: ExtractionCacheWriteLease;
  readonly authority: ExecutionExtractionAuthority | undefined;
}

export async function executeExtractionBatchFill(input: BatchFillInput): Promise<ExtractionFillResult> {
  refuseRecallCampaignLiveExtraction("extraction_write");
  const batch = input.options.batch!;
  if (input.options.ingestionMode === "lazy_field" || input.prepared.expansion !== undefined ||
      input.options.extractorFactory !== undefined || input.options.questionBatchLimit !== undefined) {
    throw new Error("Batch requires a full, isolated precomputed extraction window");
  }
  const authority = input.authority;
  if (authority === undefined) throw new Error("Batch requires an extraction authority receipt");
  const route = resolveExtractionTransportRoute(input.prepared.config);
  const profile = input.prepared.config.requestProfile;
  if (!isGeminiGenerateContentProfile(profile)) {
    throw new Error("Batch request profile is unsupported");
  }
  assertBatchExpenseScope(batch.limits, authority);
  const selected = authority.receipt.action === "probe" ? new Set([authority.receipt.probe_key!])
    : authority.receipt.catalog_refill === undefined ? undefined
      : new Set(authority.receipt.catalog_refill.keys);
  if (authority.receipt.repair_scope !== undefined) throw new Error("Batch repair needs a fresh missing-unit authority");
  const workset = prepareBatchExtractionWorkset({ prepared: input.prepared, cacheRoot: input.cacheRoot,
    ...(selected === undefined ? {} : { executionCacheKeys: selected }) });
  const plan = bindBatchPlan(input, workset, route.model, profile);
  for (const line of plan.lines) {
    const upper = Buffer.byteLength(JSON.stringify(encodeGeminiGenerateContent(line, {
      model: plan.model, requestProfile: plan.requestProfile, maxOutputTokens: plan.limits.maxOutputTokens
    })), "utf8") + 256;
    if (upper > authority.receipt.price.maximum_input_tokens_per_attempt) {
      throw new Error("Batch request exceeds the authority input-token bound");
    }
  }
  const http = input.options.batchHttp ?? createGeminiBatchHttp({
    apiKey: input.prepared.config.apiKey ?? "", endpoint: route.providerUrl,
    timeoutMs: batch.limits.requestTimeoutMs
  });
  if (!["prepare", "import"].includes(batch.operation) && input.options.batchHttp === undefined &&
      input.prepared.config.apiKey === null) throw new Error("Batch provider credential is unavailable");
  const state = await executeGeminiBatchOperation({
    operation: batch.operation, root: input.cacheRoot, lease: input.writeLease, plan, http,
    ...(input.options.signal === undefined ? {} : { signal: input.options.signal }),
    ...(batch.reconcile === undefined ? {} : { reconcile: batch.reconcile }),
    reserveSubmission: async (lines) => {
      if (authority.reserveAttemptOrdinal === undefined) throw new Error("Batch requires bound attempt authority");
      const ordinals: Record<string, number> = {};
      for (const line of lines) ordinals[line.key] = await authority.reserveAttemptOrdinal(line.key, input.options.signal);
      return ordinals;
    },
    recordLineOutcome: (key, outcome, usage, binding) => {
      authority.recordTransportOutcome(key, { retryCount: 0, rateLimitRetries: 0,
        successfulRequestCount: outcome === "success" ? 1 : 0,
        usageRequestCount: usage === undefined ? 0 : 1,
        ...(outcome === "success" ? {} : { terminalRetryClassification: "failure_non_retryable_response" }),
        transportFailures: outcome === "success" ? [] : [{
          attempt: 1, kind: outcome === "missing" ? "empty_response" : "response_schema_error",
          phase: outcome === "missing" ? "response_body" : "response_schema", httpStatus: null,
          fingerprint: batchDigest(JSON.stringify({ job: binding.jobId, key, outcome }))
        }], ...(usage === undefined ? {} : { usage }) }, binding.attemptOrdinal);
    },
    importLine: (result) => importBatchLine(input, workset, result)
  });
  if (batch.operation === "import" || batch.operation === "resume") await importEmptyRequests(input, workset);
  input.writeLease.assertOwned();
  const completion = inspectFillWindow(input.cacheRoot, input.prepared.config, input.prepared.distinctExtractionTurns);
  const unresolved = state.jobs.some((job) => job.lineKeys.some((key) => job.outcomes[key]?.status !== "admitted"));
  const manifest = buildFillManifest({ config: input.prepared.config, variant: input.prepared.variant,
    existingManifest: readExtractionCacheManifestIdentity(input.cacheRoot)?.manifest,
    datasetRevision: input.prepared.datasetRevision, windowOffset: input.prepared.windowOffset,
    windowLimit: input.prepared.windowLimit, completion,
    status: !unresolved && completion.missingTurns === 0 && completion.invalidTurns === 0 ? "complete" : "in_progress" });
  writeExtractionCacheManifest(input.cacheRoot, manifest);
  return { requestedTurns: input.prepared.requestedTurns, cacheHits: workset.cachedRequests.length,
    newlyExtracted: 0, coverage: completion.coverage, manifest, batchState: state,
    ...readFillRetryTelemetry(newFillStats()), authorityTelemetry: authority.snapshot() };
}

function assertBatchExpenseScope(limits: NonNullable<ExtractionFillOptions["batch"]>["limits"],
  authority: ExecutionExtractionAuthority): void {
  const receipt = authority.receipt;
  if (receipt.limits.output_token_field !== "maxOutputTokens" ||
      limits.inputUsdPerMillion !== receipt.price.input_usd_per_million ||
      limits.outputUsdPerMillion !== receipt.price.output_usd_per_million ||
      limits.maxUsd > receipt.price.estimated_upper_usd ||
      limits.maxOutputTokens !== receipt.limits.max_output_tokens) {
    throw new Error("Batch prices/output/spend must remain within the extraction authority");
  }
}

function bindBatchPlan(input: BatchFillInput, workset: BatchExtractionWorkset,
  model: string, requestProfile: GeminiBatchPlan["requestProfile"]): GeminiBatchPlan {
  const window = input.options.batch!.window ?? "initial";
  const requestLimit = input.options.batch!.requestLimit;
  if (requestLimit !== undefined && (!Number.isSafeInteger(requestLimit) || requestLimit <= 0)) {
    throw new Error("Batch request limit must be a positive safe integer");
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(window)) throw new Error("invalid Batch window name");
  const identity = batchDigest(JSON.stringify({
    window,
    ...(requestLimit === undefined ? {} : { requestLimit }),
    authority: input.authority!.receipt.receipt_digest,
    dataset: input.prepared.datasetRevision,
    requests: workset.requests.map(({ line }) => line), model, requestProfile,
    limits: input.options.batch!.limits
  }));
  const path = join(input.writeLease.stableRootPath,
    window === "initial" ? "gemini-batch-plan.json" : `gemini-batch-plan-${window}.json`);
  if (existsSync(path)) {
    const saved = canonicalBatchPlan(JSON.parse(readBoundedCanonicalUtf8Artifact({ path,
      maxBytes: MAX_BATCH_ARTIFACT_BYTES, label: "Batch plan" })) as GeminiBatchPlan);
    if (saved.identity !== identity || saved.model !== model || saved.requestProfile !== requestProfile ||
        JSON.stringify(saved.limits) !== JSON.stringify(input.options.batch!.limits)) {
      throw new Error("Batch source/authority/settings changed since preparation");
    }
    if (isBatchPlanAdmitted(input.writeLease, saved)) {
      const requests = new Map(workset.requests.map(({ line }) => [line.key, JSON.stringify(line)]));
      for (const line of saved.lines) {
        if (requests.get(line.key) !== JSON.stringify(line)) throw new Error("Batch persisted request binding changed");
      }
      return saved;
    }
  }
  if (input.options.batch!.operation !== "prepare") throw new Error("Batch must be prepared before operation");
  const lines = [...workset.lines].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    .slice(0, requestLimit);
  let plan: GeminiBatchPlan;
  try {
    plan = canonicalBatchPlan({ identity, model, requestProfile, lines, limits: input.options.batch!.limits });
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Batch plan exceeds bounded artifact limit") {
      throw new Error(`${cause.message}; prepare bounded windows with --batch-request-limit`, { cause });
    }
    throw cause;
  }
  input.writeLease.assertOwned();
  replaceBytesDurable({ destination: path, bytes: Buffer.from(JSON.stringify(plan)),
    ownerIdentity: identity, temporaryDirectory: input.writeLease.stableRootPath });
  return plan;
}

async function importBatchLine(input: BatchFillInput, workset: BatchExtractionWorkset,
  result: Parameters<GeminiBatchInvocation["importLine"]>[0]): ReturnType<GeminiBatchInvocation["importLine"]> {
  const authority = input.authority!;
  const sourceCorpus = workset.requests.find((request) => request.line.key === result.line.key)?.units[0]?.sourceCorpus;
  if (sourceCorpus === undefined) throw new Error("Batch import lost its bound source corpus");
  try {
    importExtractionResponse({ config: input.prepared.config, cacheRoot: input.cacheRoot,
    writeLease: input.writeLease, systemPrompt: result.line.systemPrompt,
    userPrompt: result.line.userPrompt, expectedCacheKey: result.line.key, sourceCorpus,
    result: { rawJson: result.rawJson,
      ...(result.provenance.usage === undefined ? {} : { usage: result.provenance.usage }),
      responseMetadata: { finishReason: "STOP", completionContractVersion: 1, completionWitness: "finish_reason" } } });
  } catch (cause) {
    if (cause instanceof ExtractionResponseAdmissionError) {
      authority.abandonPendingShard(result.line.key, result.provenance.attemptOrdinal);
      return { status: "quarantined", reason: cause.message };
    }
    throw cause;
  }
  authority.commitSuccessfulShard(result.line.key);
}

async function importEmptyRequests(input: BatchFillInput, workset: BatchExtractionWorkset): Promise<void> {
  const extractor = createCachingSignalExtractor({ config: input.prepared.config,
    cacheRoot: input.cacheRoot, writeLease: input.writeLease,
    onDeterministicExtractionSucceeded: input.authority!.commitDeterministicShard,
    delegate: { extract: async () => { throw new Error("deterministic empty work cannot dispatch"); } } });
  for (const { line } of workset.deterministicEmptyRequests) {
    await extractor.extract({ systemPrompt: line.systemPrompt, userPrompt: line.userPrompt });
  }
}
