import { createHash } from "node:crypto";
import { z } from "zod";
import {
  OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE,
  OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT
} from "@do-soul/alaya-soul";
import {
  CURRENT_EXTRACTION_REQUEST_PROFILES,
  isCurrentExtractionRequestProfile,
  type CurrentExtractionRequestProfile
} from "../extraction/request-profile.js";
import type { ExtractionTransportProvenance } from
  "../extraction/transport-route.js";

export const QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION = 4 as const;
export const QUERY_SEMANTIC_FACTOR_CACHE_DIAGNOSTIC_SCHEMA_VERSION = 3 as const;
export const QUERY_SEMANTIC_FACTOR_FILL_IDENTITY_SCHEMA_VERSION = 3 as const;

const PrefixedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const TransportRouteSchema = z.object({
  provider_url_sha256: PrefixedSha256Schema,
  model: z.string().min(1)
}).strict();

// Schema 3 archives stay readable; they cannot bind as current authority.
export const QuerySemanticFactorCacheDiagnosticIdentitySchema = z.object({
  schema_version: z.literal(QUERY_SEMANTIC_FACTOR_CACHE_DIAGNOSTIC_SCHEMA_VERSION),
  cache_content_sha256: PrefixedSha256Schema,
  compiler_operator_id: z.string().min(1),
  system_prompt_sha256: PrefixedSha256Schema,
  request_template_sha256: PrefixedSha256Schema,
  model_id: z.string().min(1),
  provider_url_sha256: PrefixedSha256Schema,
  source_set_sha256: PrefixedSha256Schema,
  entry_count: z.number().int().nonnegative(),
  transport_routes: z.array(TransportRouteSchema).optional()
}).strict();

export const QuerySemanticFactorCacheIdentitySchema = z.object({
  schema_version: z.literal(QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION),
  cache_content_sha256: PrefixedSha256Schema,
  compiler_operator_id: z.literal(OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID),
  request_profile: z.enum(CURRENT_EXTRACTION_REQUEST_PROFILES),
  system_prompt_sha256: PrefixedSha256Schema,
  request_template_sha256: PrefixedSha256Schema,
  model_id: z.string().min(1),
  provider_url_sha256: PrefixedSha256Schema,
  source_set_sha256: PrefixedSha256Schema,
  entry_count: z.number().int().nonnegative(),
  transport_routes: z.array(TransportRouteSchema).min(1)
}).strict();

export const QuerySemanticFactorCacheProvenanceIdentitySchema = z.discriminatedUnion(
  "schema_version",
  [
    QuerySemanticFactorCacheDiagnosticIdentitySchema,
    QuerySemanticFactorCacheIdentitySchema
  ]
);

export type QuerySemanticFactorCacheBinding =
  z.infer<typeof QuerySemanticFactorCacheIdentitySchema> & Readonly<{
    compiler_operator_id: typeof OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID;
    request_profile: CurrentExtractionRequestProfile;
    transport_routes: readonly ExtractionTransportProvenance[];
  }>;

export type DiagnosticQueryFactorCacheIdentity = QuerySemanticFactorCacheBinding & Readonly<{
  path: string;
  file_sha256: string;
}>;

export type QueryCacheObservedIdentity = Readonly<{
  schema_version: number | null;
  compiler_operator_id: string | null;
  request_profile: string | null;
  system_prompt_sha256: string | null;
  request_template_sha256: string | null;
  model_id: string | null;
  provider_url_sha256: string | null;
  source_set_sha256: string | null;
  cache_content_sha256: string | null;
}>;

export type QueryCacheIdentityInspection =
  | { readonly kind: "current"; readonly binding: QuerySemanticFactorCacheBinding }
  | {
      readonly kind: "diagnostic_only";
      readonly reason: string;
      readonly observed: QueryCacheObservedIdentity;
    }
  | { readonly kind: "rejected"; readonly reason: string };

export function currentQueryCacheRequestProfile(
  value: string
): CurrentExtractionRequestProfile {
  if (!isCurrentExtractionRequestProfile(value)) {
    throw new Error("query semantic factor cache request profile is not current authority");
  }
  return value;
}

function queryCacheProviderRouteSha256(providerRoute: string): string {
  // Snapshot provenance persists redactProvenanceUrl(url); hashing that digest again cannot match a once-sealed cache.
  if (PrefixedSha256Schema.safeParse(providerRoute).success) {
    return providerRoute;
  }
  if (providerRoute.startsWith("sha256:")) {
    throw new Error("query semantic factor cache provider route digest is malformed");
  }
  return prefixedSha256(providerRoute);
}

