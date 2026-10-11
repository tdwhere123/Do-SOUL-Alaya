import {
  isChatSemanticRequestProfile, AlayaError, ApprovedSemanticContextSchema, UtteranceAttributionSchema,
  UNKNOWN_UTTERANCE_ATTRIBUTION, SourceSemanticCorrespondenceGenerationPolicySchema, SourceSemanticQueryPresentationSchema
} from "@do-soul/alaya-protocol";
import { z } from "zod";
import {
  sourceSemanticCorrespondenceSystemPrompt, sourceSemanticQuerySystemPrompt,
  SourceSemanticProposalRevisionSchema,
  buildSourceSemanticCorrespondenceRequest, buildSourceSemanticQueryRequest,
  sourceSemanticCorrespondenceResponseJsonSchema, sourceSemanticQueryResponseJsonSchema,
  type SourceSemanticCorrespondenceRequest, type SourceSemanticQueryRequest
} from "@do-soul/alaya-soul";
import { SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID, SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION,
  SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID } from "@do-soul/alaya-core";
import { isNativeGeminiRequestProfile } from "../extraction/request-profile.js";
import { normalizeGeminiEndpoint } from "../provider/gemini-endpoint.js";
import type { ExtractionTransportProvenance } from "../extraction/transport-route.js";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import {
  bindSemanticProviderRequest, semanticProviderRequestCacheKey, SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME
} from "../provider-request/request-binding.js";

export const SEMANTIC_PROPOSAL_WORKSET_CONTRACT = "source-semantic-proposal-workset-v3" as const;
export const STEP_SEMANTIC_PROPOSAL_WORKSET_CONTRACT = "source-semantic-proposal-workset-v4" as const;
export const SEMANTIC_PROPOSAL_OUTPUT_TOKEN_DEFAULT = 4096;

export function semanticProposalWorksetContract(requestProfile: string) {
  return isChatSemanticRequestProfile(requestProfile)
    ? STEP_SEMANTIC_PROPOSAL_WORKSET_CONTRACT : SEMANTIC_PROPOSAL_WORKSET_CONTRACT;
}

/** Bench-only lookup context. Native wire identity and retained evidence verify every field. */
const RetainedSemanticQueryParentSchema = z.object({
  key: z.string().regex(/^[0-9a-f]{64}$/u),
  request_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  system_prompt: z.string().min(1),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  provider_url: z.string().min(1),
  max_output_tokens: z.number().int().positive()
}).strict();
export type RetainedSemanticQueryParent = z.infer<typeof RetainedSemanticQueryParentSchema>;

const QueryItemSchema = z.object({
  original_query: z.string().min(1).max(8192),
  approved_fixed_context: ApprovedSemanticContextSchema.optional(),
  attribution_context: UtteranceAttributionSchema.optional(),
  generation_presentation: SourceSemanticQueryPresentationSchema.optional(),
  revision: SourceSemanticProposalRevisionSchema.optional(),
  retained_parent: RetainedSemanticQueryParentSchema.optional()
}).strict().refine(item => item.retained_parent === undefined || item.revision !== undefined,
  "retained query parent requires a revision");

const CorrespondenceItemSchema = z.object({
  original_query: z.string().min(1).max(8192),
  admitted_query_semantics: z.unknown(),
  source_interpretation_descriptors: z.array(z.unknown()).min(1).max(1),
  generation_policy: SourceSemanticCorrespondenceGenerationPolicySchema.optional(),
  revision: SourceSemanticProposalRevisionSchema.optional()
}).strict();

export const SemanticProposalWorksetSchema = z.object({
  contract: z.enum([SEMANTIC_PROPOSAL_WORKSET_CONTRACT, STEP_SEMANTIC_PROPOSAL_WORKSET_CONTRACT]),
  kind: z.enum(["query", "semantic_correspondence"]),
  model: z.string().min(1),
  provider_url: z.string().min(1),
  request_profile: z.string().min(1),
  producer_id: z.string().min(1).optional(),
  producer_version: z.string().min(1).optional(),
  revision_parent_cache_root: z.string().min(1).optional(),
  items: z.array(z.unknown()).min(1)
}).strict();

