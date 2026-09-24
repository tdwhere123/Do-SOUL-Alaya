import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import type { CachedExtractionEntry } from "../../compile-seed/cache/cache-shard.js";
import { inspectCachedResponseMetadata, persistedResponseMetadata } from "../../compile-seed/cache/cached-response-metadata.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import { isCompleteSemanticFinish, STEP_SEMANTIC_REQUEST_PROFILE } from "../../compile-seed/http/semantic-provider-http.js";
import { inspectExtractionAttemptLedger } from "../authority/attempt-ledger.js";
import { baseReportedUsage } from "../authority/step-quote.js";
import { computeExtractionRawJsonSha256 } from "../content-closure.js";
import { readProviderRawAttempt, verifyProviderRawReservation } from "../fill/provider-raw-attempt.js";
import { readRetainedInteractiveAuthority } from "../fill/retained-interactive-authority.js";
import { sourceSemanticRequestWireDigest } from "../fill/source-semantic-interactive-request.js";
import { buildExtractionTransportProvenance, isExtractionTransportProvenance } from "../transport-route.js";
import { computeSystemPromptSha256, readRetainedSourceSemanticManifestIdentity } from "./extraction-cache-manifest.js";
import type { CachedSourceSemantic, InteractiveSemanticProvenance } from "./source-semantic-artifact.js";

export function assertInteractiveProvenance(provenance: InteractiveSemanticProvenance, requestProfile: string): void {
  const transport = requestProfile === STEP_SEMANTIC_REQUEST_PROFILE
    ? "step-chat-completion" : "gemini-generate-content";
  if (provenance.transport !== transport || "job" in provenance || "inputFile" in provenance ||
      !Number.isSafeInteger(provenance.attemptOrdinal) || provenance.attemptOrdinal <= 0) {
    throw new AlayaError("CONFLICT", "typed open-semantics interactive transport binding mismatch");
  }
}

export function interactiveResponseMetadata(provenance: InteractiveSemanticProvenance) {
  return persistedResponseMetadata({ finishReason: provenance.finishReason, completionContractVersion: 1,
    completionWitness: "finish_reason" }, provenance.usage, true);
}

