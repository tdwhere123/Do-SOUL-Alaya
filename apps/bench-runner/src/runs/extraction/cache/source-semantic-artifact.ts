import { interactiveSourceTransportBinding } from "../request-profile.js";
import {
  parseSourceSemanticRequest, completeEmptySourceSemantics, MAX_SOURCE_SEMANTIC_RESPONSE_BYTES,
  type SourceSemanticProposalResult
} from "@do-soul/alaya-soul";
import {
  AlayaError, canonicalJson, SOURCE_SEMANTIC_CACHE_CONTRACT,
  SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION, SOURCE_SEMANTIC_PACKET_CONTRACT, type UtteranceAttribution
} from "@do-soul/alaya-protocol";
import { readCachedEntry, writeCachedExtraction, MAX_EXTRACTION_CACHE_SHARD_BYTES, type CachedExtractionEntry } from "../../compile-seed/cache/cache-shard.js";
import { computeCacheKey } from "../../compile-seed/cache/cache-key.js";
import { inspectCachedResponseMetadata, persistedResponseMetadata } from "../../compile-seed/cache/cached-response-metadata.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import { computeExtractionRawJsonSha256 } from "../content-closure.js";
import { receiveSourceSemanticBatchLine } from "../fill/batch/source-semantic-interpretation.js";
import type { GeminiBatchInvocation, GeminiBatchPlan } from "../fill/batch/contract.js";
import type { ExtractionCacheWriteLease } from "../fill/manifest/fill-root-guard.js";
import { buildExtractionTransportProvenance } from "../transport-route.js";
import { assertExtractionCacheIdentity } from "./cache-identity.js";
import { extractionAdmissionGenerationSha256, readExtractionCacheManifestIdentity,
  readRetainedSourceSemanticManifestIdentity, computeSystemPromptSha256 } from "./extraction-cache-manifest.js";
import { normalizeGeminiEndpoint } from "../../provider/gemini-endpoint.js";
import { assertInteractiveProvenance, inspectInteractiveTransportEvidence, interactiveResponseMetadata } from "./source-interactive-binding.js";
import { isCompleteSemanticFinish } from "../../compile-seed/http/semantic-provider-http.js";
import type { ExtractionAuthorityReceipt } from "../authority/receipt.js";
import { readRetainedBatchAuthority } from "../fill/batch/retained-authority.js";
import { readRetainedBatchLine } from "../fill/batch/retained-line.js";
import { inspectSettledProviderAttempt } from "../authority/attempt-ledger/admission.js";
import {
  SOURCE_SEMANTIC_BATCH_PRODUCER_ID, SOURCE_SEMANTIC_BATCH_PRODUCER_VERSION
} from "../request-artifact.js";
import { SourceRequestLineSchema, type SourceRequestLine } from "../request-artifact.js";

export class SourceSemanticAdmissionError extends Error {}

export type InteractiveSemanticProvenance = Readonly<{
  readonly transport: "gemini-generate-content" | "step-chat-completion" | "intern-chat-completion";
  readonly finishReason: string | null;
  readonly attemptOrdinal: number;
  readonly responseSha256: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}>;

export type InteractiveSemanticLineResult = Readonly<{
  readonly line: SourceRequestLine;
  readonly rawJson: string;
  readonly provenance: InteractiveSemanticProvenance;
}>;

export type CachedSourceSemantic = Readonly<{
  contract: typeof SOURCE_SEMANTIC_CACHE_CONTRACT;
  source_binding: "unbound";
  interpretation_contract: typeof SOURCE_SEMANTIC_PACKET_CONTRACT;
  completion: "interpreted" | "abstained" | "no_executable_proposition" | "no_eligible_source";
  source_corpus: string;
  producer_id: string;
}> & (
  | Readonly<{ kind: "gemini_batch"; plan_identity: string; authority_receipt_digest: string; result: Parameters<GeminiBatchInvocation["importLine"]>[0] }>
  | Readonly<{ kind: "gemini_generate_content"; result: InteractiveSemanticLineResult }>
  | Readonly<{ kind: "step_chat_completion"; result: InteractiveSemanticLineResult }>
  | Readonly<{ kind: "intern_chat_completion"; result: InteractiveSemanticLineResult }>
  | Readonly<{ kind: "deterministic_empty"; line: SourceRequestLine }>
);

