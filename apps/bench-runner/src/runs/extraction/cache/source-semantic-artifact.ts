import {
  parseSourceSemanticRequest, completeEmptySourceSemantics, MAX_SOURCE_SEMANTIC_RESPONSE_BYTES,
  type SourceSemanticProposalResult
} from "@do-soul/alaya-soul";
import {
  AlayaError, canonicalJson, SOURCE_SEMANTIC_CACHE_CONTRACT, SOURCE_SEMANTIC_PACKET_CONTRACT
} from "@do-soul/alaya-protocol";
import { readCachedEntry, writeCachedExtraction, MAX_EXTRACTION_CACHE_SHARD_BYTES, type CachedExtractionEntry } from "../../compile-seed/cache/cache-shard.js";
import { computeCacheKey } from "../../compile-seed/cache/cache-key.js";
import { inspectCachedResponseMetadata, persistedResponseMetadata } from "../../compile-seed/cache/cached-response-metadata.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import { computeExtractionRawJsonSha256 } from "../content-closure.js";
import { receiveSourceSemanticBatchLine } from "../fill/batch/source-semantic-interpretation.js";
import type { GeminiBatchInvocation, GeminiBatchPlan, GeminiBatchLine } from "../fill/batch/contract.js";
import type { ExtractionCacheWriteLease } from "../fill/manifest/fill-root-guard.js";
import { buildExtractionTransportProvenance } from "../transport-route.js";
import { assertExtractionCacheIdentity } from "./cache-identity.js";
import { extractionAdmissionGenerationSha256, readExtractionCacheManifestIdentity } from "./extraction-cache-manifest.js";
import { normalizeGeminiEndpoint } from "../../provider/gemini-endpoint.js";
import type { ExtractionAuthorityReceipt } from "../authority/receipt.js";
import { readRetainedBatchAuthority } from "../fill/batch/retained-authority.js";
import { readRetainedBatchLine } from "../fill/batch/retained-line.js";
import {
  EXTRACTION_OPEN_SEMANTICS_GENERATION, SOURCE_SEMANTIC_BATCH_PRODUCER_ID, SOURCE_SEMANTIC_BATCH_PRODUCER_VERSION
} from "../request-artifact.js";

export class SourceSemanticAdmissionError extends Error {}

export type CachedSourceSemantic = Readonly<{
  contract: typeof SOURCE_SEMANTIC_CACHE_CONTRACT;
  source_binding: "unbound";
  interpretation_contract: typeof SOURCE_SEMANTIC_PACKET_CONTRACT;
  completion: "interpreted" | "abstained" | "no_eligible_source";
  source_corpus: string;
  producer_id: string;
}> & (
  | Readonly<{ kind: "gemini_batch"; plan_identity: string; authority_receipt_digest: string; result: Parameters<GeminiBatchInvocation["importLine"]>[0] }>
  | Readonly<{ kind: "deterministic_empty"; line: GeminiBatchLine }>
);