/** One outer-evidence check for import, current reuse, and retained classification. */
export function inspectInteractiveTransportEvidence(
  typed: Extract<CachedSourceSemantic, { kind: "gemini_generate_content" | "step_chat_completion" }>,
  entry: CachedExtractionEntry,
  cacheRoot: string
): { readonly attemptOrdinal: number; readonly authorityLineageDigest: string;
  readonly admissionState: "pending" | "admitted" } {
  if ((typed.kind === "step_chat_completion") !==
      (entry.request_profile === STEP_SEMANTIC_REQUEST_PROFILE)) {
    throw new AlayaError("CONFLICT", "typed source semantic cache kind/profile mismatch");
  }
  assertInteractiveProvenance(typed.result.provenance, entry.request_profile);
  if (!isCompleteSemanticFinish(entry.request_profile, typed.result.provenance.finishReason) ||
      typed.result.rawJson !== entry.raw_json ||
      typed.result.provenance.responseSha256 !== computeExtractionRawJsonSha256(entry.raw_json) ||
      !isExtractionTransportProvenance(entry.transport_provenance)) {
    throw new AlayaError("CONFLICT", "typed open-semantics interactive transport binding mismatch");
  }
  inspectCachedResponseMetadata(entry.response_metadata, true);
  if (canonicalJson(entry.response_metadata) !==
      canonicalJson(interactiveResponseMetadata(typed.result.provenance).response_metadata)) {
    throw new AlayaError("CONFLICT", "typed open-semantics retained response metadata mismatch");
  }
  const { provenance, line } = typed.result;
  const raw = readProviderRawAttempt(cacheRoot, entry.cache_key, provenance.attemptOrdinal);
  if (raw?.kind !== "source_semantic" || raw.authority_receipt_digest === undefined ||
      raw.authority_lineage_digest === undefined || raw.source_request_sha256 === undefined) {
    throw new AlayaError("CONFLICT", "typed source semantic raw attempt witness is absent");
  }
  const receipt = readRetainedInteractiveAuthority(cacheRoot, raw.authority_receipt_digest,
    raw.authority_lineage_digest);
  const transport = receipt.observation.transport!;
  const logical = receipt.observation.extraction;
  const manifest = readRetainedSourceSemanticManifestIdentity(cacheRoot);
  const requestConfig: CompileSeedExtractionConfig = {
    model: entry.model, requestProfile: entry.request_profile,
    providerUrl: logical.providerUrl, transportProviderUrl: transport.providerUrl,
    transportModel: transport.model, apiKey: null
  };
  if (manifest?.providerUrl !== logical.providerUrl ||
      manifest.systemPromptSha256 !== logical.systemPromptSha256 ||
      logical.systemPromptSha256 !== computeSystemPromptSha256(line.systemPrompt) ||
      logical.model !== entry.model || logical.requestProfile !== entry.request_profile ||
      raw.model !== entry.model || raw.request_profile !== entry.request_profile ||
      raw.source_request_sha256 !== computeExtractionRawJsonSha256(line.userPrompt) ||
      line.requestSha256 !== raw.source_request_sha256 ||
      raw.request_digest !== sourceSemanticRequestWireDigest(requestConfig, line, receipt.limits.max_output_tokens) ||
      canonicalJson(entry.transport_provenance) !== canonicalJson(buildExtractionTransportProvenance(transport)) ||
      !raw.full_replay_possible || raw.transport_failure !== undefined ||
      raw.decoded_text !== entry.raw_json || raw.decoded_text_digest !== provenance.responseSha256 ||
      raw.finish_reason !== provenance.finishReason ||
      canonicalJson(raw.usage === null ? undefined : baseReportedUsage(raw.usage)) !==
        canonicalJson(provenance.usage)) {
    throw new AlayaError("CONFLICT", "typed source semantic raw/request/physical transport binding mismatch");
  }
  const ledger = inspectExtractionAttemptLedger({ cacheRoot, lineageDigest: raw.authority_lineage_digest,
    cacheIdentity: { model: entry.model, requestProfile: entry.request_profile } });
  if (ledger === undefined || ledger.startingMissing !== receipt.limits.starting_missing ||
      ledger.maximumAttempts !== receipt.limits.maximum_attempts ||
      ledger.successfulShardCeiling !== receipt.limits.successful_shard_ceiling ||
      verifyProviderRawReservation(raw, ledger) === "rejected") {
    throw new AlayaError("CONFLICT", "typed source semantic raw attempt has no admissible reservation");
  }
  const successful = ledger.successfulEntries.find((shard) => shard.cacheKey === entry.cache_key);
  const settled = ledger.settledAttempts.some((attempt) => attempt.cacheKey === entry.cache_key &&
    attempt.attemptOrdinal === provenance.attemptOrdinal);
  const unresolved = ledger.unresolvedAttempts.some((attempt) => attempt.cacheKey === entry.cache_key &&
    attempt.attemptOrdinal === provenance.attemptOrdinal);
  if (successful === undefined) {
    if (!ledger.pendingKeys.includes(entry.cache_key) || !settled && !unresolved) {
      throw new AlayaError("CONFLICT", "typed source semantic cache has no pending exact attempt");
    }
    return { attemptOrdinal: provenance.attemptOrdinal, authorityLineageDigest: raw.authority_lineage_digest,
      admissionState: "pending" };
  }
  if (!settled || successful.successKind !== "provider" || successful.attemptOrdinal !== provenance.attemptOrdinal ||
      successful.authorityLineageDigest !== raw.authority_lineage_digest ||
      successful.rawJsonSha256 !== raw.decoded_text_digest ||
      canonicalJson(successful.transportProvenance) !== canonicalJson(entry.transport_provenance)) {
    throw new AlayaError("CONFLICT", "typed source semantic cache differs from its ledger shard");
  }
  return { attemptOrdinal: provenance.attemptOrdinal, authorityLineageDigest: raw.authority_lineage_digest,
    admissionState: "admitted" };
}