export function assertQuerySemanticFactorCacheMatchesRequest(
  binding: QuerySemanticFactorCacheBinding,
  request: Readonly<{
    readonly requestProfile: string;
    readonly model: string;
    readonly providerRoute: string;
  }>
): void {
  currentQueryCacheRequestProfile(binding.request_profile);
  if (binding.request_profile !== request.requestProfile) {
    throw new Error("query semantic factor cache request profile does not match this request");
  }
  if (binding.model_id !== request.model) {
    throw new Error("query semantic factor cache model does not match this request");
  }
  if (binding.provider_url_sha256 !== queryCacheProviderRouteSha256(request.providerRoute)) {
    throw new Error("query semantic factor cache provider route does not match this request");
  }
}

export function assertCurrentQuerySemanticFactorCacheIdentity(
  inspection: QueryCacheIdentityInspection
): QuerySemanticFactorCacheBinding {
  if (inspection.kind !== "current") {
    throw new Error(
      `query semantic factor cache identity is ${inspection.kind}` +
      ("reason" in inspection ? ` (${inspection.reason})` : "") +
      "; cannot bind as current authority"
    );
  }
  return inspection.binding;
}

export function isCurrentQueryFactorCacheRunIdentity(
  value: unknown
): value is DiagnosticQueryFactorCacheIdentity {
  if (!isRecord(value) || typeof value.path !== "string" || value.path.length === 0 ||
      typeof value.file_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.file_sha256)) {
    return false;
  }
  return inspectQuerySemanticFactorCacheIdentity(value).kind === "current";
}

export function inspectQuerySemanticFactorCacheIdentity(
  raw: unknown
): QueryCacheIdentityInspection {
  const observed = observeQueryCacheIdentity(raw);
  if (observed === null) {
    return { kind: "rejected", reason: "query semantic factor cache identity is not an object" };
  }
  const parsed = QuerySemanticFactorCacheIdentitySchema.safeParse(
    identityFields(raw)
  );
  if (parsed.success) {
    try {
      currentQueryCacheRequestProfile(parsed.data.request_profile);
    } catch {
      return { kind: "diagnostic_only", reason: "request_profile", observed };
    }
    if (parsed.data.system_prompt_sha256 !==
          prefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT) ||
        parsed.data.request_template_sha256 !==
          prefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE)) {
      return { kind: "rejected", reason: "prompt_or_request_template" };
    }
    return {
      kind: "current",
      binding: {
        ...parsed.data,
        request_profile: currentQueryCacheRequestProfile(parsed.data.request_profile),
        transport_routes: parsed.data.transport_routes.map((route) => ({ ...route }))
      }
    };
  }
  return {
    kind: "diagnostic_only",
    reason: diagnosticOnlyReason(observed),
    observed
  };
}

function diagnosticOnlyReason(observed: QueryCacheObservedIdentity): string {
  if (observed.schema_version !== QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION) {
    return "schema_version";
  }
  if (observed.compiler_operator_id !== OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID) {
    return "compiler_operator_id";
  }
  if (observed.request_profile === null) return "request_profile";
  return "request_identity";
}

function observeQueryCacheIdentity(raw: unknown): QueryCacheObservedIdentity | null {
  if (!isRecord(raw)) return null;
  return {
    schema_version: typeof raw.schema_version === "number" ? raw.schema_version : null,
    compiler_operator_id: readString(raw.compiler_operator_id),
    request_profile: readString(raw.request_profile),
    system_prompt_sha256: readString(raw.system_prompt_sha256),
    request_template_sha256: readString(raw.request_template_sha256),
    model_id: readString(raw.model_id),
    provider_url_sha256: readString(raw.provider_url_sha256),
    source_set_sha256: readString(raw.source_set_sha256),
    cache_content_sha256: readString(raw.cache_content_sha256)
  };
}

function identityFields(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const {
    entries: _entries,
    path: _path,
    file_sha256: _file,
    ...fields
  } = raw;
  return {
    ...fields,
    entry_count: typeof raw.entry_count === "number"
      ? raw.entry_count
      : Array.isArray(raw.entries) ? raw.entries.length : raw.entry_count
  };
}

export function queryCacheSha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function queryCachePrefixedSha256(value: string): string {
  return `sha256:${queryCacheSha256Hex(value)}`;
}

function prefixedSha256(value: string): string {
  return queryCachePrefixedSha256(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
