import { AlayaError } from "@do-soul/alaya-protocol";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT, SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT,
  buildSourceSemanticCorrespondenceRequest, buildSourceSemanticQueryRequest,
  sourceSemanticCorrespondenceResponseJsonSchema, sourceSemanticQueryResponseJsonSchema,
  type SourceSemanticCorrespondenceRequest, type SourceSemanticQueryRequest
} from "@do-soul/alaya-soul";
import { SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID } from "@do-soul/alaya-core";
import { isNativeGeminiRequestProfile } from "../extraction/request-profile.js";
import { prepareSemanticProviderRequest, STEP_SEMANTIC_REQUEST_PROFILE } from "../compile-seed/http/semantic-provider-http.js";
import { normalizeGeminiEndpoint } from "../provider/gemini-endpoint.js";
import { buildExtractionTransportProvenance, resolveExtractionTransportRoute, type ExtractionTransportProvenance } from "../extraction/transport-route.js";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { attemptInputByteUpperBound } from "../extraction/authority/receipt-limits.js";

export const SEMANTIC_PROPOSAL_WORKSET_CONTRACT = "source-semantic-proposal-workset-v3" as const;
export const STEP_SEMANTIC_PROPOSAL_WORKSET_CONTRACT = "source-semantic-proposal-workset-v4" as const;
export const SEMANTIC_PROPOSAL_OUTPUT_TOKEN_DEFAULT = 4096;

export function semanticProposalWorksetContract(requestProfile: string) {
  return requestProfile === STEP_SEMANTIC_REQUEST_PROFILE
    ? STEP_SEMANTIC_PROPOSAL_WORKSET_CONTRACT : SEMANTIC_PROPOSAL_WORKSET_CONTRACT;
}

const QueryItemSchema = z.object({
  original_query: z.string().min(1).max(8192),
  approved_fixed_context: z.object({
    context_id: z.string().min(1).max(256),
    notes: z.string().min(1).max(1024).optional()
  }).strict().optional()
}).strict();

const CorrespondenceItemSchema = z.object({
  original_query: z.string().min(1).max(8192),
  admitted_query_semantics: z.unknown(),
  source_interpretation_descriptors: z.array(z.unknown()).min(1).max(1)
}).strict();

