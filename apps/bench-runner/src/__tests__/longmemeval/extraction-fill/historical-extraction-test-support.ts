/**
 * Authored historical-format extraction fixtures for reader/refusal tests.
 * These bytes are not genuine producer history and do not authorize replay.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isChatSemanticRequestProfile,
  SOURCE_SEMANTIC_CACHE_CONTRACT,
  SOURCE_SEMANTIC_PACKET_CONTRACT,
  type ExtractionSourcePacking,
  type SourceInterpretationProfile
} from "@do-soul/alaya-protocol";
import {
  inspectUnadmittedRawExtraction,
  writeCachedExtraction,
  type CachedExtractionEntry
} from "../../../runs/compile-seed/cache/cache-shard.js";
import { computeExtractionRawJsonSha256 } from "../../../runs/extraction/content-closure.js";
import {
  EXTRACTION_CACHE_MANIFEST_VERSION,
  readExtractionCacheManifest,
  writeExtractionCacheManifest,
  extractionAdmissionGenerationSha256
} from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";
import {
  EXTRACTION_OPEN_SEMANTICS_GENERATION,
  SOURCE_SEMANTIC_BATCH_PRODUCER_ID,
  type ExtractionOpenSemanticsGeneration,
  type SourceRequestLine
} from "../../../runs/extraction/request-artifact.js";
import {
  writeExtractionAuthorityReceipt,
  type ExtractionAuthorityReceipt
} from "../../../runs/extraction/authority/receipt.js";
import { receiptExtractionCacheIdentity } from "../../../runs/extraction/authority/receipt-cache-identity.js";
import {
  ledgerPath,
  openExtractionAttemptLedger
} from "../../../runs/extraction/authority/attempt-ledger.js";
import {
  persistAttemptLedgerRecord,
  readAttemptLedgerRecord
} from "../../../runs/extraction/authority/attempt-ledger/contract.js";
import { settledAttemptUsageDigest } from "../../../runs/extraction/authority/attempt-ledger/outcome.js";
import { isInteractiveSourceSampleReceipt } from "../../../runs/extraction/authority/sample-scope.js";
import type { ProviderHttpResponseEvidence } from "@do-soul/alaya-engine-gateway";
import {
  writeProviderRawAttempt
} from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { buildExtractionTransportProvenance } from "../../../runs/extraction/transport-route.js";
import { interactiveResponseMetadata } from "../../../runs/extraction/cache/source-interactive-binding.js";
import {
  interactiveSourceTransportBinding,
  type ExtractionRequestProfile
} from "../../../runs/extraction/request-profile.js";
import type { InteractiveSemanticProvenance } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { persistedResponseMetadata } from "../../../runs/compile-seed/cache/cached-response-metadata.js";
import { isGeminiGenerateContentProfile } from "../../../runs/extraction/fill/batch/native-codec.js";
import {
  batchDigest,
  canonicalBatchPlan,
  encodeGeminiBatchLines,
  prepareBatchJobs
} from "../../../runs/extraction/fill/batch/plan.js";
import { batchLineResult } from "../../../runs/extraction/fill/batch/line-result.js";
import { batchRemoteWitness } from "../../../runs/extraction/fill/batch/remote-operation.js";
import type {
  GeminiBatchLimits,
  GeminiBatchPlan
} from "../../../runs/extraction/fill/batch/contract.js";

export const AUTHORED_HISTORICAL_NOTE =
  "authored historical-format fixture; not genuine producer execution";

export function authoredSourceCorpusFromRequest(userPrompt: string, candidates: readonly string[]): string {
  const parsed = JSON.parse(userPrompt) as {
    source_digest?: string; source_catalog?: { source_digest?: string };
  };
  const digest = parsed.source_digest ?? parsed.source_catalog?.source_digest;
  if (typeof digest !== "string") throw new Error("authored request lacks source digest");
  const found = candidates.find(text => createHash("sha256").update(text).digest("hex") === digest);
  if (found === undefined) throw new Error("authored source corpus does not match request digest");
  return found;
}

export type AuthoredStepUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
};

const DEFAULT_STEP_USAGE: AuthoredStepUsage = {
  inputTokens: 11, outputTokens: 7, totalTokens: 18,
  cachedInputTokens: 3, reasoningOutputTokens: 4
};

export function authoredStepHttpWire(
  rawJson: string,
  usage: AuthoredStepUsage = DEFAULT_STEP_USAGE,
  finishReason = "stop",
  padding = ""
): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: rawJson }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens,
      ...(usage.cachedInputTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } }),
      ...(usage.reasoningOutputTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens } })
    }
  })}\n\ndata: [DONE]\n\n${padding}`;
}

export function authoredRetiredSourceSemanticRequest(sourceCorpus: string): unknown {
  return {
    interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
    schema_version: 1,
    source_digest: computeExtractionRawJsonSha256(sourceCorpus),
    source_request: {
      proposal_contract: "source-semantic-proposal-v7",
      original_source: sourceCorpus,
      source_assertions: [{ assertion_id: 1, text: sourceCorpus, source_role: "user" }]
    }
  };
}

export function openAuthoredHistoricalAttemptLedger(
  cacheRoot: string,
  receipt: ExtractionAuthorityReceipt
) {
  const logical = receipt.observation.extraction;
  return openExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: receipt.lineage_digest,
    cacheIdentity: receiptExtractionCacheIdentity(receipt),
    startingMissing: receipt.limits.starting_missing,
    maximumAttempts: receipt.limits.maximum_attempts,
    successfulShardCeiling: receipt.limits.successful_shard_ceiling,
    ...((isChatSemanticRequestProfile(logical.requestProfile) && logical.sourcePacking === "complete-source"
      || isInteractiveSourceSampleReceipt(receipt)) ? { maximumAttemptsPerKey: 1 } : {})
  });
}

function writeAuthoredHistoricalSourceManifest(input: {
  cacheRoot: string;
  receipt: ExtractionAuthorityReceipt;
  systemPrompt: string;
  sourcePacking?: ExtractionSourcePacking;
  generation?: ExtractionOpenSemanticsGeneration;
  sourceInterpretationProfile?: SourceInterpretationProfile;
}): void {
  const logical = input.receipt.observation.extraction;
  const dataset = input.receipt.observation.dataset;
  writeExtractionCacheTestManifest({
    cacheRoot: input.cacheRoot,
    model: logical.model,
    modelFamily: logical.modelFamily,
    systemPrompt: input.systemPrompt,
    requestProfile: logical.requestProfile,
    providerUrl: logical.providerUrl
  });
  const base = readExtractionCacheManifest(input.cacheRoot)!;
  writeExtractionCacheManifest(input.cacheRoot, {
    ...base,
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    model_family: logical.modelFamily,
    request_profile: logical.requestProfile,
    source_packing: input.sourcePacking ?? logical.sourcePacking ?? "complete-source",
    ...(input.generation === undefined ? {} : { source_semantic_generation: input.generation }),
    ...(input.sourceInterpretationProfile === undefined ? {} : {
      source_interpretation_profile: input.sourceInterpretationProfile
    }),
    dataset: dataset.variant.replace(/_/u, "-"),
    dataset_revision: dataset.revisionSha256,
    cache_key_algo: logical.cacheKeyAlgorithm,
    fill_status: "in_progress",
    window_offset: dataset.windowOffset,
    window_limit: dataset.windowLimit,
    expected_turns: input.receipt.observation.inventory.expectedTurns,
    requested_turns: input.receipt.observation.inventory.expectedTurns,
    cached_turns: 0,
    coverage: input.receipt.observation.inventory.expectedTurns === 0 ? 1 : 0,
    expected_key_set_sha256: dataset.expectedKeySetSha256
  });
}

function httpEvidence(wire: string, bodyComplete = true,
  contentType = "text/event-stream"): ProviderHttpResponseEvidence {
  const bytes = Buffer.from(wire, "utf8");
  return {
    contentType,
    bodyBase64: bytes.toString("base64"),
    bodyByteLength: bytes.length,
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
    bodyTruncated: false,
    bodyComplete
  };
}

function assertAuthoredShardCommitReady(
  cacheRoot: string, cacheKey: string, model: string, requestProfile: ExtractionRequestProfile
): void {
  const inspected = inspectUnadmittedRawExtraction(cacheRoot, cacheKey, model, requestProfile);
  if (inspected.status !== "hit" && inspected.status !== "pending") {
    throw new Error(`authored historical shard is not commit-ready: ${inspected.status} ${"reason" in inspected ? inspected.reason : ""}`);
  }
}

function storedUsage(usage: AuthoredStepUsage) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens: usage.reasoningOutputTokens })
  };
}

interface AuthoredHistoricalChatArtifact {
  cacheRoot: string;
  receipt: ExtractionAuthorityReceipt;
  line: SourceRequestLine;
  requestDigest: string;
  rawJson: string;
  httpWire: string;
  /** Null records unknown usage; omission uses the existing Step fixture defaults. */
  usage?: AuthoredStepUsage | null;
  finishReason?: string;
  bodyComplete?: boolean;
  commitSuccess?: boolean;
  invalidReportedUsage?: AuthoredStepUsage;
  generation?: ExtractionOpenSemanticsGeneration;
  sourceCorpus: string;
}