function artifactLine(typed: CachedSourceSemantic): SourceRequestLine {
  return typed.kind === "deterministic_empty" ? typed.line : typed.result.line;
}

function unboundProposal(sourceCorpus: string): {
  sourceCorpus: string; assertionIds: readonly number[]; source_id: "unbound"; source_version: "unbound";
  producer_id: typeof SOURCE_SEMANTIC_BATCH_PRODUCER_ID; producer_version: typeof SOURCE_SEMANTIC_BATCH_PRODUCER_VERSION;
} {
  return {
    sourceCorpus, assertionIds: [], source_id: "unbound", source_version: "unbound",
    producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID, producer_version: SOURCE_SEMANTIC_BATCH_PRODUCER_VERSION
  };
}

function proposalForRequest(sourceCorpus: string, assertionIds: readonly number[], attribution?: UtteranceAttribution) {
  return { ...unboundProposal(sourceCorpus), assertionIds,
    ...(attribution === undefined ? {} : { attribution_context: attribution }) };
}

/** Two retained copies of raw JSON may each expand sixfold; host IR/refs add another escaped copy. */
export function assertSourceSemanticShardCapacity(sourceCorpus: string, line: SourceRequestLine): void {
  const retainedInputBytes = Buffer.byteLength(JSON.stringify({ source_semantic: {
    source_corpus: sourceCorpus, result: { line }
  } }, null, 2), "utf8");
  const receiptAndEnvelopeAllowance = 1024 * 1024;
  const escapedRaw = 12 * MAX_SOURCE_SEMANTIC_RESPONSE_BYTES;
  const expandedIr = 6 * MAX_SOURCE_SEMANTIC_RESPONSE_BYTES;
  if (retainedInputBytes + escapedRaw + expandedIr + receiptAndEnvelopeAllowance >
      MAX_EXTRACTION_CACHE_SHARD_BYTES) {
    throw new AlayaError("CONFLICT", "typed open-semantics source/request exceeds durable shard byte capacity before reservation");
  }
}

function retainableOutcome(result: SourceSemanticProposalResult): "interpreted" | "abstained" | "no_executable_proposition" | undefined {
  if (result.outcome.status === "interpreted" || result.outcome.status === "abstained" || result.outcome.status === "no_executable_proposition") return result.outcome.status;
  return undefined;
}

function assertCompleteProviderFinish(finishReason: string | null, requestProfile: string): void {
  if (!isCompleteSemanticFinish(requestProfile, finishReason)) {
    throw new SourceSemanticAdmissionError("source semantics completion is not a complete provider finish");
  }
}

function inspectInteractiveGenerateContent(
  typed: Extract<CachedSourceSemantic, { kind: "gemini_generate_content" | "step_chat_completion" | "intern_chat_completion" }>,
  entry: CachedExtractionEntry,
  cacheRoot: string,
  request: ReturnType<typeof parseSourceSemanticRequest>
): { admitted: SourceSemanticProposalResult; binding: ReturnType<typeof inspectInteractiveTransportEvidence> } {
  const binding = inspectInteractiveTransportEvidence(typed, entry, cacheRoot);
  const input = {
    config: { model: entry.model, requestProfile: entry.request_profile },
    line: typed.result.line, rawJson: entry.raw_json, sourceCorpus: typed.source_corpus,
    proposal: proposalForRequest(typed.source_corpus, request.source_request.source_assertions.map((row) => row.assertion_id),
      request.source_request.attribution_context)
  };
  const admitted = receiveSourceSemanticBatchLine(input);
  const completion = retainableOutcome(admitted);
  if (completion === undefined || completion !== typed.completion) {
    throw new AlayaError("CONFLICT", "typed open-semantics completion mismatch");
  }
  return { admitted, binding };
}

