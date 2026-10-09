import { interactiveSourceTransportBinding } from "../request-profile.js";
import {
  isChatSemanticRequestProfile, AlayaError, canonicalJson, DEFAULT_EXTRACTION_SOURCE_PACKING
} from "@do-soul/alaya-protocol";
import type { CachedExtractionEntry } from "../../compile-seed/cache/cache-shard.js";
import { inspectCachedResponseMetadata, persistedResponseMetadata } from "../../compile-seed/cache/cached-response-metadata.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import { isCompleteSemanticFinish } from "../../compile-seed/http/semantic-provider-http.js";
import { inspectExtractionAttemptLedger } from "../authority/attempt-ledger.js";
import { baseReportedUsage } from "../authority/step-quote.js";
import { computeExtractionRawJsonSha256 } from "../content-closure.js";
import { bindProviderRawAttempt, readSingleSourceRawAttempt, providerRawSuccessEvidenceState, readProviderRawAttempt,
  verifyProviderRawReservation } from "../fill/provider-raw-attempt.js";
import { readRetainedInteractiveAuthority } from "../fill/retained-interactive-authority.js";
import { sourceSemanticInteractiveWireSha256, sourceSemanticRequestWireDigest } from
  "../fill/source-semantic-interactive-request.js";
import { assertExtractionAuthorityKeyInScope } from "../authority/receipt/scope.js";
import { buildExtractionTransportProvenance, isExtractionTransportProvenance } from "../transport-route.js";
import { computeSystemPromptSha256, readRetainedSourceSemanticManifestIdentity } from "./extraction-cache-manifest.js";
import type { CachedSourceSemantic, InteractiveSemanticProvenance } from "./source-semantic-artifact.js";
import type { SourceSemanticInteractivePreflight } from "../fill/source-semantic-interactive-preflight.js";
import { assertInteractiveSourcePreflightReceipt } from "../authority/source-preflight-binding.js";
import type { SourceRequestLine } from "../request-artifact.js";
import { parseExtractionOpenSemanticsGeneration } from "../request-artifact.js";

/** A complete rejected response is still a physical parent, while its rejection stays settled. */
export function readCompleteRetainedSourceResponse(input: Readonly<{
  cacheRoot: string; preflight: SourceSemanticInteractivePreflight; line: SourceRequestLine;
}>): string {
  const { cacheRoot, preflight, line } = input;
  const planned = preflight.planned_requests.find(row => row.key === line.key);
  if (planned === undefined || !preflight.ready_requests.some(row => canonicalJson(row) === canonicalJson(line))) {
    throw new AlayaError("CONFLICT", "source revision parent is outside its selected physical preparation");
  }
  const raw = readSingleSourceRawAttempt(cacheRoot, line.key);
  if (raw === undefined) throw new AlayaError("CONFLICT", "source revision requires one retained physical response for this request");
  if (raw.kind !== "source_semantic" || raw.authority_receipt_digest === undefined ||
      raw.authority_lineage_digest === undefined) {
    throw new AlayaError("CONFLICT", "source revision parent has no retained source authority");
  }
  const receipt = readRetainedInteractiveAuthority(cacheRoot, raw.authority_receipt_digest,
    raw.authority_lineage_digest);
  assertInteractiveSourcePreflightReceipt(preflight, receipt);
  assertExtractionAuthorityKeyInScope(receipt, line.key);
  bindProviderRawAttempt(raw, { kind: "source_semantic", cacheKey: line.key,
    model: preflight.config.model, requestProfile: preflight.config.requestProfile,
    requestDigest: planned.request_digest, authorityReceiptDigest: receipt.receipt_digest,
    authorityLineageDigest: receipt.lineage_digest, sourceRequestSha256: line.requestSha256 });
  const ledger = inspectExtractionAttemptLedger({ cacheRoot, lineageDigest: receipt.lineage_digest,
    cacheIdentity: { model: preflight.config.model, requestProfile: preflight.config.requestProfile } });
  // A complete quarantined response can parent a revision, but it still needs
  // the same exact settlement witness as an admitted executable response.
  if (verifyProviderRawReservation(raw, ledger, "executable", receipt.limits.max_output_tokens) === "accounting_invalid") {
    throw new AlayaError("CONFLICT", "source revision parent has invalid accounting");
  }
  if (!ledger?.historyComplete || !ledger.settledAttempts.some(row =>
      row.cacheKey === line.key && row.attemptOrdinal === raw.attempt_ordinal) ||
      raw.transport_failure !== undefined || !raw.full_replay_possible ||
      providerRawSuccessEvidenceState(raw) !== "bound" ||
      !isCompleteSemanticFinish(preflight.config.requestProfile, raw.finish_reason)) {
    throw new AlayaError("CONFLICT", "source revision parent has no complete settled physical response");
  }
  return raw.decoded_text;
}