export async function writeAuthoredHistoricalChatArtifact(input: AuthoredHistoricalChatArtifact): Promise<void> {
  const { cacheRoot, receipt, line } = input;
  const logical = receipt.observation.extraction;
  const usage = input.usage === undefined ? DEFAULT_STEP_USAGE : input.usage;
  const binding = interactiveSourceTransportBinding(logical.requestProfile);
  if (binding.kind === "gemini_generate_content") throw new Error("expected an authored chat fixture");
  const finishReason = input.finishReason ?? "stop";
  const bodyComplete = input.bodyComplete ?? true;
  writeAuthoredHistoricalSourceManifest({
    cacheRoot, receipt, systemPrompt: line.systemPrompt,
    sourcePacking: logical.sourcePacking ?? "complete-source",
    generation: input.generation ?? EXTRACTION_OPEN_SEMANTICS_GENERATION
  });
  writeExtractionAuthorityReceipt(
    join(cacheRoot, `interactive-authority-${receipt.receipt_digest}.json`),
    receipt
  );
  const rawJsonSha256 = computeExtractionRawJsonSha256(input.rawJson);
  const ledger = openAuthoredHistoricalAttemptLedger(cacheRoot, receipt);
  const ordinal = ledger.reserveAttemptOrdinal(line.key);
  writeProviderRawAttempt({
    root: cacheRoot, cacheKey: line.key, attemptOrdinal: ordinal, kind: "source_semantic",
    model: logical.model, requestProfile: logical.requestProfile, requestDigest: input.requestDigest,
    decodedText: input.rawJson, finishReason,
    ...(usage === null ? {} : { usage: storedUsage(usage) }),
    httpResponse: httpEvidence(input.httpWire, bodyComplete,
      binding.kind === "intern_chat_completion" ? "application/json" : "text/event-stream"),
    ...(bodyComplete ? {} : { transportFailure: {
      kind: "aborted" as const, phase: "response_body" as const, httpStatus: null,
      fingerprint: "authored-incomplete-body", attempt: ordinal
    } }),
    authorityReceiptDigest: receipt.receipt_digest,
    authorityLineageDigest: receipt.lineage_digest,
    sourceRequestSha256: line.requestSha256
  });
  const provenance: InteractiveSemanticProvenance = {
    transport: binding.transport, finishReason, attemptOrdinal: ordinal, responseSha256: rawJsonSha256,
    ...(usage === null ? {} : {
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }
    })
  };
  if (input.commitSuccess !== false && input.invalidReportedUsage === undefined) {
    writeAuthoredHistoricalChatShard(input, provenance, binding.kind);
  }
  if (input.invalidReportedUsage !== undefined) {
    ledger.recordTransportOutcome(line.key, {
      retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 0, usageRequestCount: 0,
      terminalRetryClassification: "failure_non_retryable_response",
      transportFailures: [{ attempt: ordinal, kind: "response_schema_error", phase: "response_schema",
        httpStatus: 200, fingerprint: rawJsonSha256, usage: storedUsage(input.invalidReportedUsage) }],
      invalidReportedUsage: storedUsage(input.invalidReportedUsage)
    }, ordinal);
    ledger.abandonPendingShard(line.key, ordinal);
    return;
  }
  ledger.recordTransportOutcome(line.key, {
    retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1,
    transportFailures: [], usageRequestCount: usage === null ? 0 : 1,
    ...(usage === null ? {} : { usage: storedUsage(usage) })
  }, ordinal);
  if (input.commitSuccess === false) return;
  assertAuthoredShardCommitReady(cacheRoot, line.key, logical.model, logical.requestProfile);
  ledger.commitSuccessfulShard(line.key);
}