export const SemanticProposalWorksetSchema = z.object({
  contract: z.enum([SEMANTIC_PROPOSAL_WORKSET_CONTRACT, STEP_SEMANTIC_PROPOSAL_WORKSET_CONTRACT]),
  kind: z.enum(["query", "semantic_correspondence"]),
  model: z.string().min(1),
  provider_url: z.string().min(1),
  request_profile: z.string().min(1),
  producer_id: z.string().min(1).optional(),
  producer_version: z.string().min(1).optional(),
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
  const step = workset.request_profile === STEP_SEMANTIC_REQUEST_PROFILE;
  if (workset.contract !== semanticProposalWorksetContract(workset.request_profile)) {
    throw new AlayaError("VALIDATION", "semantic proposal workset contract/profile mismatch");
  }
  return { ...workset, provider_url: step
    ? workset.provider_url : normalizeGeminiEndpoint(workset.provider_url).origin };
}

export function materializeSemanticProposalLines(
  workset: SemanticProposalWorkset, maxOutputTokens: number
): readonly SemanticProposalLine[] {
  if (workset.contract !== semanticProposalWorksetContract(workset.request_profile)) {
    throw new AlayaError("VALIDATION", "semantic proposal workset contract/profile mismatch");
  }
  if (!isNativeGeminiRequestProfile(workset.request_profile) && workset.request_profile !== STEP_SEMANTIC_REQUEST_PROFILE) {
    throw new AlayaError("VALIDATION", "semantic proposal fill requires a native semantic request profile");
  }
  if (workset.kind === "query") {
    const producer_id = workset.producer_id ?? SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID;
    const producer_version = workset.producer_version ?? "1";
    const schema = sourceSemanticQueryResponseJsonSchema();
    return workset.items.map((item) => {
      const parsed = QueryItemSchema.parse(item);
      const request = buildSourceSemanticQueryRequest({
        original_query: parsed.original_query, producer_id, producer_version,
        ...(parsed.approved_fixed_context === undefined ? {} : { approved_fixed_context: parsed.approved_fixed_context })
      });
      return bindLine(workset, "query", SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, request, schema,
        parsed.original_query, maxOutputTokens);
    });
  }
  const producer_id = workset.producer_id ?? SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID;
  const producer_version = workset.producer_version ?? "1";
  const schema = sourceSemanticCorrespondenceResponseJsonSchema();
  return workset.items.map((item) => {
    const parsed = CorrespondenceItemSchema.parse(item);
    const request = buildSourceSemanticCorrespondenceRequest({
      original_query: parsed.original_query,
      admitted_query_semantics: parsed.admitted_query_semantics as SourceSemanticCorrespondenceRequest["admitted_query_semantics"],
      source_interpretation_descriptors: parsed.source_interpretation_descriptors as SourceSemanticCorrespondenceRequest["source_interpretation_descriptors"],
      producer_id, producer_version
    });
    return bindLine(workset, "semantic_correspondence", SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT, request, schema,
      parsed.original_query, maxOutputTokens);
  });
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
  if (!isNativeGeminiRequestProfile(workset.request_profile) && workset.request_profile !== STEP_SEMANTIC_REQUEST_PROFILE) {
    throw new AlayaError("VALIDATION", "semantic proposal fill requires a native semantic request profile");
  }
  const userPrompt = JSON.stringify(request);
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
  const encoded = prepareSemanticProviderRequest(config, { ...request, retryMode: "disabled",
    outputTokenField: config.requestProfile === STEP_SEMANTIC_REQUEST_PROFILE ? "max_tokens" : "maxOutputTokens",
    validateRawJson: () => undefined }, "source_semantic_proposal");
  const route = resolveExtractionTransportRoute(config);
  return {
    inputByteUpper: attemptInputByteUpperBound(encoded.body),
    requestDigest: createHash("sha256").update(JSON.stringify([encoded.url.href, encoded.body])).digest("hex"),
    transportProvenance: buildExtractionTransportProvenance({ ...config,
      transportProviderUrl: config.requestProfile === STEP_SEMANTIC_REQUEST_PROFILE
        ? route.providerUrl : normalizeGeminiEndpoint(route.providerUrl).origin })
  };
}

export function proposalCacheKey(
  model: string, requestProfile: string, systemPrompt: string, userPrompt: string, schema: object,
  maxOutputTokens: number, providerUrl: string
): string {
  if (!isNativeGeminiRequestProfile(requestProfile) && requestProfile !== STEP_SEMANTIC_REQUEST_PROFILE) {
    throw new AlayaError("VALIDATION", "semantic proposal requires a native semantic profile");
  }
  const wire = prepareSemanticProviderRequest({ model, requestProfile, providerUrl, apiKey: null }, {
    systemPrompt, userPrompt, maxOutputTokens, responseJsonSchema: schema,
    outputTokenField: requestProfile === STEP_SEMANTIC_REQUEST_PROFILE ? "max_tokens" : "maxOutputTokens",
    retryMode: "disabled", validateRawJson: () => undefined
  }, "source_semantic_proposal");
  return createHash("sha256")
    .update(semanticProposalWorksetContract(requestProfile), "utf8").update("\u0000", "utf8")
    .update(model, "utf8").update("\u0000", "utf8")
    .update(requestProfile, "utf8").update("\u0000", "utf8")
    .update(systemPrompt, "utf8").update("\u0000", "utf8")
    .update(userPrompt, "utf8").update("\u0000", "utf8")
    .update(wire.url.href, "utf8").update("\u0000", "utf8")
    .update(wire.body, "utf8").update("\u0000", "utf8")
    .update(String(maxOutputTokens), "utf8")
    .digest("hex");
}
