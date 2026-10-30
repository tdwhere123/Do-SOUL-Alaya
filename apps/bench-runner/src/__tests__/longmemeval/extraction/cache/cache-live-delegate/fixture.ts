import { existsSync, readFileSync } from "node:fs";
import { expect, vi } from "vitest";
import {
  SOURCE_STATEMENTS_PROMPT
} from "@do-soul/alaya-soul";
import { createGardenHttpExtractor } from
  "../../../../../runs/compile-seed.js";
import { sourceStatementRequests, sourceStatementSession } from "../../../../../runs/extraction/source-statement-request.js";
import { cacheFilePath, computeCacheKey } from
  "../../../../../runs/compile-seed/compile-seed-cache.js";
import {
  TEST_EXTRACTION_PROVIDER_URL
} from "../../extraction-cache-test-fixture.js";


export const MODEL = "test-model";
export const SYSTEM_PROMPT = SOURCE_STATEMENTS_PROMPT;
export const EMPTY_RESPONSE = '{"messages":[{"message_id":"recorded-user","statements":[]}]}';
const hostMessages = [{ message_id: "recorded-user", role: "user" as const, content: "I completed the review today." }];
export const REQUEST_PROFILE = "provider-default-v1" as const;

export function extractionConfig() {
  return {
    model: MODEL,
    modelFamily: MODEL,
    providerUrl: TEST_EXTRACTION_PROVIDER_URL,
    requestProfile: REQUEST_PROFILE,
    sourcePacking: "session-statements"
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
  return cacheFilePath(cacheRoot, computeCacheKey(MODEL, REQUEST_PROFILE, SYSTEM_PROMPT, userPromptWithAssertions()));
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
  return sourceStatementRequests(hostMessages)[0]!.userPrompt;
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
  return sourceStatementSession(batchMessages(assertionIds)).rendered.content;
}

function batchMessages(assertionIds: readonly number[]) {
  return assertionIds.map(id => ({ message_id: `recorded-${id}`, role: "user" as const, content: `I completed assertion ${id}.` }));
}

export function assertionBatchPrompt(assertionIds: readonly number[]): string {
  return sourceStatementRequests(batchMessages(assertionIds))[0]!.userPrompt;
}

export function sourceCorpusWithAssertions(): string {
  return sourceStatementSession(hostMessages).rendered.content;
}

export function cacheInterpretationResponse(assertionId: number): Response {
  return sseResponse(JSON.stringify({ messages: [{ message_id: `recorded-${assertionId}`,
    statements: [{ text: `I completed assertion ${assertionId}.`, relation: "recorded event" }]
  }] }), "stop");
}

export function truncatedSseResponse(): Response {
  return sseResponse(EMPTY_RESPONSE, "length");
}

export function sseResponse(content: string, finishReason: string): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n` +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

export function jsonChatCompletionResponse(content: string,
  usage?: { readonly inputTokens: number; readonly outputTokens: number }): Response {
  return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }],
    ...(usage === undefined ? {} : { usage: {
      prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens
    } }) });
}
