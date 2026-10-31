import { AlayaError, SourceStatementRequestSchema, type SourceStatementRequest } from "@do-soul/alaya-protocol";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { inspectStatementResponse } from "../../extraction/source-statement-request.js";
import { computeCacheKey } from "./cache-key.js";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { inspectCachedSourcePacket, type CachedSourcePacket } from "../../extraction/cache/source-packet-artifact.js";
import { inspectCachedSourceSemantic, type CachedSourceSemantic } from "../../extraction/cache/source-semantic-artifact.js";
import type { ExtractionTypedArtifactMode } from "../../extraction/request-artifact.js";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  computeExtractionRawJsonSha256,
  inspectExtractionRawEnvelope,
  inspectExtractionRawJson
} from "../../extraction/content-closure.js";
import {
  classifyExtractionEnvelope,
  extractionEnvelopeCountsTowardCoverage,
  EXTRACTION_REQUEST_COMPLETION_VERSION,
  type PersistedExtractionRequestCompletion,
  type ExtractionEmptyClassification
} from "../../extraction/empty-classification.js";
import { replaceBytesDurable } from
  "../../extraction/fill/manifest/durable-exclusive-publication.js";
import type {
  BenchProviderResponseMetadata,
  BenchProviderUsage,
  CompileSeedExtractionConfig
} from "../compile-seed-types.js";
import {
  inspectCachedResponseMetadata,
  type CachedExtractionResponseMetadata
} from "./cached-response-metadata.js";
import {
  isExtractionTransportProvenance,
  type ExtractionTransportProvenance
} from "../../extraction/transport-route.js";
import {
  boundedArtifactEntryExists, readBoundedCanonicalUtf8Artifact
} from
  "../../extraction/cache-audit/bounded-artifact-reader.js";
import { inspectSettledProviderAttempt } from
  "../../extraction/authority/attempt-ledger/admission.js";
import { settledAttemptUsageDigest } from
  "../../extraction/authority/attempt-ledger/outcome.js";
import { transportResponseDigest } from
  "../../extraction/authority/attempt-ledger/outcome.js";
import type { GeminiBatchInvocation } from "../../extraction/fill/batch/contract.js";
import { readRetainedBatchLine } from "../../extraction/fill/batch/retained-line.js";
import { readRetainedBatchAuthority } from "../../extraction/fill/batch/retained-authority.js";
import {
  readExtractionCacheManifestIdentity, extractionAdmissionGenerationSha256,
  EXTRACTION_ADMISSION_GENERATION_STATEMENT, EXTRACTION_ADMISSION_GENERATION_WINDOWED,
  type ExtractionAdmissionGenerationContract, type ExtractionCacheManifest
} from "../../extraction/cache/extraction-cache-manifest.js";
import { buildExtractionTransportProvenance } from "../../extraction/transport-route.js";
import { inspectRetainedInteractiveResponses,
  type CachedProviderResponseWitness } from "./provider-response-witness.js";

export const MAX_EXTRACTION_CACHE_SHARD_BYTES = 32 * 1024 * 1024;
const HISTORICAL_NONEMPTY_REASON =
  "historical nonempty extraction has no current provider attempt authority";

export function retainedOnlyOrdinaryExtractionReason(
  entry: Pick<CachedExtractionEntry, "transport_provenance">,
  rawSignalCount: number
): string | undefined {
  return entry.transport_provenance === undefined && rawSignalCount > 0
    ? HISTORICAL_NONEMPTY_REASON : undefined;
}

export type CachedExtractionAdmissionIdentity = NonNullable<
  import("@do-soul/alaya-protocol").PublishedSourceInterpretationPacket["provenance"]["cache_admission"]
> & { readonly contract?: typeof EXTRACTION_ADMISSION_GENERATION_STATEMENT };