/** One complete physical response may serve a new verified occurrence only when its full wire is unchanged. */
export function readCompletePhysicalSourceResponseForRequest(input: Readonly<{
  cacheRoot: string; physicalPreflight: SourceSemanticInteractivePreflight;
  currentLine: SourceRequestLine; currentPreflight?: SourceSemanticInteractivePreflight;
}>): string {
  const { cacheRoot, physicalPreflight, currentLine, currentPreflight } = input;
  const physicalLine = physicalPreflight.ready_requests.find(row => row.key === currentLine.key);
  const physicalPlanned = physicalPreflight.planned_requests.find(row => row.key === currentLine.key);
  if (physicalLine === undefined || physicalPlanned === undefined ||
      physicalLine.requestSha256 !== currentLine.requestSha256 ||
      physicalLine.systemPrompt !== currentLine.systemPrompt ||
      physicalLine.userPrompt !== currentLine.userPrompt) {
    throw new AlayaError("CONFLICT", "current source request differs from its complete physical parent");
  }
  if (currentPreflight !== undefined) {
    const currentReady = currentPreflight.ready_requests.find(row => row.key === currentLine.key);
    const physicalWire = sourceSemanticInteractiveWireSha256({ ...physicalPreflight.config,
      openSemantics: parseExtractionOpenSemanticsGeneration(physicalPreflight.config.openSemantics) }, physicalLine,
      physicalPreflight.max_output_tokens);
    const currentWire = sourceSemanticInteractiveWireSha256({ ...currentPreflight.config,
      openSemantics: parseExtractionOpenSemanticsGeneration(currentPreflight.config.openSemantics) }, currentLine,
      currentPreflight.max_output_tokens);
    if (canonicalJson(currentReady) !== canonicalJson(currentLine) ||
        currentPreflight.config.model !== physicalPreflight.config.model ||
        currentPreflight.config.requestProfile !== physicalPreflight.config.requestProfile ||
        physicalWire !== currentWire ||
        (physicalPlanned.wire_sha256 !== undefined && physicalPlanned.wire_sha256 !== physicalWire)) {
      throw new AlayaError("CONFLICT", "current source transport wire differs from its physical parent");
    }
  }
  return readCompleteRetainedSourceResponse({ cacheRoot, preflight: physicalPreflight, line: physicalLine });
}

export function assertInteractiveProvenance(provenance: InteractiveSemanticProvenance, requestProfile: string): void {
  const transport = interactiveSourceTransportBinding(requestProfile).transport;
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
  typed: Extract<CachedSourceSemantic, { kind: "gemini_generate_content" | "step_chat_completion" | "intern_chat_completion" }>,
  entry: CachedExtractionEntry,
  cacheRoot: string,
  retainedOnly = false
): { readonly attemptOrdinal: number; readonly authorityLineageDigest: string;
  readonly admissionState: "pending" | "admitted"; readonly requestBinding: "verified" | "unbound";
  readonly historyComplete: boolean } {
  if (typed.kind !== interactiveSourceTransportBinding(entry.request_profile).kind) {
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
  assertExtractionAuthorityKeyInScope(receipt, entry.cache_key);
  const transport = receipt.observation.transport!;
  const logical = receipt.observation.extraction;
  const dataset = receipt.observation.dataset;
  const manifest = readRetainedSourceSemanticManifestIdentity(cacheRoot);
  const requestConfig: CompileSeedExtractionConfig = {
    model: entry.model, requestProfile: entry.request_profile,
    providerUrl: logical.providerUrl, transportProviderUrl: transport.providerUrl,
    transportModel: transport.model, apiKey: null
  };
  // Retired native chat schema bytes have no independent wire witness here. Preserve
  // their accounting, but never classify an unchecked digest as verified.
  const requestBinding = retainedOnly && isChatSemanticRequestProfile(entry.request_profile) ? "unbound" : "verified";
  const requestDigestMatches = requestBinding === "unbound" ||
    raw.request_digest === sourceSemanticRequestWireDigest(requestConfig, line, receipt.limits.max_output_tokens);
  if (manifest?.providerUrl !== logical.providerUrl ||
      manifest.extractionModel !== logical.model || manifest.modelFamily !== logical.modelFamily ||
      manifest.requestProfile !== logical.requestProfile ||
      manifest.sourcePacking !== (logical.sourcePacking ?? DEFAULT_EXTRACTION_SOURCE_PACKING) ||
      manifest.cacheKeyAlgorithm !== logical.cacheKeyAlgorithm ||
      manifest.dataset !== dataset.variant.replace(/_/u, "-") ||
      manifest.datasetRevision !== dataset.revisionSha256 ||
      manifest.windowOffset !== dataset.windowOffset || manifest.windowLimit !== dataset.windowLimit ||
      manifest.expectedTurns !== receipt.observation.inventory.expectedTurns ||
      manifest.expectedKeySetSha256 !== dataset.expectedKeySetSha256 ||
      manifest.systemPromptSha256 !== logical.systemPromptSha256 ||
      computeSystemPromptSha256(line.systemPrompt) !== logical.systemPromptSha256 ||
      logical.model !== entry.model || logical.requestProfile !== entry.request_profile ||
      raw.model !== entry.model || raw.request_profile !== entry.request_profile ||
      raw.source_request_sha256 !== computeExtractionRawJsonSha256(line.userPrompt) ||
      line.requestSha256 !== raw.source_request_sha256 ||
      !requestDigestMatches ||
      canonicalJson(entry.transport_provenance) !== canonicalJson(buildExtractionTransportProvenance(transport)) ||
      !raw.full_replay_possible || raw.transport_failure !== undefined ||
      providerRawSuccessEvidenceState(raw) !== "bound" ||
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
      verifyProviderRawReservation(raw, ledger, requestBinding === "unbound" ? "accounting" : "executable",
        receipt.limits.max_output_tokens) !== undefined) {
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
      admissionState: "pending", requestBinding, historyComplete: ledger.historyComplete };
  }
  if (!settled || successful.successKind !== "provider" || successful.attemptOrdinal !== provenance.attemptOrdinal ||
      successful.authorityLineageDigest !== raw.authority_lineage_digest ||
      successful.rawJsonSha256 !== raw.decoded_text_digest ||
      canonicalJson(successful.transportProvenance) !== canonicalJson(entry.transport_provenance)) {
    throw new AlayaError("CONFLICT", "typed source semantic cache differs from its ledger shard");
  }
  return { attemptOrdinal: provenance.attemptOrdinal, authorityLineageDigest: raw.authority_lineage_digest,
    admissionState: "admitted", requestBinding, historyComplete: ledger.historyComplete };
}
