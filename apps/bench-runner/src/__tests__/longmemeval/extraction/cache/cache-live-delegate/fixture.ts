import { existsSync, readFileSync } from "node:fs";
import { expect, vi } from "vitest";
import {
  buildOfficialApiExtractionRequest,
  buildOfficialApiSourceCorpus,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { createGardenHttpExtractor } from
  "../../../../../runs/compile-seed.js";
import { cacheFilePath, computeSourceTurnCacheKey } from
  "../../../../../runs/compile-seed/compile-seed-cache.js";
import {
  TEST_EXTRACTION_PROVIDER_URL
} from "../../extraction-cache-test-fixture.js";


export const MODEL = "test-model";
export const SYSTEM_PROMPT = "test-system-prompt";
export const REQUEST_PROFILE = "provider-default-v1" as const;

export function extractionConfig() {
  return {
    model: MODEL,
    modelFamily: MODEL,
    providerUrl: TEST_EXTRACTION_PROVIDER_URL,
    requestProfile: REQUEST_PROFILE
  } as const;
}

export function failure(attempt: number, digit: string) {
  return {
    kind: "http_error" as const,
    phase: "response_status" as const,
    httpStatus: 503,
    fingerprint: digit.repeat(64),
    attempt
  };
}

function shardPath(cacheRoot: string): string {
  return cacheFilePath(cacheRoot, computeSourceTurnCacheKey(
    MODEL,
    REQUEST_PROFILE,
    SYSTEM_PROMPT,
    { turnContent: "I completed the review today." }
  ));
}

export function readShard(cacheRoot: string): {
  readonly raw_json: string;
  readonly response_metadata?: {
    readonly usage?: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly total_tokens: number;
    };
  };
  readonly transport_provenance?: {
    readonly provider_url_sha256: string;
    readonly model: string;
  };
} {
  expect(existsSync(shardPath(cacheRoot))).toBe(true);
  return JSON.parse(readFileSync(shardPath(cacheRoot), "utf8"));
}

export function userPromptWithAssertions(): string {
  return stringifyOfficialApiExtractionRequest(
    buildOfficialApiExtractionRequest("I completed the review today.", [])
  );
}

export function createHttpExtractor(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
  return createGardenHttpExtractor({
    ...extractionConfig(),
    apiKey: "sk-test"
  }, {
    fetch: fetchMock,
    sleep: vi.fn(async () => undefined),
    random: () => 0
  });
}

export function assertionBatchCorpus(assertionIds: readonly number[]): string {
  return buildOfficialApiSourceCorpus(assertionBatchText(assertionIds), []);
}

function assertionBatchText(assertionIds: readonly number[]): string {
  return assertionIds.map((id) => `I completed assertion ${id}.`).join(" ");
}

export function assertionBatchPrompt(assertionIds: readonly number[]): string {
  return stringifyOfficialApiExtractionRequest(buildOfficialApiExtractionRequest(assertionBatchText(assertionIds), []));
}

export function sourceCorpusWithAssertions(): string {
  return buildOfficialApiSourceCorpus("I completed the review today.", []);
}

export function cacheInterpretationResponse(assertionId: number): Response {
  return sseResponse(JSON.stringify({ interpretations: [{ assertion_id: assertionId,
    relations: [{ predicate: { text: `I completed assertion ${assertionId}.` }, arguments: [], qualifiers: [] }]
  }] }), "stop");
}

export function truncatedSseResponse(): Response {
  return sseResponse('{"interpretations":[]}', "length");
}

export function sseResponse(content: string, finishReason: string): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n` +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}
