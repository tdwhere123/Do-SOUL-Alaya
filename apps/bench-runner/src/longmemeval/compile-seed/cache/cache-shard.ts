import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import {
  computeExtractionRawJsonSha256,
  inspectExtractionRawEnvelope,
  inspectExtractionRawJson
} from "../../extraction/content-closure.js";
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

export interface CachedExtractionEntry {
  readonly model: string;
  readonly request_profile: CompileSeedExtractionConfig["requestProfile"];
  readonly cache_key: string;
  readonly raw_json: string;
  readonly extracted_at: string;
  readonly response_metadata?: CachedExtractionResponseMetadata;
  readonly transport_provenance?: ExtractionTransportProvenance;
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
  };

export type CachedRawExtractionInspection =
  | {
      readonly status: "hit";
      readonly rawJson: string;
      readonly rawJsonSha256: string;
      readonly rawSignalCount: number;
    }
  | { readonly status: "missing"; readonly reason?: undefined }
  | { readonly status: "invalid"; readonly reason: string; readonly rawJsonSha256?: string };

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
  return inspectCachedContent(
    cached.entry.raw_json,
    cached.entry.response_metadata
  );
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
    inspectCachedResponseMetadata(cached.entry.response_metadata);
    return {
      status: "hit",
      rawJson: cached.entry.raw_json,
      ...inspectExtractionRawEnvelope(cached.entry.raw_json)
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "invalid", reason: `invalid cached raw extraction: ${reason}`, rawJsonSha256 };
  }
}

function readCachedEntry(
  cacheRoot: string,
  cacheKey: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  observer?: CachedExtractionInspectionObserver
): Readonly<{ status: "hit"; entry: CachedExtractionEntry }> |
  Extract<CachedExtractionInspection, { status: "missing" | "invalid" }> {
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  if (!existsSync(filePath)) return { status: "missing" };
  let parsed: Partial<CachedExtractionEntry>;
  try {
    observer?.onPhysicalRead?.();
    const serialized = readFileSync(filePath, "utf8");
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
  // invariant: same-filesystem rename exposes either the old complete shard
  // or the new complete shard, never an OOM-interrupted partial write.
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    renameSync(tmpPath, filePath);
  } catch (cause) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Cleanup must not conceal the authoritative persistence failure.
    }
    throw cause;
  }
}

function inspectCachedContent(
  rawJson: string,
  responseMetadata: CachedExtractionResponseMetadata | undefined
): CachedExtractionInspection {
  const rawJsonSha256 = computeExtractionRawJsonSha256(rawJson);
  try {
    const response = inspectCachedResponseMetadata(responseMetadata);
    return {
      status: "hit",
      rawJson,
      ...inspectExtractionRawJson(rawJson),
      ...response
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "invalid", reason: `invalid cached extraction: ${reason}`, rawJsonSha256 };
  }
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
  return parsed.cache_key === cacheKey ? null : "cache_key does not match fixture path";
}
