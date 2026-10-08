import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  bindSemanticProviderRequest, estimatedSemanticProviderUpperUsd,
  semanticProviderRequestCacheKey, SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME,
  SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME, SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME,
  PAGE_SUPPORT_COMPARISON_SCHEMA_NAME
} from "../../../runs/provider-request/request-binding.js";
import { EVIDENCE_SELECTION_WORKSET_CONTRACT } from "../../../runs/evidence-selection/input.js";
import { SOURCE_EVIDENCE_PRESERVATION_WORKSET_CONTRACT } from "../../../runs/source-evidence-preservation/input.js";
import { PAGE_SUPPORT_COMPARISON_WORKSET_CONTRACT } from "../../../runs/page-support-comparison/input.js";
import { estimatedUpperUsd, pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import {
  executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults
} from "../../../runs/semantic-proposal/fill.js";
import {
  materializeSemanticProposalLines, parseSemanticProposalWorkset, proposalCacheKey,
  semanticProposalRequestBinding, SEMANTIC_PROPOSAL_WORKSET_CONTRACT
} from "../../../runs/semantic-proposal/workset.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { openSemanticProposalAttemptLedger } from "../../../runs/semantic-proposal/attempt.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";

const MODEL = "gemini-3.1-flash-lite";
const PROFILE = "gemini-3.1-minimal-v1" as const;
const rawJson = JSON.stringify({ contract: "source-semantic-query-response-v8", outcome: { status: "abstained" } });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workset(provider_url: string) {
  return parseSemanticProposalWorkset({
    contract: SEMANTIC_PROPOSAL_WORKSET_CONTRACT, kind: "query", model: MODEL,
    request_profile: PROFILE, provider_url, items: [{ original_query: "Who reported that Lee left?" }]
  });
}

it("keeps Q/C wire identity and quote on the shared request-binding owner", () => {
  const prepared = workset("http://127.0.0.1:9");
  const line = materializeSemanticProposalLines(prepared, 128)[0]!;
  const config: CompileSeedExtractionConfig = {
    model: MODEL, requestProfile: PROFILE, providerUrl: prepared.provider_url, apiKey: null
  };
  const request = {
    systemPrompt: line.systemPrompt, userPrompt: line.userPrompt,
    responseJsonSchema: line.responseJsonSchema, maxOutputTokens: 128
  };
  expect(bindSemanticProviderRequest(config, request, SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME))
    .toEqual(semanticProposalRequestBinding(config, request));
  expect(semanticProviderRequestCacheKey({
    identityPrefix: SEMANTIC_PROPOSAL_WORKSET_CONTRACT, model: MODEL, requestProfile: PROFILE,
    systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, schema: line.responseJsonSchema,
    maxOutputTokens: 128, providerUrl: prepared.provider_url, schemaName: SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME
  })).toBe(proposalCacheKey(MODEL, PROFILE, line.systemPrompt, line.userPrompt,
    line.responseJsonSchema, 128, prepared.provider_url));
  expect(bindSemanticProviderRequest(config, request, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME).requestDigest)
    .toBe(line.requestDigest);
  expect(semanticProviderRequestCacheKey({
    identityPrefix: EVIDENCE_SELECTION_WORKSET_CONTRACT, model: MODEL, requestProfile: PROFILE,
    systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, schema: line.responseJsonSchema,
    maxOutputTokens: 128, providerUrl: prepared.provider_url, schemaName: SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME
  })).not.toBe(line.key);
  expect(semanticProviderRequestCacheKey({
    identityPrefix: SOURCE_EVIDENCE_PRESERVATION_WORKSET_CONTRACT, model: MODEL, requestProfile: PROFILE,
    systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, schema: line.responseJsonSchema,
    maxOutputTokens: 128, providerUrl: prepared.provider_url, schemaName: SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME
  })).not.toBe(line.key);
  expect(semanticProviderRequestCacheKey({
    identityPrefix: PAGE_SUPPORT_COMPARISON_WORKSET_CONTRACT, model: MODEL, requestProfile: PROFILE,
    systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, schema: line.responseJsonSchema,
    maxOutputTokens: 128, providerUrl: prepared.provider_url, schemaName: PAGE_SUPPORT_COMPARISON_SCHEMA_NAME
  })).not.toBe(line.key);
  expect(SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME).not.toBe(SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME);
  expect(PAGE_SUPPORT_COMPARISON_SCHEMA_NAME).not.toBe(SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME);
  expect(PAGE_SUPPORT_COMPARISON_SCHEMA_NAME).not.toBe(SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME);
  const quote = { maximum_attempts: 2, max_output_tokens: 128, maximum_input_tokens_per_attempt: 4096 };
  expect(estimatedSemanticProviderUpperUsd(quote, 1, 2)).toBe(estimatedUpperUsd(quote, 1, 2));
  expect(estimatedSemanticProviderUpperUsd(quote, 1, 2)).toBe((4096 * 1 + 128 * 2) / 1_000_000 * 2);
});

it("binds JSON Mode identity to the complete instruction schema and selected format", () => {
  const input = {
    identityPrefix: SEMANTIC_PROPOSAL_WORKSET_CONTRACT, model: "step-5-preview",
    requestProfile: "step-5-preview-low-json-mode-v1" as const,
    systemPrompt: "Preserve the source.", userPrompt: "A source assertion.",
    schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    maxOutputTokens: 128, providerUrl: "https://api.stepfun.com/v1",
    schemaName: SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME
  };
  const key = semanticProviderRequestCacheKey(input);
  expect(semanticProviderRequestCacheKey({ ...input, requestProfile: "step-5-preview-low-json-schema-v1" }))
    .not.toBe(key);
  expect(semanticProviderRequestCacheKey({ ...input, schema: { ...input.schema, required: [] } }))
    .not.toBe(key);
  expect(semanticProviderRequestCacheKey({ ...input, schemaName: "changed_semantic_schema" }))
    .not.toBe(key);
});

it("replays Q fill from retained raw over loopback HTTP without a second call or double settlement", async () => {
  const wires: string[] = [];
  const server = createServer((request, response) => {
    wires.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: rawJson }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8 }
    }));
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cacheRoot = mkdtempSync(join(tmpdir(), "provider-request-qc-"));
    roots.push(cacheRoot);
    const prepared = workset(origin);
    const config: CompileSeedExtractionConfig = {
      model: MODEL, requestProfile: PROFILE, providerUrl: origin, apiKey: "loopback-only"
    };
    const authority = pinSemanticProposalAuthority({
      preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
      inputUsdPerMillion: 1, outputUsdPerMillion: 2
    });
    const extractor = createSemanticProviderHttpExtractor(config, "source_semantic_proposal");
    const first = await executeSemanticProposalFill({
      workset: prepared, cacheRoot, authority, config, extractor
    });
    expect(first).toMatchObject({ attempts: 1, abstained: 1, newly_admitted: 0 });
    expect(wires).toHaveLength(1);
    const key = authority.keys[0]!;
    expect(readProviderRawAttempt(cacheRoot, key, 1)?.request_digest)
      .toBe(materializeSemanticProposalLines(prepared, 128)[0]!.requestDigest);
    const before = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot();
    expect(before).toMatchObject({ attempts: 1, successfulShards: 0 });
    const second = await executeSemanticProposalFill({
      workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
    });
    expect(second).toMatchObject({ cache_hits: 1, attempts: 0, abstained: 1 });
    expect(wires).toHaveLength(1);
    expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot())
      .toMatchObject({ attempts: 1, settledAttempts: [{ cacheKey: key, attemptOrdinal: 1 }] });
    expect(readSemanticProposalResults(prepared, cacheRoot, 128)[0]?.status).toBe("abstained");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});