export interface CachedExtractionEntry {
  readonly source_statement?: Readonly<{ request: SourceStatementRequest;
    receipt: ReturnType<typeof inspectStatementResponse>["receipt"] }>;
  readonly source_packet?: CachedSourcePacket;
  readonly source_semantic?: CachedSourceSemantic;
  readonly model: string;
  readonly request_profile: CompileSeedExtractionConfig["requestProfile"];
  readonly cache_key: string;
  readonly raw_json: string;
  readonly extracted_at: string;
  readonly empty_classification?: ExtractionEmptyClassification;
  readonly request_completion?: PersistedExtractionRequestCompletion;
  readonly response_metadata?: CachedExtractionResponseMetadata;
  readonly transport_provenance?: ExtractionTransportProvenance;
  readonly provider_attempt?: Readonly<{ attempt_ordinal: number; authority_lineage_digest: string;
    kind?: "gemini_batch" | "interactive"; last_usage?: BenchProviderUsage | null }>;
  readonly provider_batch?: Readonly<{ plan_identity: string; authority_receipt_digest: string;
    result: Parameters<GeminiBatchInvocation["importLine"]>[0] }>;
  readonly request_identity?: Readonly<{ system_prompt: string; user_prompt: string }>;
  readonly provider_responses?: readonly CachedProviderResponseWitness[];
  readonly admission_identity?: CachedExtractionAdmissionIdentity;
}

export type CachedExtractionInspection =
  | {
    readonly status: "hit";
    readonly rawJson: string;
    readonly rawJsonSha256: string;
    readonly rawSignalCount: number;
    readonly parsedDraftCount: number;
    readonly responseMetadata?: BenchProviderResponseMetadata;
    readonly usage?: BenchProviderUsage;
  }
  | { readonly status: "missing"; readonly reason?: undefined }
  | { readonly status: "pending"; readonly reason: string; readonly rawJson?: string;
      readonly rawJsonSha256?: string; readonly rawSignalCount?: number;
      readonly transportProvenance?: ExtractionTransportProvenance;
      readonly attemptOrdinal?: number; readonly authorityLineageDigest?: string;
      readonly usageSha256?: string; readonly responseSha256?: string;
      readonly aggregateUsageSha256?: string }
  | { readonly status: "retired"; readonly eligibility: "retained_only"; readonly reason: string; readonly rawJsonSha256?: undefined }
  | {
    readonly status: "invalid";
    readonly reason: string;
    readonly rawJsonSha256?: string;
  }
  | {
    readonly status: "quarantined";
    readonly reason: string;
    readonly rawJson: string;
    readonly rawJsonSha256: string;
  };

export type CachedRawExtractionInspection =
  | {
      readonly status: "hit";
      readonly deterministicEmpty?: boolean;
      readonly rawJson: string;
      readonly rawJsonSha256: string;
      readonly rawSignalCount: number;
      readonly transportProvenance?: ExtractionTransportProvenance;
      readonly attemptOrdinal?: number;
      readonly authorityLineageDigest?: string;
      readonly usageSha256?: string;
      readonly responseSha256?: string;
      readonly aggregateUsageSha256?: string;
    }
  | { readonly status: "missing"; readonly reason?: undefined }
  | { readonly status: "pending"; readonly reason: string; readonly rawJson?: string;
      readonly rawJsonSha256?: string; readonly rawSignalCount?: number;
      readonly transportProvenance?: ExtractionTransportProvenance;
      readonly attemptOrdinal?: number; readonly authorityLineageDigest?: string;
      readonly usageSha256?: string; readonly responseSha256?: string;
      readonly aggregateUsageSha256?: string }
  | { readonly status: "invalid"; readonly reason: string; readonly rawJsonSha256?: string }
  | { readonly status: "retired"; readonly eligibility: "retained_only"; readonly reason: string }
  | {
      readonly status: "quarantined";
      readonly reason: string;
      readonly rawJson: string;
      readonly rawJsonSha256: string;
      readonly rawSignalCount: number;
    };

export interface CachedExtractionInspectionObserver {
  readonly onPhysicalRead?: () => void;
  readonly onParseMiss?: () => void;
}

export function cacheFilePath(cacheRoot: string, cacheKey: string): string {
  return join(cacheRoot, cacheKey.slice(0, 2), `${cacheKey}.json`);
}

