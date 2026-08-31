import { inspectCachedRawExtraction } from "../compile-seed/cache/cache-shard.js";
import {
  EXTRACTION_REQUEST_PROFILES,
  type ExtractionRequestProfile
} from "../extraction/request-profile.js";
import { DiagnosticLoopFailure } from "./failures.js";
import {
  diagnosticAuthorityDigest,
  resolveExtractionCacheIdentity
} from "./authority/identity.js";
import type { DiagnosticLoopPhaseResult, DiagnosticLoopRequest } from "./types.js";

export function proveCacheOnlyExtraction(
  request: DiagnosticLoopRequest,
  network?: () => void
): DiagnosticLoopPhaseResult {
  if (request.extractionCacheRoot === undefined) {
    throw new DiagnosticLoopFailure({
      phase: "extraction",
      classification: "authority",
      message: "cache-only extraction requires --extraction-cache-root",
      resumeCommand: ""
    });
  }
  const profile = parseRequestProfile(request.requestProfile);
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const key of request.requestedKeys) {
    const inspected = inspectCachedRawExtraction(
      request.extractionCacheRoot, key, request.model, profile
    );
    if (inspected.status === "missing") missing.push(key);
    if (inspected.status === "invalid") invalid.push(`${key}: ${inspected.reason}`);
  }
  if (network !== undefined) {
    throw new DiagnosticLoopFailure({
      phase: "extraction",
      classification: "infrastructure",
      message: "cache-only proof must not receive a network adapter",
      resumeCommand: ""
    });
  }
  if (missing.length > 0 || invalid.length > 0) {
    throw new DiagnosticLoopFailure({
      phase: "extraction",
      classification: "authority",
      message: formatCacheOnlyMiss(missing, invalid),
      resumeCommand: ""
    });
  }
  const authority = resolveExtractionCacheIdentity(request);
  return {
    contentIdentity: diagnosticAuthorityDigest(authority),
    physicalCalls: 0,
    artifactPaths: { cacheRoot: request.extractionCacheRoot },
    details: {
      cache_mode: "cache_only",
      key_count: request.requestedKeys.length,
      extraction_cache_identity: diagnosticAuthorityDigest(authority),
      extraction_cache_authority: authority
    },
    avoidedWork: { providerCallsAvoided: request.requestedKeys.length }
  };
}

function parseRequestProfile(value: string): ExtractionRequestProfile {
  if ((EXTRACTION_REQUEST_PROFILES as readonly string[]).includes(value)) {
    return value as ExtractionRequestProfile;
  }
  throw new DiagnosticLoopFailure({
    phase: "extraction",
    classification: "authority",
    message: `unsupported request profile '${value}'`,
    resumeCommand: ""
  });
}

function formatCacheOnlyMiss(missing: readonly string[], invalid: readonly string[]): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing cache keys: ${missing.join(", ")}`);
  }
  if (invalid.length > 0) {
    parts.push(`invalid cache shards: ${invalid.join("; ")}`);
  }
  return `${parts.join("; ")}; live extraction disabled`;
}