export type SemanticProposalKind = "query" | "semantic_correspondence";
export type SemanticProposalWorkset = z.infer<typeof SemanticProposalWorksetSchema>;

export type SemanticProposalLine = Readonly<{
  key: string;
  kind: SemanticProposalKind;
  systemPrompt: string;
  userPrompt: string;
  responseJsonSchema: object;
  original_query: string;
  request: SourceSemanticQueryRequest | SourceSemanticCorrespondenceRequest;
  inputByteUpper: number;
  requestDigest: string;
  transportProvenance: ExtractionTransportProvenance;
}>;

export function parseSemanticProposalWorkset(value: unknown): SemanticProposalWorkset {
  const workset = SemanticProposalWorksetSchema.parse(value);
  const chat = isChatSemanticRequestProfile(workset.request_profile);
  if (workset.contract !== semanticProposalWorksetContract(workset.request_profile)) {
    throw new AlayaError("VALIDATION", "semantic proposal workset contract/profile mismatch");
  }
  return { ...workset, provider_url: chat
    ? workset.provider_url : normalizeGeminiEndpoint(workset.provider_url).origin };
}

export function materializeSemanticProposalLines(
  workset: SemanticProposalWorkset, maxOutputTokens: number
): readonly SemanticProposalLine[] {
  if (workset.contract !== semanticProposalWorksetContract(workset.request_profile)) {
    throw new AlayaError("VALIDATION", "semantic proposal workset contract/profile mismatch");
  }
  if (!isNativeGeminiRequestProfile(workset.request_profile) && !isChatSemanticRequestProfile(workset.request_profile)) {
    throw new AlayaError("VALIDATION", "semantic proposal fill requires a native semantic request profile");
  }
  if (workset.kind === "query") {
    const producer_id = workset.producer_id ?? SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID;
    const producer_version = workset.producer_version ?? "1";
    return workset.items.map((item) => {
      const parsed = QueryItemSchema.parse(item);
      const request = buildSourceSemanticQueryRequest({
        original_query: parsed.original_query, producer_id, producer_version,
        ...(parsed.approved_fixed_context === undefined ? {} : { approved_fixed_context: parsed.approved_fixed_context }),
        attribution_context: parsed.attribution_context ?? UNKNOWN_UTTERANCE_ATTRIBUTION,
        ...(parsed.generation_presentation === undefined ? {} : { generation_presentation: parsed.generation_presentation }),
        ...(parsed.revision === undefined ? {} : { revision: parsed.revision })
      });
      return bindLine(workset, "query", sourceSemanticQuerySystemPrompt(request), request, sourceSemanticQueryResponseJsonSchema(request),
        parsed.original_query, maxOutputTokens);
    });
  }
  const producer_id = workset.producer_id ?? SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID;
  const producer_version = workset.producer_version ?? SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION;
  return workset.items.map((item) => {
    const parsed = CorrespondenceItemSchema.parse(item);
    const request = buildSourceSemanticCorrespondenceRequest({
      original_query: parsed.original_query,
      admitted_query_semantics: parsed.admitted_query_semantics as SourceSemanticCorrespondenceRequest["admitted_query_semantics"],
      source_interpretation_descriptors: parsed.source_interpretation_descriptors as SourceSemanticCorrespondenceRequest["source_interpretation_descriptors"],
      producer_id, producer_version,
      ...(parsed.generation_policy === undefined ? {} : { generation_policy: parsed.generation_policy }),
      ...(parsed.revision === undefined ? {} : { revision: parsed.revision })
    });
    return bindLine(workset, "semantic_correspondence", sourceSemanticCorrespondenceSystemPrompt(request), request,
      sourceSemanticCorrespondenceResponseJsonSchema(request), parsed.original_query, maxOutputTokens);
  });
}