export function listExtractionCacheShardKeys(cacheRoot: string): readonly string[] {
  const keys: string[] = [];
  for (const prefix of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!/^[0-9a-f]{2}$/u.test(prefix.name)) continue;
    if (!prefix.isDirectory() || prefix.isSymbolicLink()) {
      throw new AlayaError("CONFLICT", `extraction cache shard prefix ${prefix.name} is not a directory`);
    }
    for (const entry of readdirSync(join(cacheRoot, prefix.name), { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      const match = /^([0-9a-f]{64})\.json$/u.exec(entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || match === null ||
          !match[1]!.startsWith(prefix.name)) {
        throw new AlayaError("CONFLICT", `extraction cache shard name ${entry.name} is not a fixture path`);
      }
      keys.push(match[1]!);
    }
  }
  return keys;
}

export function inspectCachedExtraction(
  cacheRoot: string,
  cacheKey: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  observer?: CachedExtractionInspectionObserver
): CachedExtractionInspection {
  const cached = readCachedEntry(cacheRoot, cacheKey, model, requestProfile, observer);
  if (cached.status !== "hit") return cached;
  if (cached.entry.source_packet !== undefined || cached.entry.source_semantic !== undefined) {
    return { status: "invalid", reason: "typed source interpretation is not a signal cache shard" };
  }
  const raw = inspectCachedRawExtraction(cacheRoot, cacheKey, model, requestProfile);
  if (raw.status !== "hit") return raw;
  return inspectCachedExtractionContent(cached.entry);
}

/** Governance inventory can explicitly select typed packets without exposing them to signal consumers. */
export function inspectCachedExtractionArtifact(cacheRoot: string, cacheKey: string, model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"], typed?: ExtractionTypedArtifactMode): CachedExtractionInspection {
  if (typed === "open_semantics") return inspectCachedSourceSemantic(cacheRoot, cacheKey, model, requestProfile);
  if (typed === "source_packet") return inspectCachedSourcePacket(cacheRoot, cacheKey, model, requestProfile);
  return inspectCachedExtraction(cacheRoot, cacheKey, model, requestProfile);
}

export function inspectCachedRawExtraction(
  cacheRoot: string,
  cacheKey: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]
): CachedRawExtractionInspection {
  return inspectRawExtraction(cacheRoot, cacheKey, model, requestProfile, true);
}

/** Ledger reconciliation inspects staged bytes before the ledger can admit them. */
export function inspectUnadmittedRawExtraction(
  cacheRoot: string, cacheKey: string, model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]
): CachedRawExtractionInspection {
  return inspectRawExtraction(cacheRoot, cacheKey, model, requestProfile, false);
}

