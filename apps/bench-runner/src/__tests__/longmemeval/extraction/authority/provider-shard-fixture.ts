import { createHash } from "node:crypto";
import {
  OFFICIAL_API_SYSTEM_PROMPT, buildOfficialApiExtractionRequest,
  parseOfficialApiExtractionRequest, stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { computeCacheKey } from "../../../../runs/compile-seed/cache/cache-key.js";
import { persistedResponseMetadata } from
  "../../../../runs/compile-seed/cache/cached-response-metadata.js";
import type { BenchProviderUsage } from "../../../../runs/compile-seed/compile-seed-types.js";
import { buildExtractionTransportProvenance } from
  "../../../../runs/extraction/transport-route.js";
import { TEST_PROVIDER_COMPLETION_METADATA } from "../extraction-cache-test-fixture.js";
import { composePartitionedExtraction } from
  "../../../../runs/compile-seed/http/garden-http-assertion-partition.js";

const model = "gpt-5.4-mini";
const requestProfile = "provider-default-v1";
const providerUrl = "https://example.test/v1";
const rawJson = '{"signals":[{}]}';

export function providerFixtureKey(label: string): string {
  return computeCacheKey(model, requestProfile, OFFICIAL_API_SYSTEM_PROMPT, userPrompt(label));
}

export async function providerShardFixture(input: {
  readonly label: string;
  readonly lineageDigest: string;
  readonly attemptOrdinal: number;
  readonly usage?: BenchProviderUsage;
}) {
  const prompt = userPrompt(input.label);
  const witness = await responseWitness(prompt, rawJson, input.usage);
  return {
    model, request_profile: requestProfile,
    cache_key: providerFixtureKey(input.label),
    raw_json: rawJson,
    transport_provenance: buildExtractionTransportProvenance({ providerUrl, model }),
    provider_attempt: {
      kind: "interactive" as const,
      attempt_ordinal: input.attemptOrdinal,
      authority_lineage_digest: input.lineageDigest,
      last_usage: input.usage ?? null
    },
    request_identity: { system_prompt: OFFICIAL_API_SYSTEM_PROMPT, user_prompt: prompt },
    provider_responses: [{ attempt_ordinal: input.attemptOrdinal, witness,
      usage: input.usage ?? null }],
    ...persistedResponseMetadata(TEST_PROVIDER_COMPLETION_METADATA, input.usage, true)
  };
}

export async function providerPartitionShardFixture(input: {
  readonly lineageDigest: string;
  readonly attemptOrdinals: readonly [number, number];
  readonly usage: BenchProviderUsage;
}) {
  const prompt = userPrompt("7");
  const request = parseOfficialApiExtractionRequest(JSON.parse(prompt));
  if (request.source_assertions.length !== 2) throw new Error("partition fixture requires two assertions");
  const responses = await Promise.all(request.source_assertions.map(async (assertion, index) => {
    const child = stringifyOfficialApiExtractionRequest(parseOfficialApiExtractionRequest({
      ...request, source_assertions: [assertion]
    }));
    const raw = JSON.stringify({ interpretations: [{ assertion_id: assertion.assertion_id,
      relations: [{ predicate: { text: assertion.text }, arguments: [], qualifiers: [] }] }] });
    return { attempt_ordinal: input.attemptOrdinals[index]!,
      witness: await responseWitness(child, raw, input.usage), usage: input.usage };
  }));
  const composed = composePartitionedExtraction(request, responses.map((row) => row.witness));
  const total = { inputTokens: input.usage.inputTokens * 2,
    outputTokens: input.usage.outputTokens * 2,
    totalTokens: input.usage.totalTokens * 2 };
  return {
    model, request_profile: requestProfile,
    cache_key: providerFixtureKey("7"),
    raw_json: composed,
    transport_provenance: buildExtractionTransportProvenance({ providerUrl, model }),
    provider_attempt: { kind: "interactive" as const,
      attempt_ordinal: input.attemptOrdinals[1],
      authority_lineage_digest: input.lineageDigest, last_usage: input.usage },
    request_identity: { system_prompt: OFFICIAL_API_SYSTEM_PROMPT, user_prompt: prompt },
    provider_responses: responses,
    ...persistedResponseMetadata({ finishReason: null,
      completionContractVersion: 1, completionWitness: "partition_composition" }, total, true)
  };
}

async function responseWitness(userPrompt: string, rawJson: string,
  usage?: BenchProviderUsage) {
  const response = Response.json({
    choices: [{ message: { content: rawJson }, finish_reason: "stop" }],
    ...(usage === undefined ? {} : { usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens
    } })
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { userPrompt, requestSha256: sha256(userPrompt), rawJson,
    httpResponse: { contentType: response.headers.get("content-type"),
      bodyBase64: bytes.toString("base64"), bodyByteLength: bytes.length,
      bodySha256: sha256(bytes), bodyTruncated: false, bodyComplete: true } };
}

function userPrompt(label: string): string {
  return stringifyOfficialApiExtractionRequest(
    buildOfficialApiExtractionRequest(label === "7"
      ? "Provider fixture 7 first. Provider fixture 7 second."
      : `Provider fixture ${label}.`, [])
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