function writeAuthoredHistoricalChatShard(
  input: AuthoredHistoricalChatArtifact,
  provenance: InteractiveSemanticProvenance,
  kind: "step_chat_completion" | "intern_chat_completion"
): void {
  const { cacheRoot, receipt, line } = input;
  const logical = receipt.observation.extraction;
  const manifest = readExtractionCacheManifest(cacheRoot)!;
  writeCachedExtraction(cacheRoot, line.key, {
    model: logical.model, request_profile: logical.requestProfile, cache_key: line.key,
    raw_json: input.rawJson, extracted_at: "2026-08-15T09:29:28.024Z",
    transport_provenance: buildExtractionTransportProvenance(receipt.observation.transport!),
    response_metadata: interactiveResponseMetadata(provenance).response_metadata,
    admission_identity: {
      generation_sha256: extractionAdmissionGenerationSha256(manifest),
      request_key: line.key, raw_json_sha256: provenance.responseSha256
    },
    source_semantic: {
      contract: SOURCE_SEMANTIC_CACHE_CONTRACT,
      interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
      source_binding: "unbound", kind, completion: "interpreted", source_corpus: input.sourceCorpus,
      producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID,
      result: { line, rawJson: input.rawJson, provenance }
    }
  });
}

export async function writeAuthoredRetiredStepArtifact(input: {
  cacheRoot: string;
  receipt: ExtractionAuthorityReceipt;
  retainedKey: string;
  unitKeys: readonly string[];
  sourceCorpus: string;
  systemPrompt: string;
  rawJson: string;
  httpWire: string;
  usage?: AuthoredStepUsage;
}): Promise<{ key: string; line: SourceRequestLine }> {
  const { cacheRoot, receipt, sourceCorpus, systemPrompt, retainedKey } = input;
  const logical = receipt.observation.extraction;
  const transport = receipt.observation.transport!;
  const usage = input.usage ?? DEFAULT_STEP_USAGE;
  const userPrompt = JSON.stringify(authoredRetiredSourceSemanticRequest(sourceCorpus));
  const key = retainedKey;
  const requestSha256 = computeExtractionRawJsonSha256(userPrompt);
  const line: SourceRequestLine = { key, unitKeys: [...input.unitKeys], requestSha256, systemPrompt, userPrompt };
  const rawJsonSha256 = computeExtractionRawJsonSha256(input.rawJson);
  writeAuthoredHistoricalSourceManifest({
    cacheRoot, receipt, systemPrompt,
    sourcePacking: logical.sourcePacking ?? "complete-source",
    generation: EXTRACTION_OPEN_SEMANTICS_GENERATION
  });
  writeExtractionAuthorityReceipt(
    join(cacheRoot, `interactive-authority-${receipt.receipt_digest}.json`),
    receipt
  );
  writeProviderRawAttempt({
    root: cacheRoot, cacheKey: key, attemptOrdinal: 1, kind: "source_semantic",
    model: logical.model, requestProfile: logical.requestProfile, requestDigest: requestSha256,
    decodedText: input.rawJson, finishReason: "stop", usage: storedUsage(usage),
    httpResponse: httpEvidence(input.httpWire),
    authorityReceiptDigest: receipt.receipt_digest,
    authorityLineageDigest: receipt.lineage_digest,
    sourceRequestSha256: requestSha256
  });
  const provenance = {
    transport: "step-chat-completion" as const,
    finishReason: "stop",
    attemptOrdinal: 1,
    responseSha256: rawJsonSha256,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }
  };
  const manifest = readExtractionCacheManifest(cacheRoot)!;
  writeCachedExtraction(cacheRoot, key, {
    model: logical.model,
    request_profile: logical.requestProfile,
    cache_key: key,
    raw_json: input.rawJson,
    extracted_at: "2026-08-15T09:29:28.024Z",
    transport_provenance: buildExtractionTransportProvenance(transport),
    response_metadata: interactiveResponseMetadata(provenance).response_metadata,
    admission_identity: {
      generation_sha256: extractionAdmissionGenerationSha256(manifest),
      request_key: key,
      raw_json_sha256: rawJsonSha256
    },
    source_semantic: {
      contract: SOURCE_SEMANTIC_CACHE_CONTRACT,
      interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
      source_binding: "unbound",
      kind: "step_chat_completion",
      completion: "interpreted",
      source_corpus: sourceCorpus,
      producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID,
      result: { line, rawJson: input.rawJson, provenance }
    }
  });
  const ledger = openAuthoredHistoricalAttemptLedger(cacheRoot, receipt);
  const ordinal = ledger.reserveAttemptOrdinal(key);
  ledger.recordTransportOutcome(key, {
    retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1,
    transportFailures: [], usageRequestCount: 1, usage: storedUsage(usage)
  }, ordinal);
  const path = ledgerPath(cacheRoot, receipt.lineage_digest);
  const record = readAttemptLedgerRecord(path);
  persistAttemptLedgerRecord(path, {
    ...record,
    successful_shards: [{
      cacheKey: key,
      rawJsonSha256,
      successKind: "provider",
      transportProvenance: buildExtractionTransportProvenance(transport),
      attemptOrdinal: ordinal,
      authorityLineageDigest: receipt.lineage_digest,
      usageSha256: settledAttemptUsageDigest(storedUsage(usage))
    }],
    pending_keys: record.pending_keys.filter(pending => pending !== key)
  });
  return { key, line };
}