function inspectRawExtraction(
  cacheRoot: string, cacheKey: string, model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"], requireAdmission: boolean
): CachedRawExtractionInspection {
  const cached = readCachedEntry(cacheRoot, cacheKey, model, requestProfile);
  if (cached.status !== "hit") return cached;
  if (cached.entry.source_semantic !== undefined) {
    const inspected = inspectCachedSourceSemantic(cacheRoot, cacheKey, model, requestProfile, requireAdmission);
    if (inspected.status === "retired") return { status: "quarantined", reason: inspected.reason,
      rawJson: cached.entry.raw_json, rawJsonSha256: computeExtractionRawJsonSha256(cached.entry.raw_json),
      rawSignalCount: 0 };
    return (inspected.status === "hit" || inspected.status === "pending") && inspected.transportProvenance !== undefined
      ? { ...inspected, usageSha256: settledAttemptUsageDigest(inspected.usage) } : inspected;
  }
  if (cached.entry.source_packet !== undefined) {
    const inspected = inspectCachedSourcePacket(cacheRoot, cacheKey, model, requestProfile, requireAdmission);
    return (inspected.status === "hit" || inspected.status === "pending") && inspected.transportProvenance !== undefined
      ? { ...inspected, usageSha256: settledAttemptUsageDigest(inspected.usage) } : inspected;
  }
  const rawJsonSha256 = computeExtractionRawJsonSha256(cached.entry.raw_json);
  try {
    if (cached.entry.source_statement !== undefined) {
      assertStatementAdmissionGeneration(
        readExtractionCacheManifestIdentity(cacheRoot)?.manifest,
        cached.entry.admission_identity, cacheKey, rawJsonSha256
      );
    }
    const attempt = cached.entry.provider_attempt;
    if (attempt !== undefined && (!Number.isSafeInteger(attempt.attempt_ordinal) ||
        attempt.attempt_ordinal < 1 || !/^[a-f0-9]{64}$/u.test(attempt.authority_lineage_digest) ||
        cached.entry.transport_provenance === undefined ||
        attempt.kind !== undefined && attempt.kind !== "gemini_batch" && attempt.kind !== "interactive")) {
      throw new AlayaError("CONFLICT", "invalid provider attempt binding");
    }
    if (cached.entry.transport_provenance !== undefined &&
        (attempt?.kind === undefined ||
         (attempt.kind === "gemini_batch") !== (cached.entry.provider_batch !== undefined))) {
      throw new AlayaError("CONFLICT", "provider attempt transport mode is unbound");
    }
    inspectCachedResponseMetadata(
      cached.entry.response_metadata,
      cached.entry.transport_provenance !== undefined
    );
    if (cached.entry.provider_batch !== undefined) {
      const batch = cached.entry.provider_batch;
      const retained = readRetainedBatchLine(cacheRoot, batch.plan_identity, cacheKey);
      const authority = readRetainedBatchAuthority(cacheRoot, batch.plan_identity, batch.authority_receipt_digest);
      const transport = authority.observation.transport!;
      if (canonicalJson(batch.result) !== canonicalJson(retained.result) ||
          batch.result.rawJson !== cached.entry.raw_json ||
          batch.result.provenance.attemptOrdinal !== attempt?.attempt_ordinal ||
          authority.lineage_digest !== attempt?.authority_lineage_digest ||
          retained.plan.model !== model || retained.plan.requestProfile !== requestProfile ||
          retained.plan.lines.find((line) => line.key === cacheKey) === undefined ||
          canonicalJson(cached.entry.transport_provenance) !== canonicalJson(
            buildExtractionTransportProvenance(transport)) ||
          settledAttemptUsageDigest(batch.result.provenance.usage) !==
            settledAttemptUsageDigest(inspectCachedResponseMetadata(cached.entry.response_metadata, true).usage)) {
        throw new AlayaError("CONFLICT", "ordinary Batch retained request/response transport binding mismatch");
      }
    } else if (attempt?.kind === "interactive") {
      const quarantine = inspectInteractiveResponseWitness(cached.entry,
        cacheKey, model, requestProfile, attempt.attempt_ordinal, rawJsonSha256);
      if (quarantine !== undefined) return quarantine;
    }
    const envelope = inspectExtractionRawEnvelope(cached.entry.raw_json, statementClassificationContext(cached.entry));
    const classification = resolveStoredEmptyClassification(
      envelope.rawSignalCount,
      cached.entry.transport_provenance !== undefined,
      cached.entry.empty_classification,
      cached.entry.request_completion
    );
    if (!extractionEnvelopeCountsTowardCoverage(classification)) {
      return {
        status: "quarantined",
        reason: `${classification} is not a coverage-valid extraction shard`,
        rawJson: cached.entry.raw_json,
        rawJsonSha256,
        rawSignalCount: envelope.rawSignalCount
      };
    }
    const retiredReason = retainedOnlyOrdinaryExtractionReason(cached.entry, envelope.rawSignalCount);
    if (requireAdmission && retiredReason !== undefined) {
      return { status: "retired", eligibility: "retained_only", reason: retiredReason };
    }
    if (requireAdmission && cached.entry.transport_provenance !== undefined) {
      if (attempt === undefined) return { status: "invalid", reason: "provider attempt binding is missing", rawJsonSha256 };
      const response = inspectCachedResponseMetadata(cached.entry.response_metadata, true);
      const admission = inspectSettledProviderAttempt({ cacheRoot, cacheKey, model, requestProfile,
        rawJsonSha256, transportProvenance: cached.entry.transport_provenance,
        attemptOrdinal: attempt.attempt_ordinal,
        authorityLineageDigest: attempt.authority_lineage_digest,
        ...(attempt.kind === "interactive" ? { responses: cached.entry.provider_responses } : {}),
        ...(attempt.kind === "interactive" ? { aggregateUsage: response.usage } : {}),
        ...((attempt.last_usage ?? undefined) === undefined ?
          (attempt.last_usage === null ? {} : response.usage === undefined ? {} : { usage: response.usage }) :
          { usage: attempt.last_usage! }) });
      if (admission.status === "pending") return { status: "pending", reason: admission.reason!,
        rawJson: cached.entry.raw_json, rawJsonSha256, rawSignalCount: envelope.rawSignalCount,
        transportProvenance: cached.entry.transport_provenance,
        attemptOrdinal: attempt.attempt_ordinal,
        authorityLineageDigest: attempt.authority_lineage_digest };
      if (admission.status === "invalid") return { status: "invalid", reason: admission.reason!, rawJsonSha256 };
    }
    return {
      status: "hit",
      rawJson: cached.entry.raw_json,
      ...(cached.entry.transport_provenance === undefined ? {} : {
        transportProvenance: cached.entry.transport_provenance
      }),
      ...(attempt === undefined ? {} : {
        attemptOrdinal: attempt.attempt_ordinal,
        authorityLineageDigest: attempt.authority_lineage_digest,
        usageSha256: settledAttemptUsageDigest(attempt.last_usage === undefined ?
          inspectCachedResponseMetadata(cached.entry.response_metadata, true).usage : attempt.last_usage),
        ...(attempt.kind === "interactive" && cached.entry.provider_responses?.at(-1) !== undefined ?
          { responseSha256: transportResponseDigest(cached.entry.provider_responses.at(-1)!.witness),
            aggregateUsageSha256: settledAttemptUsageDigest(
              inspectCachedResponseMetadata(cached.entry.response_metadata, true).usage) } : {})
      }),
      ...envelope
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "invalid", reason: `invalid cached raw extraction: ${reason}`, rawJsonSha256 };
  }
}