function inspectSourceSemanticEntry(entry: CachedExtractionEntry, cacheRoot: string) {
  const typed = entry.source_semantic;
  if (typed?.contract !== SOURCE_SEMANTIC_CACHE_CONTRACT || typed.source_binding !== "unbound" ||
      typed.interpretation_contract !== SOURCE_SEMANTIC_PACKET_CONTRACT ||
      typeof typed.source_corpus !== "string" || typeof typed.producer_id !== "string" ||
      (typed.kind !== "gemini_batch" && typed.kind !== "gemini_generate_content" &&
       typed.kind !== "step_chat_completion" && typed.kind !== "intern_chat_completion" &&
       typed.kind !== "deterministic_empty")) {
    throw new AlayaError("CONFLICT", "invalid typed source semantic cache artifact");
  }
  const line = artifactLine(typed);
  const expectedKey = computeCacheKey(entry.model, entry.request_profile, line.systemPrompt, line.userPrompt);
  if (line.key !== entry.cache_key || expectedKey !== line.key) {
    throw new AlayaError("CONFLICT", "typed open-semantics request key mismatch");
  }
  const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
  let admitted: SourceSemanticProposalResult;
  let interactiveBinding: ReturnType<typeof inspectInteractiveTransportEvidence> | undefined;
  let batchBinding: { attemptOrdinal: number; authorityLineageDigest: string } | undefined;
  if (typed.kind === "deterministic_empty") {
    if (entry.transport_provenance !== undefined || entry.response_metadata !== undefined) {
      throw new AlayaError("CONFLICT", "deterministic open semantics cannot carry a provider receipt");
    }
    if (entry.raw_json !== "") throw new AlayaError("CONFLICT", "deterministic open semantics has nonempty output");
    const proposal = proposalForRequest(typed.source_corpus, request.source_request.source_assertions.map((row) => row.assertion_id),
      request.source_request.attribution_context);
    admitted = completeEmptySourceSemantics(request, proposal);
    if (admitted.outcome.status !== "no_eligible_source" || typed.completion !== "no_eligible_source") {
      throw new AlayaError("CONFLICT", "deterministic open semantics is not a zero-attempt empty catalog");
    }
  } else if (typed.kind === "gemini_generate_content" || typed.kind === "step_chat_completion" || typed.kind === "intern_chat_completion") {
    const inspected = inspectInteractiveGenerateContent(typed, entry, cacheRoot, request);
    admitted = inspected.admitted;
    interactiveBinding = inspected.binding;
  } else {
    const retained = readRetainedBatchLine(cacheRoot, typed.plan_identity, entry.cache_key);
    const authority = readRetainedBatchAuthority(cacheRoot, typed.plan_identity, typed.authority_receipt_digest);
    const transport = authority.observation.transport!;
    if (transport.model !== retained.plan.model || normalizeGeminiEndpoint(transport.providerUrl).origin !== retained.endpoint ||
        canonicalJson(retained.result) !== canonicalJson(typed.result) || typed.result.rawJson !== entry.raw_json ||
        retained.plan.requestProfile !== entry.request_profile || canonicalJson(entry.transport_provenance) !== canonicalJson(
          buildExtractionTransportProvenance({ model: retained.plan.model, providerUrl: transport.providerUrl }))) {
      throw new AlayaError("CONFLICT", "typed open-semantics retained transport binding mismatch");
    }
    const metadata = persistedResponseMetadata({ finishReason: "STOP", completionContractVersion: 1,
      completionWitness: "finish_reason" }, retained.result.provenance.usage, true);
    if (canonicalJson(entry.response_metadata) !== canonicalJson(metadata.response_metadata)) {
      throw new AlayaError("CONFLICT", "typed open-semantics retained response metadata mismatch");
    }
    const input = {
      config: { model: entry.model, requestProfile: entry.request_profile },
      line, rawJson: entry.raw_json, sourceCorpus: typed.source_corpus,
      proposal: proposalForRequest(typed.source_corpus, request.source_request.source_assertions.map((row) => row.assertion_id),
        request.source_request.attribution_context),
      retained: { plan: retained.plan, provenance: retained.result.provenance }
    };
    admitted = receiveSourceSemanticBatchLine(input);
    if (retained.result.provenance.attemptOrdinal === undefined) {
      throw new AlayaError("CONFLICT", "current open-semantics Batch artifact lacks its bound provider attempt");
    }
    batchBinding = { attemptOrdinal: retained.result.provenance.attemptOrdinal,
      authorityLineageDigest: authority.lineage_digest };
    const completion = retainableOutcome(admitted);
    if (completion === undefined || completion !== typed.completion) {
      throw new AlayaError("CONFLICT", "typed open-semantics completion mismatch");
    }
  }
  const response = inspectCachedResponseMetadata(entry.response_metadata, typed.kind !== "deterministic_empty");
  const rawJsonSha256 = computeExtractionRawJsonSha256(entry.raw_json);
  if (entry.admission_identity?.request_key !== entry.cache_key ||
      entry.admission_identity.raw_json_sha256 !== rawJsonSha256) {
    throw new AlayaError("CONFLICT", "typed open-semantics admission identity mismatch");
  }
  const inspected = { artifactKind: "source_semantic" as const, sourceBinding: "unbound" as const, admitted,
    requestDigest: computeExtractionRawJsonSha256(line.userPrompt),
    cacheAdmission: entry.admission_identity, deterministicEmpty: typed.kind === "deterministic_empty",
    rawJson: entry.raw_json, rawJsonSha256, rawSignalCount: 0, parsedDraftCount: admitted.draft === undefined ? 0 : 1,
    transportProvenance: entry.transport_provenance, ...response,
    ...(interactiveBinding === undefined ? {} : interactiveBinding),
    ...(batchBinding === undefined ? {} : batchBinding) };
  return interactiveBinding?.admissionState === "pending"
    ? { status: "pending" as const, reason: "source semantic transport attempt is pending successful ledger admission", ...inspected }
    : { status: "hit" as const, ...inspected };
}

