import { mkdirSync } from "node:fs";
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

const MAX_EXTRACTION_CACHE_SHARD_BYTES = 32 * 1024 * 1024;

export interface CachedExtractionAdmissionIdentity {
  readonly manifest_sha256: string;
  readonly raw_json_sha256: string;
}

export interface CachedExtractionEntry {
  readonly model: string;
  readonly request_profile: CompileSeedExtractionConfig["requestProfile"];
  readonly cache_key: string;
  readonly raw_json: string;
  readonly extracted_at: string;
  readonly empty_classification?: ExtractionEmptyClassification;
  readonly request_completion?: PersistedExtractionRequestCompletion;
  readonly response_metadata?: CachedExtractionResponseMetadata;
  readonly transport_provenance?: ExtractionTransportProvenance;
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
      readonly rawJson: string;
      readonly rawJsonSha256: string;
      readonly rawSignalCount: number;
      readonly transportProvenance?: ExtractionTransportProvenance;
    }
  | { readonly status: "missing"; readonly reason?: undefined }
  | { readonly status: "invalid"; readonly reason: string; readonly rawJsonSha256?: string }
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

export function inspectCachedExtraction(
  cacheRoot: string,
  cacheKey: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  observer?: CachedExtractionInspectionObserver
): CachedExtractionInspection {
  const cached = readCachedEntry(cacheRoot, cacheKey, model, requestProfile, observer);
  if (cached.status !== "hit") return cached;
  return inspectCachedExtractionContent(cached.entry);
}

export function inspectCachedRawExtraction(
  cacheRoot: string,
  cacheKey: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]
): CachedRawExtractionInspection {
  const cached = readCachedEntry(cacheRoot, cacheKey, model, requestProfile);
  if (cached.status !== "hit") return cached;
  const rawJsonSha256 = computeExtractionRawJsonSha256(cached.entry.raw_json);
  try {
    inspectCachedResponseMetadata(
      cached.entry.response_metadata,
      cached.entry.transport_provenance !== undefined
    );
    const envelope = inspectExtractionRawEnvelope(cached.entry.raw_json);
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
    return {
      status: "hit",
      rawJson: cached.entry.raw_json,
      ...(cached.entry.transport_provenance === undefined ? {} : {
        transportProvenance: cached.entry.transport_provenance
      }),
      ...envelope
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "invalid", reason: `invalid cached raw extraction: ${reason}`, rawJsonSha256 };
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
  return { status: "hit", entry: parsed as CachedExtractionEntry };
}

export function writeCachedExtraction(
  cacheRoot: string,
  cacheKey: string,
  entry: CachedExtractionEntry
): void {
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  mkdirSync(dirname(filePath), { recursive: true });
  replaceBytesDurable({
    destination: filePath,
    bytes: Buffer.from(`${JSON.stringify(entry, null, 2)}\n`, "utf8"),
    ownerIdentity: cacheKey,
    temporaryDirectory: dirname(filePath)
  });
}

export function inspectCachedExtractionContent(
  entry: Pick<CachedExtractionEntry, "raw_json" | "response_metadata" |
    "transport_provenance" | "empty_classification" | "request_completion">
): CachedExtractionInspection {
  const { raw_json: rawJson, response_metadata: responseMetadata,
    empty_classification: storedClassification, request_completion: requestCompletion } = entry;
  const providerBacked = entry.transport_provenance !== undefined;
  const rawJsonSha256 = computeExtractionRawJsonSha256(rawJson);
  try {
    const envelope = inspectExtractionRawJson(rawJson);
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

function isCachedExtractionAdmissionIdentity(
  value: unknown
): value is CachedExtractionAdmissionIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CachedExtractionAdmissionIdentity>;
  return typeof candidate.manifest_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.manifest_sha256) &&
    typeof candidate.raw_json_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.raw_json_sha256);
}
