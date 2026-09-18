import { parseOfficialApiSourcePacketRequest, completeEmptyOfficialApiSourcePacket, MAX_OFFICIAL_API_SOURCE_PACKET_RESPONSE_BYTES } from "@do-soul/alaya-soul";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { createSourceInterpretationPacketPublication } from "@do-soul/alaya-core";
import { readCachedEntry, writeCachedExtraction, MAX_EXTRACTION_CACHE_SHARD_BYTES, type CachedExtractionEntry } from "../../compile-seed/cache/cache-shard.js";
import { computeCacheKey } from "../../compile-seed/cache/cache-key.js";
import { inspectCachedResponseMetadata, persistedResponseMetadata } from "../../compile-seed/cache/cached-response-metadata.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import { computeExtractionRawJsonSha256 } from "../content-closure.js";
import { receiveSourceInterpretationPacketBatchLine } from "../fill/batch/source-interpretation-packet.js";
import type { GeminiBatchInvocation, GeminiBatchPlan, GeminiBatchLine } from "../fill/batch/contract.js";
import type { ExtractionCacheWriteLease } from "../fill/manifest/fill-root-guard.js";
import { buildExtractionTransportProvenance } from "../transport-route.js";
import { assertExtractionCacheIdentity } from "./cache-identity.js";
import { extractionAdmissionGenerationSha256, readExtractionCacheManifestIdentity } from "./extraction-cache-manifest.js";
import { normalizeGeminiEndpoint } from "../../provider/gemini-endpoint.js";
import type { ExtractionAuthorityReceipt } from "../authority/receipt.js";
import { readRetainedBatchAuthority } from "../fill/batch/retained-authority.js";
import { readRetainedBatchLine } from "../fill/batch/retained-line.js";

export class SourcePacketAdmissionError extends Error {}

export type CachedSourcePacket = Readonly<{
  contract: "source-interpretation-cache-v1";
  source_binding: "unbound";
  completion: "received" | "empty";
  source_corpus: string;
  producer_id: string;
}> & (
  | Readonly<{ kind: "gemini_batch"; plan_identity: string; authority_receipt_digest: string; result: Parameters<GeminiBatchInvocation["importLine"]>[0] }>
  | Readonly<{ kind: "deterministic_empty"; line: GeminiBatchLine }>
);

function artifactLine(typed: CachedSourcePacket): GeminiBatchLine {
  return typed.kind === "deterministic_empty" ? typed.line : typed.result.line;
}

/** Two retained copies of raw JSON may each expand sixfold when JSON encoded. */
export function assertSourcePacketShardCapacity(sourceCorpus: string, line: GeminiBatchLine): void {
  const retainedInputBytes = Buffer.byteLength(JSON.stringify({ source_packet: {
    source_corpus: sourceCorpus, result: { line }
  } }, null, 2), "utf8");
  const receiptAndEnvelopeAllowance = 1024 * 1024;
  if (retainedInputBytes + 12 * MAX_OFFICIAL_API_SOURCE_PACKET_RESPONSE_BYTES + receiptAndEnvelopeAllowance >
      MAX_EXTRACTION_CACHE_SHARD_BYTES) throw new Error("typed packet source/request exceeds durable shard byte capacity before reservation");
}