/** Select the physical parent identically for revision preparation, validation and input containment. */
export function resolveSemanticProposalRevisionParent(
  workset: SemanticProposalWorkset, item: unknown, maxOutputTokens: number
): SemanticProposalLine {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new AlayaError("VALIDATION", "proposal revision requires its original workset item");
  }
  const { revision: _revision, retained_parent: retainedParent, ...baseItem } = item as Record<string, unknown>;
  if (retainedParent !== undefined && (workset.kind !== "query" || !isChatSemanticRequestProfile(workset.request_profile))) {
    // Native chat encodes the complete schema. Gemini can project it, so its wire
    // identity alone cannot prove that the full retained response schema is unchanged.
    throw new AlayaError("VALIDATION", "explicit retained proposal parents require a native chat query profile");
  }
  const current = materializeSemanticProposalLines({ ...workset, items: [baseItem] }, maxOutputTokens)[0]!;
  if (retainedParent === undefined) return current;
  const retained = RetainedSemanticQueryParentSchema.parse(retainedParent);
  if (retained.model !== workset.model || retained.request_profile !== workset.request_profile ||
      retained.provider_url !== workset.provider_url || retained.max_output_tokens !== maxOutputTokens) {
    throw new AlayaError("CONFLICT", "retained query parent changed model, profile, route or output cap");
  }
  // Only historical system guidance can differ. Rebinding the current request and schema
  // must reproduce the retained physical key and exact wire digest before cache inspection.
  const parent = bindLine(workset, "query", retained.system_prompt, current.request,
    current.responseJsonSchema, current.original_query, maxOutputTokens);
  if (parent.key !== retained.key || parent.requestDigest !== retained.request_digest) {
    throw new AlayaError("CONFLICT", "retained query parent differs from the unchanged request, schema or wire identity");
  }
  return parent;
}

function bindLine(
  workset: SemanticProposalWorkset,
  kind: SemanticProposalKind,
  systemPrompt: string,
  request: SourceSemanticQueryRequest | SourceSemanticCorrespondenceRequest,
  responseJsonSchema: object,
  original_query: string,
  maxOutputTokens: number
): SemanticProposalLine {
  if (!isNativeGeminiRequestProfile(workset.request_profile) && !isChatSemanticRequestProfile(workset.request_profile)) {
    throw new AlayaError("VALIDATION", "semantic proposal fill requires a native semantic request profile");
  }
  const userPrompt = JSON.stringify(kind === "semantic_correspondence"
    ? { ...request, response_schema: responseJsonSchema }
    : request);
  const config = { model: workset.model, providerUrl: workset.provider_url,
    requestProfile: workset.request_profile, apiKey: null };
  const binding = semanticProposalRequestBinding(config, { systemPrompt, userPrompt, maxOutputTokens, responseJsonSchema });
  return {
    key: proposalCacheKey(
      workset.model, workset.request_profile, systemPrompt, userPrompt, responseJsonSchema, maxOutputTokens, workset.provider_url
    ),
    kind, systemPrompt, userPrompt, responseJsonSchema, original_query, request,
    ...binding
  };
}

/** The actual sender owns encoding and route resolution, including thinking settings. */
export function semanticProposalRequestBinding(
  config: CompileSeedExtractionConfig,
  request: { systemPrompt: string; userPrompt: string; maxOutputTokens: number; responseJsonSchema: object }
) {
  return bindSemanticProviderRequest(config, request, SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME);
}

export function proposalCacheKey(
  model: string, requestProfile: string, systemPrompt: string, userPrompt: string, schema: object,
  maxOutputTokens: number, providerUrl: string
): string {
  if (!isNativeGeminiRequestProfile(requestProfile) && !isChatSemanticRequestProfile(requestProfile)) {
    throw new AlayaError("VALIDATION", "semantic proposal requires a native semantic profile");
  }
  return semanticProviderRequestCacheKey({
    identityPrefix: semanticProposalWorksetContract(requestProfile),
    model, requestProfile, systemPrompt, userPrompt, schema, maxOutputTokens, providerUrl,
    schemaName: SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME
  });
}