function inspectInteractiveResponseWitness(
  entry: CachedExtractionEntry, cacheKey: string, model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  attemptOrdinal: number, rawJsonSha256: string
): Extract<CachedRawExtractionInspection, { status: "quarantined" }> | undefined {
  try {
    inspectRetainedInteractiveResponses({ cacheKey, model, requestProfile,
      rawJson: entry.raw_json, attemptOrdinal,
      requestIdentity: entry.request_identity, responses: entry.provider_responses,
      responseMetadata: entry.response_metadata });
  } catch (error) {
    const envelope = inspectExtractionRawEnvelope(entry.raw_json, statementClassificationContext(entry));
    return { status: "quarantined",
      reason: error instanceof Error ? error.message : String(error),
      rawJson: entry.raw_json, rawJsonSha256,
      rawSignalCount: envelope.rawSignalCount };
  }
}

export function readCachedEntry(
  cacheRoot: string,
  cacheKey: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  observer?: CachedExtractionInspectionObserver
): Readonly<{ status: "hit"; entry: CachedExtractionEntry }> |
  Extract<CachedExtractionInspection, { status: "missing" | "invalid" }> {
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  if (!boundedArtifactEntryExists(filePath)) return { status: "missing" };
  let parsed: Partial<CachedExtractionEntry>;
  try {
    observer?.onPhysicalRead?.();
    const serialized = readBoundedCanonicalUtf8Artifact({
      path: filePath,
      maxBytes: MAX_EXTRACTION_CACHE_SHARD_BYTES,
      label: `cache shard ${cacheKey}`
    });
    observer?.onParseMiss?.();
    parsed = JSON.parse(serialized) as Partial<CachedExtractionEntry>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "invalid", reason: `invalid cache shard JSON: ${reason}` };
  }
  const identityError = inspectCachedIdentity(parsed, cacheKey, model, requestProfile);
  if (identityError !== null) return { status: "invalid", reason: identityError };
  const entry = parsed as CachedExtractionEntry;
  const statementError = inspectStatementCacheReceipt(entry);
  // A known request with invalid response bytes remains unavailable, but its exact
  // digest must reach the bounded repair owner. Identity failures above cannot.
  if (statementError !== null) return { status: "invalid", reason: statementError,
    rawJsonSha256: computeExtractionRawJsonSha256(entry.raw_json) };
  return { status: "hit", entry };
}