/** Typed cache admission is neither a signal shard nor audited Core publication. */
function inspectSourcePacketEntry(entry: CachedExtractionEntry, cacheRoot: string) {
  const typed = entry.source_packet;
  if (typed?.contract !== "source-interpretation-cache-v1" || typed.source_binding !== "unbound" ||
      typeof typed.source_corpus !== "string" || typeof typed.producer_id !== "string" ||
      (typed.kind !== "gemini_batch" && typed.kind !== "deterministic_empty")) throw new Error("invalid typed source interpretation cache artifact");
  const line = artifactLine(typed);
  if (line.key !== entry.cache_key || computeCacheKey(entry.model, entry.request_profile, line.systemPrompt, line.userPrompt) !== line.key) {
    throw new Error("typed packet request key mismatch");
  }
  let admitted: ReturnType<typeof receiveSourceInterpretationPacketBatchLine>;
  if (typed.kind === "deterministic_empty") {
    if (entry.transport_provenance !== undefined || entry.response_metadata !== undefined) throw new Error("deterministic packet cannot carry a provider receipt");
    const empty = completeEmptyOfficialApiSourcePacket(parseOfficialApiSourcePacketRequest(JSON.parse(line.userPrompt)),
      { sourceCorpus: typed.source_corpus, artifactKey: entry.cache_key, producerId: typed.producer_id });
    if (entry.raw_json !== empty.rawJson) throw new Error("deterministic packet has nonempty output");
    admitted = empty.received;
  } else {
    const retained = readRetainedBatchLine(cacheRoot, typed.plan_identity, entry.cache_key);
    const authority = readRetainedBatchAuthority(cacheRoot, typed.plan_identity, typed.authority_receipt_digest);
    const transport = authority.observation.transport!;
    if (transport.model !== retained.plan.model || normalizeGeminiEndpoint(transport.providerUrl).origin !== retained.endpoint ||
        canonicalJson(retained.result) !== canonicalJson(typed.result) || typed.result.rawJson !== entry.raw_json ||
        retained.plan.requestProfile !== entry.request_profile || canonicalJson(entry.transport_provenance) !== canonicalJson(
          buildExtractionTransportProvenance({ model: retained.plan.model, providerUrl: transport.providerUrl }))) {
      throw new Error("typed packet retained transport binding mismatch");
    }
    const metadata = persistedResponseMetadata({ finishReason: "STOP", completionContractVersion: 1,
      completionWitness: "finish_reason" }, retained.result.provenance.usage, true);
    if (canonicalJson(entry.response_metadata) !== canonicalJson(metadata.response_metadata)) throw new Error("typed packet retained response metadata mismatch");
    admitted = receiveSourceInterpretationPacketBatchLine({ config: { model: entry.model, requestProfile: entry.request_profile },
      line, rawJson: entry.raw_json, sourceCorpus: typed.source_corpus, artifactKey: entry.cache_key, producerId: typed.producer_id,
      retained: { plan: retained.plan, provenance: retained.result.provenance } });
  }
  const response = inspectCachedResponseMetadata(entry.response_metadata, typed.kind === "gemini_batch");
  const rawJsonSha256 = computeExtractionRawJsonSha256(entry.raw_json);
  if (admitted.status !== typed.completion || entry.admission_identity?.request_key !== entry.cache_key ||
      entry.admission_identity.raw_json_sha256 !== rawJsonSha256) throw new Error("typed packet admission identity mismatch");
  return { status: "hit" as const, artifactKind: "source_interpretation" as const, sourceBinding: "unbound" as const, admitted,
    cacheAdmission: entry.admission_identity, deterministicEmpty: typed.kind === "deterministic_empty",
    rawJson: entry.raw_json, rawJsonSha256, rawSignalCount: 0, parsedDraftCount: 0,
    transportProvenance: entry.transport_provenance, ...response };
}

