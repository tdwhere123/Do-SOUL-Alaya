import { expect, it } from "vitest";
import {
  bindSemanticProviderRequest, estimatedSemanticProviderUpperUsd,
  semanticProviderRequestCacheKey, SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME,
  SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME, SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME,
  PAGE_SUPPORT_COMPARISON_SCHEMA_NAME
} from "../../../runs/provider-request/request-binding.js";
import { EVIDENCE_SELECTION_WORKSET_CONTRACT } from "../../../runs/evidence-selection/input.js";
import { SOURCE_EVIDENCE_PRESERVATION_WORKSET_CONTRACT } from "../../../runs/source-evidence-preservation/input.js";
import { PAGE_SUPPORT_COMPARISON_WORKSET_CONTRACT } from "../../../runs/page-support-comparison/input.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset, proposalCacheKey,
  semanticProposalRequestBinding, SEMANTIC_PROPOSAL_WORKSET_CONTRACT } from "../../../runs/semantic-cache/workset.js";

const MODEL = "gemini-3.1-flash-lite", PROFILE = "gemini-3.1-minimal-v1" as const;
it("keeps retained Q/C wire identity on the shared request-binding owner", () => {
  const prepared = parseSemanticProposalWorkset({ contract: SEMANTIC_PROPOSAL_WORKSET_CONTRACT,
    kind: "query", model: MODEL, request_profile: PROFILE, provider_url: "http://127.0.0.1:9",
    items: [{ original_query: "Who reported that Lee left?" }] });
  const line = materializeSemanticProposalLines(prepared, 128)[0]!;
  const config = { model: MODEL, requestProfile: PROFILE, providerUrl: prepared.provider_url, apiKey: null };
  const request = { systemPrompt: line.systemPrompt, userPrompt: line.userPrompt,
    responseJsonSchema: line.responseJsonSchema, maxOutputTokens: 128 };
  expect(bindSemanticProviderRequest(config, request, SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME))
    .toEqual(semanticProposalRequestBinding(config, request));
  expect(semanticProviderRequestCacheKey({ identityPrefix: SEMANTIC_PROPOSAL_WORKSET_CONTRACT,
    model: MODEL, requestProfile: PROFILE, systemPrompt: line.systemPrompt, userPrompt: line.userPrompt,
    schema: line.responseJsonSchema, maxOutputTokens: 128, providerUrl: prepared.provider_url,
    schemaName: SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME })).toBe(proposalCacheKey(MODEL, PROFILE,
      line.systemPrompt, line.userPrompt, line.responseJsonSchema, 128, prepared.provider_url));
  expect(bindSemanticProviderRequest(config, request, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME).requestDigest).toBe(line.requestDigest);
  const identities = [
    [EVIDENCE_SELECTION_WORKSET_CONTRACT, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME],
    [SOURCE_EVIDENCE_PRESERVATION_WORKSET_CONTRACT, SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME],
    [PAGE_SUPPORT_COMPARISON_WORKSET_CONTRACT, PAGE_SUPPORT_COMPARISON_SCHEMA_NAME]
  ] as const;
  for (const [identityPrefix, schemaName] of identities) {
    expect(semanticProviderRequestCacheKey({ identityPrefix, schemaName, model: MODEL, requestProfile: PROFILE,
      systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, schema: line.responseJsonSchema,
      maxOutputTokens: 128, providerUrl: prepared.provider_url })).not.toBe(line.key);
  }
  expect(new Set(identities.map(([, schemaName]) => schemaName)).size).toBe(3);
  expect(estimatedSemanticProviderUpperUsd({ maximum_attempts: 2, max_output_tokens: 128,
    maximum_input_tokens_per_attempt: 4096 }, 1, 2)).toBe((4096 + 128 * 2) / 1_000_000 * 2);
});

it("binds JSON Mode identity to the complete instruction schema and selected format", () => {
  const input = { identityPrefix: SEMANTIC_PROPOSAL_WORKSET_CONTRACT, model: "step-5-preview",
    requestProfile: "step-5-preview-low-json-mode-v1" as const,
    systemPrompt: "Preserve the source.", userPrompt: "A source assertion.",
    schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    maxOutputTokens: 128, providerUrl: "https://api.stepfun.com/v1", schemaName: SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME };
  const key = semanticProviderRequestCacheKey(input);
  expect(semanticProviderRequestCacheKey({ ...input, requestProfile: "step-5-preview-low-json-schema-v1" })).not.toBe(key);
  expect(semanticProviderRequestCacheKey({ ...input, schema: { ...input.schema, required: [] } })).not.toBe(key);
  expect(semanticProviderRequestCacheKey({ ...input, schemaName: "changed_semantic_schema" })).not.toBe(key);
});