export function writeAuthoredHistoricalBatchArtifacts(input: {
  cacheRoot: string;
  receipt: ExtractionAuthorityReceipt;
  lines: GeminiBatchPlan["lines"];
  responses: ReadonlyMap<string, string>;
  limits: GeminiBatchLimits;
  mode: "open_semantics" | "source_packet" | "ordinary";
  sourcePacking?: ExtractionSourcePacking;
  sourceInterpretationProfile?: SourceInterpretationProfile;
  generation?: ExtractionOpenSemanticsGeneration;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  completion?: "interpreted" | "no_executable_proposition";
  sourceCorpusForLine: (line: GeminiBatchPlan["lines"][number]) => string;
  commitSuccess?: boolean;
}): GeminiBatchPlan {
  const { cacheRoot, receipt, lines, responses, limits, mode } = input;
  const logical = receipt.observation.extraction;
  const transport = receipt.observation.transport!;
  const usage = input.usage ?? { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
  const systemPrompt = lines[0]!.systemPrompt;
  writeAuthoredHistoricalSourceManifest({
    cacheRoot, receipt, systemPrompt,
    sourcePacking: input.sourcePacking ?? logical.sourcePacking ?? "reference-eight",
    generation: mode === "open_semantics" ? input.generation ?? EXTRACTION_OPEN_SEMANTICS_GENERATION : undefined,
    sourceInterpretationProfile: mode === "source_packet" ? input.sourceInterpretationProfile : undefined
  });
  if (!isGeminiGenerateContentProfile(logical.requestProfile)) {
    throw new Error(`invalid gemini batch request profile: ${logical.requestProfile}`);
  }
  const content = { model: logical.model, requestProfile: logical.requestProfile, lines, limits };
  const plan = canonicalBatchPlan({ ...content, identity: batchDigest(JSON.stringify(content)) });
  const prepared = prepareBatchJobs(plan)[0]!;
  const inputWire = encodeGeminiBatchLines(plan.lines, plan);
  const attemptOrdinals = Object.fromEntries(plan.lines.map((line, index) => [line.key, index + 1]));
  const outputEntries = plan.lines.map(line => ({
    key: line.key,
    response: {
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: responses.get(line.key) ?? "{}" }] } }],
      usageMetadata: {
        promptTokenCount: usage.inputTokens,
        candidatesTokenCount: usage.outputTokens,
        totalTokenCount: usage.totalTokens
      }
    }
  }));
  const outputRaw = `${outputEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
  const job = {
    ...prepared,
    status: "succeeded" as const,
    inputFile: "files/input",
    remoteJob: "batches/job",
    outputFile: "files/output",
    submittedAt: 1,
    polls: 1,
    attemptOrdinals,
    usageUnknown: false,
    usage,
    outcomes: Object.fromEntries(plan.lines.map(line => [line.key, { status: "admitted" as const }])),
    rawOutputSha256: batchDigest(outputRaw)
  };
  const created = { name: "batches/job", metadata: {
    displayName: job.displayName, model: `models/${plan.model}`,
    inputConfig: { fileName: job.inputFile }
  } };
  const polled = { name: "batches/job", done: true, metadata: {
    displayName: job.displayName, model: `models/${plan.model}`,
    state: "BATCH_STATE_SUCCEEDED",
    inputConfig: { fileName: job.inputFile },
    output: { responsesFile: "files/output" }
  } };
  writeFileSync(join(cacheRoot, `batch-plan-${plan.identity}.json`), JSON.stringify(plan));
  writeFileSync(join(cacheRoot, "gemini-batch-plan.json"), JSON.stringify(plan, null, 2));
  writeFileSync(join(cacheRoot, `batch-input-${job.id}.jsonl`), inputWire);
  writeFileSync(join(cacheRoot, `batch-output-${job.id}.jsonl`), outputRaw);
  writeFileSync(join(cacheRoot, `batch-download-${job.id}.json`), JSON.stringify({
    binding: {
      jobId: job.id, remoteJob: job.remoteJob, inputFile: job.inputFile,
      inputSha256: job.inputSha256, outputFile: job.outputFile
    },
    rawSha256: job.rawOutputSha256
  }));
  writeFileSync(join(cacheRoot, `batch-attempts-${job.id}.json`), JSON.stringify({
    jobId: job.id, planIdentity: plan.identity, inputSha256: job.inputSha256, attemptOrdinals
  }));
  writeFileSync(join(cacheRoot, `batch-created-${job.id}.json`), JSON.stringify(batchRemoteWitness(job, plan, created)));
  writeFileSync(join(cacheRoot, `batch-poll-${batchDigest(`${job.id}:1`)}.json`),
    JSON.stringify(batchRemoteWitness(job, plan, polled)));
  writeFileSync(join(cacheRoot, `batch-state-${plan.identity}.json`), JSON.stringify({
    version: 1, transport: "gemini-batch", planDigest: batchDigest(JSON.stringify(plan)),
    endpoint: new URL(transport.providerUrl).origin, jobs: [job]
  }));
  writeExtractionAuthorityReceipt(join(cacheRoot, `batch-authority-${plan.identity}.json`), receipt);
  const manifest = readExtractionCacheManifest(cacheRoot)!;
  const generationSha256 = extractionAdmissionGenerationSha256(manifest);
  const provenanceTransport = buildExtractionTransportProvenance({
    model: plan.model, providerUrl: transport.providerUrl
  });
  const ledger = openAuthoredHistoricalAttemptLedger(cacheRoot, receipt);
  for (const line of plan.lines) {
    const rawJson = responses.get(line.key) ?? "{}";
    const result = batchLineResult(plan, job, line.key,
      outputEntries.find(entry => entry.key === line.key)!.response);
    const sourceCorpus = input.sourceCorpusForLine(line);
    const rawJsonSha256 = computeExtractionRawJsonSha256(rawJson);
    const metadata = persistedResponseMetadata({
      finishReason: "STOP", completionContractVersion: 1, completionWitness: "finish_reason"
    }, result.provenance.usage, true);
    const entry: CachedExtractionEntry = {
      model: logical.model,
      request_profile: logical.requestProfile,
      cache_key: line.key,
      raw_json: rawJson,
      extracted_at: "2026-08-15T09:29:28.024Z",
      transport_provenance: provenanceTransport,
      response_metadata: metadata.response_metadata,
      admission_identity: {
        generation_sha256: generationSha256, request_key: line.key, raw_json_sha256: rawJsonSha256
      },
      ...(mode === "ordinary" ? {
        provider_attempt: {
          kind: "gemini_batch" as const,
          attempt_ordinal: result.provenance.attemptOrdinal!,
          authority_lineage_digest: receipt.lineage_digest
        },
        provider_batch: {
          plan_identity: plan.identity,
          authority_receipt_digest: receipt.receipt_digest,
          result
        }
      } : {}),
      ...(mode === "open_semantics" ? {
        source_semantic: {
          contract: SOURCE_SEMANTIC_CACHE_CONTRACT,
          interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
          source_binding: "unbound" as const,
          kind: "gemini_batch" as const,
          completion: input.completion ?? "interpreted",
          source_corpus: sourceCorpus,
          producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID,
          plan_identity: plan.identity,
          authority_receipt_digest: receipt.receipt_digest,
          result
        }
      } : {}),
      ...(mode === "source_packet" ? {
        source_packet: {
          contract: "source-interpretation-cache-v1" as const,
          source_binding: "unbound" as const,
          kind: "gemini_batch" as const,
          completion: "received" as const,
          source_corpus: sourceCorpus,
          producer_id: "recorded-history",
          plan_identity: plan.identity,
          authority_receipt_digest: receipt.receipt_digest,
          result
        }
      } : {})
    };
    writeCachedExtraction(cacheRoot, line.key, entry);
    const ordinal = ledger.reserveAttemptOrdinal(line.key);
    ledger.recordTransportOutcome(line.key, {
      retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1,
      transportFailures: [], usageRequestCount: 1, usage
    }, ordinal);
    if (input.commitSuccess === false) continue;
    assertAuthoredShardCommitReady(cacheRoot, line.key, logical.model, logical.requestProfile);
    ledger.commitSuccessfulShard(line.key);
  }
  return plan;
}