export function inspectCachedSourceSemantic(cacheRoot: string, cacheKey: string, model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"], requireAdmission = true) {
  const cached = readCachedEntry(cacheRoot, cacheKey, model, requestProfile);
  if (cached.status !== "hit") return cached;
  try {
    const typed = cached.entry.source_semantic;
    if (typed === undefined) throw new AlayaError("CONFLICT", "typed source semantic artifact is absent");
    const line = SourceRequestLineSchema.parse(artifactLine(typed));
    const request: unknown = JSON.parse(line.userPrompt);
    if (isRetiredSourceRequest(request)) {
      inspectRetiredSourceSemanticEntry(cached.entry, cacheRoot, typed, line, request);
      return { status: "retired" as const, eligibility: "retained_only" as const,
        reason: "retired source semantic artifact is ineligible for current cache reuse" };
    }
    parseSourceSemanticRequest(request);
    const inspected = inspectSourceSemanticEntry(cached.entry, cacheRoot);
    const manifest = readExtractionCacheManifestIdentity(cacheRoot)?.manifest;
    if (manifest?.source_semantic_generation === undefined ||
        extractionAdmissionGenerationSha256(manifest) !== cached.entry.admission_identity?.generation_sha256) {
      throw new AlayaError("CONFLICT", "typed open-semantics generation binding mismatch");
    }
    if (inspected.requestBinding === "unbound") {
      return { status: "invalid" as const, reason: "current source semantic request is unbound" };
    }
    if (requireAdmission && inspected.transportProvenance !== undefined && inspected.status === "hit") {
      if (inspected.attemptOrdinal === undefined || inspected.authorityLineageDigest === undefined) {
        return { status: "invalid" as const, reason: "source semantic provider attempt binding is missing" };
      }
      const admission = inspectSettledProviderAttempt({ cacheRoot, cacheKey, model, requestProfile,
        rawJsonSha256: inspected.rawJsonSha256, transportProvenance: inspected.transportProvenance,
        attemptOrdinal: inspected.attemptOrdinal,
        authorityLineageDigest: inspected.authorityLineageDigest,
        ...(inspected.usage === undefined ? {} : { usage: inspected.usage }) });
      if (admission.status !== "admitted") return { ...(admission.status === "pending" ? inspected : {}),
        status: admission.status === "pending" ? "pending" as const : "invalid" as const,
        reason: admission.reason! };
    }
    return inspected;
  } catch (cause) {
    return { status: "invalid" as const, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

const RETIRED_SELECTION_CONTRACT = "source-semantic-proposal-v7";
const RETIRED_PROPOSAL_CONTRACTS = new Set([
  "source-semantic-proposal-v1", "source-semantic-proposal-v2",
  "source-semantic-proposal-v3", "source-semantic-proposal-v4", RETIRED_SELECTION_CONTRACT
]);

function isRetiredSourceRequest(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const outer = value as Record<string, unknown>;
  const body = outer.source_request;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const contract = (body as Record<string, unknown>).proposal_contract;
  return outer.interpretation_contract === SOURCE_SEMANTIC_PACKET_CONTRACT &&
    Number.isInteger(outer.schema_version) && Number(outer.schema_version) > 0 &&
    (contract === undefined && Number(outer.schema_version) < SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION ||
      typeof contract === "string" && RETIRED_PROPOSAL_CONTRACTS.has(contract));
}

function recordedSourceDigest(request: Record<string, unknown>): string {
  const direct = Object.hasOwn(request, "source_digest");
  const catalogBound = Object.hasOwn(request, "source_catalog");
  const selectionWire = (request.source_request as Record<string, unknown>).proposal_contract === RETIRED_SELECTION_CONTRACT;
  if (direct !== selectionWire || catalogBound === selectionWire) {
    throw new AlayaError("CONFLICT", "retained source semantic source digest witness is absent or ambiguous");
  }
  const catalog = request.source_catalog;
  if (catalogBound && (catalog === null || typeof catalog !== "object" || Array.isArray(catalog))) {
    throw new AlayaError("CONFLICT", "retained source semantic source catalog witness is malformed");
  }
  const digest = direct ? request.source_digest : (catalog as Record<string, unknown>).source_digest;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new AlayaError("CONFLICT", "retained source semantic source digest witness is malformed");
  }
  return digest;
}

/** Bounded recorded-byte and transport classification, without historical proposal decoding. */
function inspectRetiredSourceSemanticEntry(entry: CachedExtractionEntry, cacheRoot: string,
  typed: CachedSourceSemantic, line: SourceRequestLine, request: unknown): void {
  if (Buffer.byteLength(line.userPrompt, "utf8") > 1_000_000 ||
      Buffer.byteLength(line.systemPrompt, "utf8") > 1_000_000 || line.unitKeys.length > 512 ||
      !isRetiredSourceRequest(request) || typed.contract !== SOURCE_SEMANTIC_CACHE_CONTRACT ||
      typed.interpretation_contract !== SOURCE_SEMANTIC_PACKET_CONTRACT || typed.source_binding !== "unbound" ||
      typeof typed.source_corpus !== "string" || typed.producer_id !== SOURCE_SEMANTIC_BATCH_PRODUCER_ID ||
      line.key !== entry.cache_key ||
      line.requestSha256 !== computeExtractionRawJsonSha256(line.userPrompt) ||
      entry.admission_identity?.request_key !== line.key ||
      entry.admission_identity.raw_json_sha256 !== computeExtractionRawJsonSha256(entry.raw_json)) {
    throw new AlayaError("CONFLICT", "retained source semantic recorded-byte binding mismatch");
  }
  const identity = readRetainedSourceSemanticManifestIdentity(cacheRoot);
  if (identity === undefined || identity.generationSha256 !== entry.admission_identity.generation_sha256) {
    throw new AlayaError("CONFLICT", "retained source semantic generation binding mismatch");
  }
  if (recordedSourceDigest(request as Record<string, unknown>) !== computeExtractionRawJsonSha256(typed.source_corpus)) {
    throw new AlayaError("CONFLICT", "retained source semantic source bytes differ from recorded request digest");
  }
  if (identity.systemPromptSha256 !== computeSystemPromptSha256(line.systemPrompt)) {
    throw new AlayaError("CONFLICT", "retained source semantic prompt bytes differ from recorded manifest digest");
  }
  if (typed.kind === "deterministic_empty") {
    const recorded = request as Record<string, unknown>;
    const body = recorded.source_request as Record<string, unknown>;
    const locations = body.assertion_locations;
    const catalog = recorded.source_catalog as Record<string, unknown> | undefined;
    if (entry.raw_json !== "" || entry.transport_provenance !== undefined || entry.response_metadata !== undefined ||
        typed.completion !== "no_eligible_source" || line.unitKeys.length !== 0 ||
        !Array.isArray(body.source_assertions) || body.source_assertions.length !== 0 ||
        (locations !== undefined && (!Array.isArray(locations) || locations.length !== 0)) ||
        (catalog !== undefined && (!Array.isArray(catalog.assertions) || catalog.assertions.length !== 0))) {
      throw new AlayaError("CONFLICT", "retained empty source binding mismatch");
    }
    return;
  }
  if (typed.kind === "gemini_generate_content" || typed.kind === "step_chat_completion" || typed.kind === "intern_chat_completion") {
    inspectInteractiveTransportEvidence(typed, entry, cacheRoot, true);
    return;
  }
  if (typed.kind !== "gemini_batch") throw new AlayaError("CONFLICT", "retained source transport kind is unknown");
  const retained = readRetainedBatchLine(cacheRoot, typed.plan_identity, entry.cache_key);
  const authority = readRetainedBatchAuthority(cacheRoot, typed.plan_identity, typed.authority_receipt_digest);
  const transport = authority.observation.transport!;
  if (transport.model !== retained.plan.model || normalizeGeminiEndpoint(transport.providerUrl).origin !== retained.endpoint ||
      canonicalJson(retained.result) !== canonicalJson(typed.result) || typed.result.rawJson !== entry.raw_json ||
      retained.plan.requestProfile !== entry.request_profile ||
      canonicalJson(entry.transport_provenance) !== canonicalJson(
        buildExtractionTransportProvenance({ model: retained.plan.model, providerUrl: transport.providerUrl }))) {
    throw new AlayaError("CONFLICT", "retained batch source transport binding mismatch");
  }
  const metadata = persistedResponseMetadata({ finishReason: "STOP", completionContractVersion: 1,
    completionWitness: "finish_reason" }, retained.result.provenance.usage, true);
  if (canonicalJson(entry.response_metadata) !== canonicalJson(metadata.response_metadata)) {
    throw new AlayaError("CONFLICT", "retained batch response metadata mismatch");
  }
}

type SourceSemanticImportBase = Readonly<{
  config: CompileSeedExtractionConfig; cacheRoot: string; writeLease: ExtractionCacheWriteLease;
  sourceCorpus: string;
}>;

export function importSourceSemanticArtifact(input: SourceSemanticImportBase & (
  | Readonly<{
      plan: GeminiBatchPlan; authority: ExtractionAuthorityReceipt;
      result: Parameters<GeminiBatchInvocation["importLine"]>[0];
    }>
  | Readonly<{ result: InteractiveSemanticLineResult }>
)) {
  return "plan" in input ? importBatchSourceSemanticArtifact(input) : importInteractiveSourceSemanticArtifact(input);
}

function admitSourceSemanticLine(input: SourceSemanticImportBase & {
  readonly line: SourceRequestLine; readonly rawJson: string;
  readonly retained?: Parameters<typeof receiveSourceSemanticBatchLine>[0]["retained"];
}): { admitted: SourceSemanticProposalResult; completion: NonNullable<ReturnType<typeof retainableOutcome>> } {
  const request = parseSourceSemanticRequest(JSON.parse(input.line.userPrompt));
  let admitted: SourceSemanticProposalResult;
  try {
    admitted = receiveSourceSemanticBatchLine({
      config: input.config, line: input.line, rawJson: input.rawJson, sourceCorpus: input.sourceCorpus,
      proposal: proposalForRequest(input.sourceCorpus, request.source_request.source_assertions.map((row) => row.assertion_id),
        request.source_request.attribution_context),
      ...(input.retained === undefined ? {} : { retained: input.retained })
    });
  } catch (cause) {
    throw new SourceSemanticAdmissionError(`source semantics failed request-bound admission: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  const completion = retainableOutcome(admitted);
  if (completion === undefined) {
    throw new SourceSemanticAdmissionError(`source semantics failed request-bound admission: ${JSON.stringify(admitted.outcome)}; raw_response_id=${admitted.raw_response_id}`);
  }
  return { admitted, completion };
}

function bindOpenSemanticsImport(input: SourceSemanticImportBase, line: SourceRequestLine) {
  input.writeLease.assertOwned(); input.writeLease.assertRoot(input.cacheRoot);
  const identity = readExtractionCacheManifestIdentity(input.cacheRoot);
  if (identity === undefined || input.config.openSemantics === undefined) {
    throw new AlayaError("CONFLICT", "open-semantics import requires a pinned typed generation");
  }
  assertExtractionCacheIdentity({
    config: input.config, manifest: identity.manifest, systemPrompt: line.systemPrompt, validateProvider: true
  });
  if (computeCacheKey(input.config.model, input.config.requestProfile, line.systemPrompt, line.userPrompt) !== line.key) {
    throw new AlayaError("CONFLICT", "open-semantics cache request key mismatch");
  }
  return identity;
}

function importBatchSourceSemanticArtifact(input: SourceSemanticImportBase & Readonly<{
  plan: GeminiBatchPlan; authority: ExtractionAuthorityReceipt;
  result: Parameters<GeminiBatchInvocation["importLine"]>[0];
}>) {
  const { result, config, cacheRoot } = input;
  assertCompleteProviderFinish(result.provenance.finishReason, config.requestProfile);
  const identity = bindOpenSemanticsImport(input, result.line);
  const transport = buildExtractionTransportProvenance(config);
  const authority = readRetainedBatchAuthority(cacheRoot, input.plan.identity, input.authority.receipt_digest);
  if (canonicalJson(transport) !== canonicalJson(buildExtractionTransportProvenance(authority.observation.transport!))) {
    throw new AlayaError("CONFLICT", "open-semantics physical route differs from retained authority");
  }
  if (input.plan.model !== transport.model || input.plan.requestProfile !== config.requestProfile) {
    throw new AlayaError("CONFLICT", "open-semantics native transport differs from generation");
  }
  const { admitted, completion } = admitSourceSemanticLine({
    ...input, line: result.line, rawJson: result.rawJson,
    retained: { plan: input.plan, provenance: result.provenance }
  });
  persistSemanticEntry(input, {
    model: config.model, request_profile: config.requestProfile,
    cache_key: result.line.key, raw_json: result.rawJson, extracted_at: new Date().toISOString(),
    transport_provenance: transport,
    ...persistedResponseMetadata({ finishReason: result.provenance.finishReason, completionContractVersion: 1, completionWitness: "finish_reason" }, result.provenance.usage, true),
    admission_identity: { generation_sha256: extractionAdmissionGenerationSha256(identity.manifest),
      request_key: result.line.key, raw_json_sha256: computeExtractionRawJsonSha256(result.rawJson) },
    source_semantic: { contract: SOURCE_SEMANTIC_CACHE_CONTRACT, source_binding: "unbound",
      interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT, kind: "gemini_batch", completion,
      source_corpus: input.sourceCorpus, producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID,
      plan_identity: input.plan.identity, authority_receipt_digest: input.authority.receipt_digest, result }
  }, identity.manifestSha256);
  return admitted;
}

function importInteractiveSourceSemanticArtifact(input: SourceSemanticImportBase & Readonly<{
  result: InteractiveSemanticLineResult;
}>) {
  const { result, config } = input;
  assertInteractiveProvenance(result.provenance, config.requestProfile);
  assertCompleteProviderFinish(result.provenance.finishReason, config.requestProfile);
  const response = interactiveResponseMetadata(result.provenance);
  inspectCachedResponseMetadata(response.response_metadata, true);
  const identity = bindOpenSemanticsImport(input, result.line);
  const { admitted, completion } = admitSourceSemanticLine({
    ...input, line: result.line, rawJson: result.rawJson
  });
  const entry: CachedExtractionEntry = {
    model: config.model, request_profile: config.requestProfile,
    cache_key: result.line.key, raw_json: result.rawJson, extracted_at: new Date().toISOString(),
    transport_provenance: buildExtractionTransportProvenance(config),
    ...response,
    admission_identity: { generation_sha256: extractionAdmissionGenerationSha256(identity.manifest),
      request_key: result.line.key, raw_json_sha256: computeExtractionRawJsonSha256(result.rawJson) },
    source_semantic: { contract: SOURCE_SEMANTIC_CACHE_CONTRACT, source_binding: "unbound",
      interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
      kind: interactiveSourceTransportBinding(config.requestProfile).kind, completion,
      source_corpus: input.sourceCorpus, producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID, result }
  };
  inspectInteractiveTransportEvidence(entry.source_semantic as Extract<CachedSourceSemantic,
    { kind: "gemini_generate_content" | "step_chat_completion" | "intern_chat_completion" }>, entry, input.cacheRoot);
  persistSemanticEntry(input, entry, identity.manifestSha256);
  return admitted;
}

export function writeDeterministicSourceSemanticArtifact(input: Readonly<{
  config: CompileSeedExtractionConfig; cacheRoot: string; writeLease: ExtractionCacheWriteLease;
  line: SourceRequestLine; sourceCorpus: string;
}>) {
  const { cacheRoot, config, writeLease, line } = input;
  writeLease.assertOwned(); writeLease.assertRoot(cacheRoot);
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity === undefined || config.openSemantics === undefined) throw new AlayaError("CONFLICT", "deterministic open semantics requires a pinned typed generation");
  assertExtractionCacheIdentity({ config, manifest: identity.manifest, systemPrompt: line.systemPrompt, validateProvider: true });
  const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
  if (computeCacheKey(config.model, config.requestProfile, line.systemPrompt, line.userPrompt) !== line.key) {
    throw new AlayaError("CONFLICT", "deterministic open-semantics generation mismatch");
  }
  completeEmptySourceSemantics(request, proposalForRequest(input.sourceCorpus, request.source_request.source_assertions.map((row) => row.assertion_id)));
  const rawJson = "";
  const entry: CachedExtractionEntry = { model: config.model, request_profile: config.requestProfile,
    cache_key: line.key, raw_json: rawJson, extracted_at: new Date().toISOString(),
    admission_identity: { generation_sha256: extractionAdmissionGenerationSha256(identity.manifest),
      request_key: line.key, raw_json_sha256: computeExtractionRawJsonSha256(rawJson) },
    source_semantic: { contract: SOURCE_SEMANTIC_CACHE_CONTRACT, source_binding: "unbound",
      interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT, kind: "deterministic_empty",
      completion: "no_eligible_source", source_corpus: input.sourceCorpus,
      producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID, line } };
  persistSemanticEntry(input, entry, identity.manifestSha256);
}

function persistSemanticEntry(input: Readonly<{ cacheRoot: string; config: CompileSeedExtractionConfig; writeLease: ExtractionCacheWriteLease }>,
  entry: CachedExtractionEntry, manifestSha256: string) {
  const { cacheRoot, config, writeLease } = input;
  const existing = readCachedEntry(cacheRoot, entry.cache_key, config.model, config.requestProfile);
  if (existing.status === "hit") {
    const inspected = inspectCachedSourceSemantic(cacheRoot, entry.cache_key, config.model, config.requestProfile);
    if (inspected.status !== "hit" && inspected.status !== "pending") {
      throw new AlayaError("CONFLICT", "existing open-semantics generation is invalid");
    }
    if (canonicalJson(existing.entry.source_semantic) !== canonicalJson(entry.source_semantic)) {
      throw new AlayaError("CONFLICT", "open-semantics import conflicts with admitted artifact");
    }
  } else {
    if (existing.status !== "missing") throw new AlayaError("CONFLICT", existing.reason);
    writeCachedExtraction(cacheRoot, entry.cache_key, entry);
  }
  writeLease.assertOwned();
  if (readExtractionCacheManifestIdentity(cacheRoot)?.manifestSha256 !== manifestSha256) {
    throw new AlayaError("CONFLICT", "open-semantics generation changed during publication");
  }
}