export function writeCachedExtraction(
  cacheRoot: string,
  cacheKey: string,
  entry: CachedExtractionEntry
): void {
  const bytes = Buffer.from(`${JSON.stringify(entry, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_EXTRACTION_CACHE_SHARD_BYTES) {
    throw new AlayaError("VALIDATION", "typed packet shard exceeds reader byte bound");
  }
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  mkdirSync(dirname(filePath), { recursive: true });
  replaceBytesDurable({
    destination: filePath,
    bytes,
    ownerIdentity: cacheKey,
    temporaryDirectory: dirname(filePath)
  });
}

export function inspectCachedExtractionContent(
  entry: Pick<CachedExtractionEntry, "raw_json" | "response_metadata" |
    "transport_provenance" | "empty_classification" | "request_completion" | "source_packet" | "source_semantic" | "source_statement">
): Exclude<CachedExtractionInspection, { status: "retired" }> {
  if (entry.source_packet !== undefined || entry.source_semantic !== undefined) {
    return { status: "invalid", reason: "typed source interpretation is not a signal cache shard" };
  }
  const { raw_json: rawJson, response_metadata: responseMetadata,
    empty_classification: storedClassification, request_completion: requestCompletion } = entry;
  const providerBacked = entry.transport_provenance !== undefined;
  const rawJsonSha256 = computeExtractionRawJsonSha256(rawJson);
  try {
    const envelope = inspectExtractionRawJson(rawJson, statementClassificationContext(entry));
    const classification = resolveStoredEmptyClassification(
      envelope.rawSignalCount,
      providerBacked,
      storedClassification,
      requestCompletion
    );
    if (!extractionEnvelopeCountsTowardCoverage(classification)) {
      return {
        status: "quarantined",
        reason: `${classification} is not a coverage-valid extraction shard`,
        rawJson,
        rawJsonSha256
      };
    }
    const response = inspectCachedResponseMetadata(responseMetadata, providerBacked);
    return {
      status: "hit",
      rawJson,
      ...envelope,
      ...response
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "invalid", reason: `invalid cached extraction: ${reason}`, rawJsonSha256 };
  }
}

function statementClassificationContext(entry: Pick<CachedExtractionEntry, "source_statement" | "request_completion">) {
  const statement = entry.source_statement;
  return statement === undefined ? undefined : { sourceAssertionCount: statement.request.messages.length,
    sourceStatementRequest: statement.request, planMembership: "in_plan" as const,
    requestCompletion: entry.request_completion?.status };
}

function resolveStoredEmptyClassification(
  rawSignalCount: number,
  providerBacked: boolean,
  storedClassification: ExtractionEmptyClassification | undefined,
  requestCompletion: PersistedExtractionRequestCompletion | undefined
): ExtractionEmptyClassification {
  if (requestCompletion !== undefined &&
      (requestCompletion.version !== EXTRACTION_REQUEST_COMPLETION_VERSION ||
       requestCompletion.status !== storedClassification || !providerBacked ||
       (requestCompletion.status !== "completed_empty" && requestCompletion.status !== "completed_signals"))) {
    throw new Error("stored request completion binding is invalid");
  }
  if (storedClassification === "completed_empty" &&
      (!providerBacked || requestCompletion?.status !== "completed_empty")) {
    throw new Error("completed empty lacks provider-backed request completion");
  }
  if ((storedClassification === "completed_signals" && rawSignalCount === 0) ||
      (storedClassification === "completed_empty" && rawSignalCount !== 0) ||
      (storedClassification === "deterministic_empty" && (rawSignalCount !== 0 || providerBacked))) {
    throw new Error("stored extraction classification contradicts its response");
  }
  if (storedClassification === undefined && rawSignalCount === 0) return "unclassified_empty";
  return storedClassification ?? classifyExtractionEnvelope({
    rawSignalCount,
    sourceAssertionCount: providerBacked && rawSignalCount === 0 ? 1 : 0,
    planMembership: "in_plan"
  });
}

function inspectCachedIdentity(
  parsed: Partial<CachedExtractionEntry>,
  cacheKey: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]
): string | null {
  if (typeof parsed.raw_json !== "string") return "raw_json must be a string";
  if (parsed.source_statement !== undefined) {
    try {
      const request = SourceStatementRequestSchema.parse(parsed.source_statement.request);
      const expectedKey = computeCacheKey(model, requestProfile, SOURCE_STATEMENTS_PROMPT, JSON.stringify(request));
      if (expectedKey !== cacheKey) return "statement request key differs";
    } catch { return "invalid statement cache descriptor"; }
  } else {
    try {
      const envelope = JSON.parse(parsed.raw_json);
      if ("messages" in envelope && !Array.isArray(envelope.interpretations) && !Array.isArray(envelope.signals)) {
        return "statement response lacks request-bound receipt";
      }
    } catch { /* Raw parser reports malformed bytes. */ }
  }
  if (parsed.model !== model) return `model ${String(parsed.model)} != ${model}`;
  if (parsed.request_profile !== requestProfile) {
    return `request_profile ${String(parsed.request_profile)} != ${requestProfile}`;
  }
  if (parsed.transport_provenance !== undefined &&
      !isExtractionTransportProvenance(parsed.transport_provenance)) {
    return "transport_provenance is invalid";
  }
  if (parsed.admission_identity !== undefined &&
      !isCachedExtractionAdmissionIdentity(parsed.admission_identity)) {
    return "admission_identity is invalid";
  }
  return parsed.cache_key === cacheKey ? null : "cache_key does not match fixture path";
}

function assertStatementAdmissionGeneration(
  manifest: ExtractionCacheManifest | undefined,
  identity: CachedExtractionAdmissionIdentity | undefined,
  cacheKey: string,
  rawJsonSha256: string
): void {
  if (manifest === undefined || identity === undefined ||
      identity.request_key !== cacheKey || identity.raw_json_sha256 !== rawJsonSha256) {
    throw new AlayaError("CONFLICT", "statement cache admission generation binding mismatch");
  }
  const contract: ExtractionAdmissionGenerationContract = identity.contract ??
    EXTRACTION_ADMISSION_GENERATION_WINDOWED;
  if (identity.generation_sha256 !== extractionAdmissionGenerationSha256(manifest, contract)) {
    throw new AlayaError("CONFLICT", "statement cache admission generation binding mismatch");
  }
}

function inspectStatementCacheReceipt(entry: CachedExtractionEntry): string | null {
  if (entry.source_statement === undefined) return null;
  try {
    const inspected = inspectStatementResponse(entry.source_statement.request, entry.raw_json);
    if (canonicalJson(inspected.receipt) !== canonicalJson(entry.source_statement.receipt) ||
        inspected.status === "unclassified_empty" || inspected.status !== entry.empty_classification) {
      return "statement receipt or completion binding differs";
    }
    return null;
  } catch { return "invalid statement cache receipt"; }
}

function isCachedExtractionAdmissionIdentity(
  value: unknown
): value is CachedExtractionAdmissionIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CachedExtractionAdmissionIdentity>;
  return typeof candidate.generation_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.generation_sha256) &&
    typeof candidate.request_key === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.request_key) &&
    typeof candidate.raw_json_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.raw_json_sha256) &&
    (candidate.contract === undefined || candidate.contract === EXTRACTION_ADMISSION_GENERATION_STATEMENT);
}