function artifactLine(typed: CachedSourceSemantic): GeminiBatchLine {
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

function proposalForRequest(sourceCorpus: string, assertionIds: readonly number[]) {
  return { ...unboundProposal(sourceCorpus), assertionIds };
}

/** Two retained copies of raw JSON may each expand sixfold; host IR/refs add another escaped copy. */
export function assertSourceSemanticShardCapacity(sourceCorpus: string, line: GeminiBatchLine): void {
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

function retainableOutcome(result: SourceSemanticProposalResult): "interpreted" | "abstained" | undefined {
  if (result.outcome.status === "interpreted" || result.outcome.status === "abstained") return result.outcome.status;
  return undefined;
}

function inspectSourceSemanticEntry(entry: CachedExtractionEntry, cacheRoot: string) {
  const typed = entry.source_semantic;
  if (typed?.contract !== SOURCE_SEMANTIC_CACHE_CONTRACT || typed.source_binding !== "unbound" ||
      typed.interpretation_contract !== SOURCE_SEMANTIC_PACKET_CONTRACT ||
      typeof typed.source_corpus !== "string" || typeof typed.producer_id !== "string" ||
      (typed.kind !== "gemini_batch" && typed.kind !== "deterministic_empty")) {
    throw new AlayaError("CONFLICT", "invalid typed source semantic cache artifact");
  }
  const line = artifactLine(typed);
  if (line.key !== entry.cache_key || computeCacheKey(entry.model, entry.request_profile, line.systemPrompt, line.userPrompt) !== line.key) {
    throw new AlayaError("CONFLICT", "typed open-semantics request key mismatch");
  }
  const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
  let admitted: SourceSemanticProposalResult;
  if (typed.kind === "deterministic_empty") {
    if (entry.transport_provenance !== undefined || entry.response_metadata !== undefined) {
      throw new AlayaError("CONFLICT", "deterministic open semantics cannot carry a provider receipt");
    }
    if (entry.raw_json !== "") throw new AlayaError("CONFLICT", "deterministic open semantics has nonempty output");
    admitted = completeEmptySourceSemantics(request, proposalForRequest(typed.source_corpus, request.source_request.source_assertions.map((row) => row.assertion_id)));
    if (admitted.outcome.status !== "no_eligible_source" || typed.completion !== "no_eligible_source") {
      throw new AlayaError("CONFLICT", "deterministic open semantics is not a zero-attempt empty catalog");
    }
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
    admitted = receiveSourceSemanticBatchLine({
      config: { model: entry.model, requestProfile: entry.request_profile },
      line, rawJson: entry.raw_json, sourceCorpus: typed.source_corpus,
      proposal: proposalForRequest(typed.source_corpus, request.source_request.source_assertions.map((row) => row.assertion_id)),
      retained: { plan: retained.plan, provenance: retained.result.provenance }
    });
    const completion = retainableOutcome(admitted);
    if (completion === undefined || completion !== typed.completion) {
      throw new AlayaError("CONFLICT", "typed open-semantics completion mismatch");
    }
  }
  const response = inspectCachedResponseMetadata(entry.response_metadata, typed.kind === "gemini_batch");
  const rawJsonSha256 = computeExtractionRawJsonSha256(entry.raw_json);
  if (entry.admission_identity?.request_key !== entry.cache_key ||
      entry.admission_identity.raw_json_sha256 !== rawJsonSha256) {
    throw new AlayaError("CONFLICT", "typed open-semantics admission identity mismatch");
  }
  return { status: "hit" as const, artifactKind: "source_semantic" as const, sourceBinding: "unbound" as const, admitted,
    cacheAdmission: entry.admission_identity, deterministicEmpty: typed.kind === "deterministic_empty",
    rawJson: entry.raw_json, rawJsonSha256, rawSignalCount: 0, parsedDraftCount: admitted.draft === undefined ? 0 : 1,
    transportProvenance: entry.transport_provenance, ...response };
}

export function inspectCachedSourceSemantic(cacheRoot: string, cacheKey: string, model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]) {
  const cached = readCachedEntry(cacheRoot, cacheKey, model, requestProfile);
  if (cached.status !== "hit") return cached;
  try {
    const inspected = inspectSourceSemanticEntry(cached.entry, cacheRoot);
    const manifest = readExtractionCacheManifestIdentity(cacheRoot)?.manifest;
    if (manifest?.source_semantic_generation === undefined ||
        canonicalJson(manifest.source_semantic_generation) !== canonicalJson(EXTRACTION_OPEN_SEMANTICS_GENERATION) ||
        extractionAdmissionGenerationSha256(manifest) !== cached.entry.admission_identity!.generation_sha256) {
      throw new AlayaError("CONFLICT", "typed open-semantics generation binding mismatch");
    }
    return inspected;
  } catch (cause) {
    return { status: "invalid" as const, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function importSourceSemanticArtifact(input: Readonly<{
  config: CompileSeedExtractionConfig; cacheRoot: string; writeLease: ExtractionCacheWriteLease;
  sourceCorpus: string; plan: GeminiBatchPlan; authority: ExtractionAuthorityReceipt; result: Parameters<GeminiBatchInvocation["importLine"]>[0];
}>) {
  const { result, config, cacheRoot, writeLease } = input;
  writeLease.assertOwned(); writeLease.assertRoot(cacheRoot);
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity === undefined || config.openSemantics === undefined) throw new AlayaError("CONFLICT", "open-semantics import requires a pinned typed generation");
  assertExtractionCacheIdentity({ config, manifest: identity.manifest, systemPrompt: result.line.systemPrompt, validateProvider: true });
  if (computeCacheKey(config.model, config.requestProfile, result.line.systemPrompt, result.line.userPrompt) !== result.line.key) {
    throw new AlayaError("CONFLICT", "open-semantics cache request key mismatch");
  }
  const request = parseSourceSemanticRequest(JSON.parse(result.line.userPrompt));
  const transport = buildExtractionTransportProvenance(config);
  const authority = readRetainedBatchAuthority(cacheRoot, input.plan.identity, input.authority.receipt_digest);
  if (canonicalJson(transport) !== canonicalJson(buildExtractionTransportProvenance(authority.observation.transport!))) {
    throw new AlayaError("CONFLICT", "open-semantics physical route differs from retained authority");
  }
  if (input.plan.model !== transport.model || input.plan.requestProfile !== config.requestProfile) {
    throw new AlayaError("CONFLICT", "open-semantics native transport differs from generation");
  }
  let admitted: SourceSemanticProposalResult;
  try {
    admitted = receiveSourceSemanticBatchLine({
      config, line: result.line, rawJson: result.rawJson, sourceCorpus: input.sourceCorpus,
      proposal: proposalForRequest(input.sourceCorpus, request.source_request.source_assertions.map((row) => row.assertion_id)),
      retained: { plan: input.plan, provenance: result.provenance }
    });
  } catch (cause) {
    throw new SourceSemanticAdmissionError(`source semantics failed request-bound admission: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  const completion = retainableOutcome(admitted);
  if (completion === undefined) {
    throw new SourceSemanticAdmissionError(`source semantics failed request-bound admission: ${admitted.outcome.status}`);
  }
  const rawJsonSha256 = computeExtractionRawJsonSha256(result.rawJson);
  const entry: CachedExtractionEntry = { model: config.model, request_profile: config.requestProfile,
    cache_key: result.line.key, raw_json: result.rawJson, extracted_at: new Date().toISOString(),
    transport_provenance: buildExtractionTransportProvenance(config),
    ...persistedResponseMetadata({ finishReason: "STOP", completionContractVersion: 1, completionWitness: "finish_reason" }, result.provenance.usage, true),
    admission_identity: { generation_sha256: extractionAdmissionGenerationSha256(identity.manifest),
      request_key: result.line.key, raw_json_sha256: rawJsonSha256 },
    source_semantic: { contract: SOURCE_SEMANTIC_CACHE_CONTRACT, source_binding: "unbound",
      interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT, kind: "gemini_batch", completion,
      source_corpus: input.sourceCorpus, producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID,
      plan_identity: input.plan.identity, authority_receipt_digest: input.authority.receipt_digest, result } };
  persistSemanticEntry(input, entry, identity.manifestSha256);
  return admitted;
}

export function writeDeterministicSourceSemanticArtifact(input: Readonly<{
  config: CompileSeedExtractionConfig; cacheRoot: string; writeLease: ExtractionCacheWriteLease;
  line: GeminiBatchLine; sourceCorpus: string;
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
    if (inspectCachedSourceSemantic(cacheRoot, entry.cache_key, config.model, config.requestProfile).status !== "hit") {
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