export function inspectCachedSourcePacket(cacheRoot: string, cacheKey: string, model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]) {
  const cached = readCachedEntry(cacheRoot, cacheKey, model, requestProfile);
  if (cached.status !== "hit") return cached;
  try {
    const inspected = inspectSourcePacketEntry(cached.entry, cacheRoot);
    const manifest = readExtractionCacheManifestIdentity(cacheRoot)?.manifest;
    const request = parseOfficialApiSourcePacketRequest(JSON.parse(artifactLine(cached.entry.source_packet!).userPrompt));
    if (manifest?.source_interpretation_profile === undefined ||
        canonicalJson(request.profile) !== canonicalJson(manifest.source_interpretation_profile) ||
        extractionAdmissionGenerationSha256(manifest) !== cached.entry.admission_identity!.generation_sha256) {
      throw new Error("typed packet generation binding mismatch");
    }
    return inspected;
  } catch (cause) {
    return { status: "invalid" as const, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function importSourcePacketArtifact(input: Readonly<{
  config: CompileSeedExtractionConfig; cacheRoot: string; writeLease: ExtractionCacheWriteLease;
  sourceCorpus: string; plan: GeminiBatchPlan; authority: ExtractionAuthorityReceipt; result: Parameters<GeminiBatchInvocation["importLine"]>[0];
}>) {
  const { result, config, cacheRoot, writeLease } = input;
  writeLease.assertOwned(); writeLease.assertRoot(cacheRoot);
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity === undefined || config.sourceInterpretationProfile === undefined) throw new Error("packet import requires a pinned typed generation");
  assertExtractionCacheIdentity({ config, manifest: identity.manifest, systemPrompt: result.line.systemPrompt, validateProvider: true });
  if (computeCacheKey(config.model, config.requestProfile, result.line.systemPrompt, result.line.userPrompt) !== result.line.key) {
    throw new Error("packet cache request key mismatch");
  }
  const request = parseOfficialApiSourcePacketRequest(JSON.parse(result.line.userPrompt));
  if (canonicalJson(request.profile) !== canonicalJson(config.sourceInterpretationProfile)) throw new Error("packet request profile differs from generation");
  const transport = buildExtractionTransportProvenance(config);
  const authority = readRetainedBatchAuthority(cacheRoot, input.plan.identity, input.authority.receipt_digest);
  if (canonicalJson(transport) !== canonicalJson(buildExtractionTransportProvenance(authority.observation.transport!))) {
    throw new Error("packet physical route differs from retained authority");
  }
  if (input.plan.model !== transport.model || input.plan.requestProfile !== config.requestProfile) throw new Error("packet native transport differs from generation");
  let admitted: ReturnType<typeof receiveSourceInterpretationPacketBatchLine>;
  try { admitted = receiveSourceInterpretationPacketBatchLine({ config, line: result.line, rawJson: result.rawJson,
    sourceCorpus: input.sourceCorpus, artifactKey: result.line.key, producerId: "official-api-source-packet",
    retained: { plan: input.plan, provenance: result.provenance } }); }
  catch (cause) { throw new SourcePacketAdmissionError(`source packet failed request-bound admission: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
  const rawJsonSha256 = computeExtractionRawJsonSha256(result.rawJson);
  const entry: CachedExtractionEntry = { model: config.model, request_profile: config.requestProfile,
    cache_key: result.line.key, raw_json: result.rawJson, extracted_at: new Date().toISOString(),
    transport_provenance: buildExtractionTransportProvenance(config),
    ...persistedResponseMetadata({ finishReason: "STOP", completionContractVersion: 1, completionWitness: "finish_reason" }, result.provenance.usage, true),
    admission_identity: { generation_sha256: extractionAdmissionGenerationSha256(identity.manifest),
      request_key: result.line.key, raw_json_sha256: rawJsonSha256 },
    source_packet: { contract: "source-interpretation-cache-v1", source_binding: "unbound", kind: "gemini_batch", completion: admitted.status,
      source_corpus: input.sourceCorpus, producer_id: "official-api-source-packet",
      plan_identity: input.plan.identity, authority_receipt_digest: input.authority.receipt_digest, result } };
  persistPacketEntry(input, entry, identity.manifestSha256);
  return admitted.status;
}

export function writeDeterministicSourcePacketArtifact(input: Readonly<{
  config: CompileSeedExtractionConfig; cacheRoot: string; writeLease: ExtractionCacheWriteLease;
  line: GeminiBatchLine; sourceCorpus: string;
}>) {
  const { cacheRoot, config, writeLease, line } = input;
  writeLease.assertOwned(); writeLease.assertRoot(cacheRoot);
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity === undefined || config.sourceInterpretationProfile === undefined) throw new Error("deterministic packet requires a pinned typed generation");
  assertExtractionCacheIdentity({ config, manifest: identity.manifest, systemPrompt: line.systemPrompt, validateProvider: true });
  const request = parseOfficialApiSourcePacketRequest(JSON.parse(line.userPrompt));
  if (canonicalJson(request.profile) !== canonicalJson(config.sourceInterpretationProfile) ||
      computeCacheKey(config.model, config.requestProfile, line.systemPrompt, line.userPrompt) !== line.key) throw new Error("deterministic packet generation mismatch");
  const { rawJson } = completeEmptyOfficialApiSourcePacket(request,
    { sourceCorpus: input.sourceCorpus, artifactKey: line.key, producerId: "deterministic-source-catalog" });
  const entry: CachedExtractionEntry = { model: config.model, request_profile: config.requestProfile,
    cache_key: line.key, raw_json: rawJson, extracted_at: new Date().toISOString(),
    admission_identity: { generation_sha256: extractionAdmissionGenerationSha256(identity.manifest),
      request_key: line.key, raw_json_sha256: computeExtractionRawJsonSha256(rawJson) },
    source_packet: { contract: "source-interpretation-cache-v1", source_binding: "unbound", kind: "deterministic_empty",
      completion: "empty", source_corpus: input.sourceCorpus, producer_id: "deterministic-source-catalog", line } };
  persistPacketEntry(input, entry, identity.manifestSha256);
}

function persistPacketEntry(input: Readonly<{ cacheRoot: string; config: CompileSeedExtractionConfig; writeLease: ExtractionCacheWriteLease }>,
  entry: CachedExtractionEntry, manifestSha256: string) {
  const { cacheRoot, config, writeLease } = input;
  const existing = readCachedEntry(cacheRoot, entry.cache_key, config.model, config.requestProfile);
  if (existing.status === "hit") {
    if (inspectCachedSourcePacket(cacheRoot, entry.cache_key, config.model, config.requestProfile).status !== "hit") throw new Error("existing packet generation is invalid");
    if (canonicalJson(existing.entry.source_packet) !== canonicalJson(entry.source_packet)) throw new Error("packet import conflicts with admitted artifact");
  } else {
    if (existing.status !== "missing") throw new Error(existing.reason);
    writeCachedExtraction(cacheRoot, entry.cache_key, entry);
  }
  writeLease.assertOwned();
  if (readExtractionCacheManifestIdentity(cacheRoot)?.manifestSha256 !== manifestSha256) throw new Error("packet generation changed during publication");
}

/** The cache does not own source IDs. The caller names an admitted source; Core checks exact current bytes. */
export async function publishCachedSourcePacket(input: Readonly<{
  cacheRoot: string; cacheKey: string; config: Pick<CompileSeedExtractionConfig, "model" | "requestProfile">;
  owner: Parameters<typeof createSourceInterpretationPacketPublication>[0]; workspaceId: string; runId: string; sourceId: string;
}>) {
  const cached = inspectCachedSourcePacket(input.cacheRoot, input.cacheKey, input.config.model, input.config.requestProfile);
  if (cached.status !== "hit") throw new Error(`source packet artifact unavailable: ${cached.status}`);
  if (cached.admitted.status === "empty") return { status: "empty" as const };
  const publication = await createSourceInterpretationPacketPublication(input.owner).publish({
    ...cached.admitted.draft, artifactKey: input.sourceId, workspaceId: input.workspaceId, runId: input.runId,
    provenance: { ...cached.admitted.draft.provenance, cache_admission: cached.cacheAdmission } });
  return { status: "published" as const, ...publication };
}
