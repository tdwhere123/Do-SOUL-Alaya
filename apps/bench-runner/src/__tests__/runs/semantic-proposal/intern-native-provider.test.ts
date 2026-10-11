import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { INTERN_SEMANTIC_REQUEST_MODEL as MODEL, INTERN_SEMANTIC_REQUEST_PROFILE as PROFILE,
  INTERN_SEMANTIC_PROVIDER_URL as ENDPOINT, isChatSemanticRequestProfile } from "@do-soul/alaya-protocol";
import { buildProviderChatRequestBody, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES } from "@do-soul/alaya-engine-gateway";
import { probeProviderProtocol } from "../../../runs/provider/protocol-probe.js";
import { runProviderPreflightCommand } from "../../../cli/provider-preflight/command.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { parseSemanticProposalWorkset, materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";
import { executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { openSemanticProposalAttemptLedger, readSemanticProposalAttemptState, semanticProposalLookup } from "../../../runs/semantic-proposal/attempt.js";
import * as proposalAttempts from "../../../runs/semantic-proposal/attempt.js";
import { readSemanticProposalShard } from "../../../runs/semantic-proposal/artifact.js";
import { ledgerPath } from "../../../runs/extraction/authority/attempt-ledger.js";
import { settledAttemptUsageDigest } from "../../../runs/extraction/authority/attempt-ledger/outcome.js";
import { inspectPopulationAttemptScopes } from "../../../runs/longmemeval-semantic/population-attempts.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { INTERN_DISCOVERY_QUOTE_BASIS } from "../../../runs/extraction/authority/intern-quote.js";
import { isExtractionRequestProfile } from "../../../runs/extraction/request-profile.js";
import { supportsProviderRequestProfile } from "../../../runs/provider/catalog.js";
import { readProviderResponseWithEvidence } from "../../../../../../packages/engine-gateway/src/provider/chat-completion/response-evidence.js";
import { acquireExtractionCacheWriteLease } from "../../../runs/extraction/fill/manifest/fill-root-guard.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async (_host: string, options?: { all?: boolean }) => {
  const answer = { address: "93.184.216.34", family: 4 }; return options?.all ? [answer] : answer;
}) }));

const probeProfiles = [PROFILE, "intern-agents-a1-probe-json-object-v1", "intern-agents-a1-probe-json-schema-v1"] as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  vi.useRealTimers();
});

it("expires pending readiness DNS and releases the Q cache without spending an attempt", async () => {
  vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "0");
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v4", kind: "query",
    model: MODEL, request_profile: PROFILE, provider_url: ENDPOINT, items: [{ original_query: "Who sent the parcel?" }] });
  const cacheRoot = root(), authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(workset, cacheRoot, 8192), inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  const line = materializeSemanticProposalLines(workset, 8192)[0]!;
  let finishDns!: (answers: { address: string; family: number }[]) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(lookup).mockImplementationOnce((() => {
    entered(); return new Promise(resolve => { finishDns = resolve; });
  }) as unknown as typeof lookup);
  const fetchImpl = vi.fn<typeof fetch>(), config = { providerUrl: ENDPOINT, model: MODEL, requestProfile: PROFILE, apiKey: "loopback-only" };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const operation = executeSemanticProposalFill({ workset, cacheRoot, authority, config,
    extractor: createSemanticProviderHttpExtractor(config, "source_semantic_proposal", fetchImpl) })
    .then(() => "completed", error => error as unknown);
  await started;
  expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot().attempts).toBe(0);
  expect(readProviderRawAttempt(cacheRoot, line.key, 1)).toBeUndefined();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(() => acquireExtractionCacheWriteLease(cacheRoot)).toThrow();
  try {
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const settled = await Promise.race([operation, delay(150).then(() => "still_pending")]);
    expect(settled).toMatchObject({ kind: "timeout" });
    const lease = acquireExtractionCacheWriteLease(cacheRoot); lease.release();
    expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot())
      .toMatchObject({ attempts: 0, unresolvedAttempts: [], pendingKeys: [], settledAttempts: [], transportFailures: [] });
    expect(readProviderRawAttempt(cacheRoot, line.key, 1)).toBeUndefined();
    expect(readSemanticProposalShard(cacheRoot, line.key)).toBeUndefined();
    expect(readSemanticProposalResults(workset, cacheRoot, 8192)[0]?.status).toBe("unattempted");
  } finally { vi.useRealTimers(); finishDns([{ address: "93.184.216.34", family: 4 }]); await operation; }
  expect(fetchImpl).not.toHaveBeenCalled();
});
function root() {
  const value = mkdtempSync(join(tmpdir(), "intern-native-provider-")); roots.push(value); return value;
}

it.each(["blocked", "unresolved"])("refuses %s provider DNS before reserving a Q attempt", async failure => {
  vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "0");
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v4", kind: "query",
    model: MODEL, request_profile: PROFILE, provider_url: ENDPOINT, items: [{ original_query: "Who sent the parcel?" }] });
  const cacheRoot = root(), authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(workset, cacheRoot, 8192), inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  const line = materializeSemanticProposalLines(workset, 8192)[0]!;
  expect(line.key).toBe("77e3ea00dd2da1f3cd8b51cb7b8b1ddbbd5223a09a8aa15efe077362c0e85063");
  if (failure === "blocked") vi.mocked(lookup).mockImplementationOnce((async () => [
    { address: "198.18.0.105", family: 4 }
  ]) as unknown as typeof lookup);
  else vi.mocked(lookup).mockRejectedValueOnce(new Error("ENOTFOUND"));
  const fetchImpl = vi.fn<typeof fetch>();
  const config = { providerUrl: ENDPOINT, model: MODEL, requestProfile: PROFILE, apiKey: "loopback-only" };
  await expect(executeSemanticProposalFill({ workset, cacheRoot, authority, config,
    extractor: createSemanticProviderHttpExtractor(config, "source_semantic_proposal", fetchImpl) })).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot()).toMatchObject({
    attempts: 0, unresolvedAttempts: [], pendingKeys: [], settledAttempts: [], transportFailures: [] });
  expect(readProviderRawAttempt(cacheRoot, line.key, 1)).toBeUndefined();
  expect(readSemanticProposalShard(cacheRoot, line.key)).toBeUndefined();
  expect(readSemanticProposalResults(workset, cacheRoot, 8192)[0]?.status).toBe("unattempted");
});

it("executes an injected offline Q delegate without DNS and preserves its exact key", async () => {
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v4", kind: "query",
    model: MODEL, request_profile: PROFILE, provider_url: ENDPOINT, items: [{ original_query: "Who sent the parcel?" }] });
  const cacheRoot = root(), authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(workset, cacheRoot, 8192), inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  const line = materializeSemanticProposalLines(workset, 8192)[0]!;
  const rawJson = '{"contract":"source-semantic-query-response-v8","outcome":{"status":"abstained"}}';
  const retained = await readProviderResponseWithEvidence(new Response(JSON.stringify({
    choices: [{ message: { content: rawJson }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } }));
  const previous = vi.mocked(lookup).getMockImplementation()!;
  vi.mocked(lookup).mockClear().mockRejectedValue(new Error("ENOTFOUND"));
  try {
    const extractor = { extract: vi.fn(async () => ({ rawJson, responseMetadata: { finishReason: "stop" }, httpResponse: retained.evidence })) };
    await expect(executeSemanticProposalFill({ workset, cacheRoot, authority,
      config: { providerUrl: ENDPOINT, model: MODEL, requestProfile: PROFILE, apiKey: null }, extractor }))
      .resolves.toMatchObject({ abstained: 1, attempts: 1 });
    expect(lookup).not.toHaveBeenCalled(); expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(line.key).toBe("77e3ea00dd2da1f3cd8b51cb7b8b1ddbbd5223a09a8aa15efe077362c0e85063");
  } finally { vi.mocked(lookup).mockImplementation(previous); }
});

it("retains the reserved attempt if DNS becomes blocked between readiness and actual fetch", async () => {
  vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "0");
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v4", kind: "query",
    model: MODEL, request_profile: PROFILE, provider_url: ENDPOINT, items: [{ original_query: "Who sent the parcel?" }] });
  const cacheRoot = root(), authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(workset, cacheRoot, 8192), inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  const line = materializeSemanticProposalLines(workset, 8192)[0]!;
  vi.mocked(lookup).mockImplementationOnce((async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof lookup)
    .mockImplementationOnce((async () => [{ address: "198.18.0.105", family: 4 }]) as unknown as typeof lookup);
  const fetchImpl = vi.fn<typeof fetch>(), config = { providerUrl: ENDPOINT, model: MODEL, requestProfile: PROFILE, apiKey: "loopback-only" };
  await expect(executeSemanticProposalFill({ workset, cacheRoot, authority, config,
    extractor: createSemanticProviderHttpExtractor(config, "source_semantic_proposal", fetchImpl) })).rejects.toThrow(/stopped after/u);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot().attempts).toBe(1);
  expect(readProviderRawAttempt(cacheRoot, line.key, 1)).toMatchObject({ usage_known: false, usage: null,
    transport_failure: { kind: "network_error", phase: "request" } });
});

async function localHttp<T>(content: string | null, finish: string | null, status: number,
  run: (fetchImpl: typeof fetch, calls: Record<string, unknown>[], wire: string) => Promise<T>,
  extra?: { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; oversized?: boolean }): Promise<T> {
  const wire = status === 200 ? JSON.stringify({ choices: [{ message: {
    content, reasoning_content: '{"probe":true}' }, finish_reason: finish }],
      ...(extra?.usage === undefined ? {} : { usage: extra.usage }) }) +
      (extra?.oversized ? " ".repeat(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES + 1024) : "")
    : JSON.stringify({ error: { code: "quota_exceeded", message: "fixture quota" } });
  const calls: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(status, { "content-type": "application/json" }); response.end(wire);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  const fetchImpl: typeof fetch = (url, init) => {
    expect(String(url)).toBe(`${ENDPOINT}/chat/completions`);
    expect(init?.redirect).toBe("error");
    return nativeFetch(new URL(new URL(String(url)).pathname, origin), init);
  };
  try { return await run(fetchImpl, calls, wire); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

it.each(probeProfiles.flatMap(profile => [
  { content: '{"probe":true}', finish: "stop", valid: true },
  { content: "{invalid", finish: "stop", valid: false },
  { content: '{"probe":true,"extra":1}', finish: "stop", valid: false },
  { content: '{"probe":true}', finish: "length", valid: false },
  { content: null, finish: "stop", valid: false }
].map(row => ({ ...row, profile }))))("parses $profile final content and retains $finish evidence for $content", async ({ content, finish, valid, profile }) => {
  await localHttp(content, finish, 200, async (fetchImpl, calls, wire) => {
    const receipt = await probeProviderProtocol({ providerUrl: ENDPOINT, apiKey: "loopback-only",
      model: MODEL, ...(profile === PROFILE ? {} : { requestProfile: profile }), fetchImpl });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!).sort()).toEqual(profile === PROFILE
      ? ["max_tokens", "messages", "model"] : ["max_tokens", "messages", "model", "response_format"]);
    expect(calls[0]).toMatchObject({ model: MODEL, max_tokens: 8192 });
    const schemaPayload = '{"type":"object","properties":{"probe":{"type":"boolean"}},"required":["probe"],"additionalProperties":false}';
    expect(calls[0]!.response_format).toEqual(profile === PROFILE ? undefined :
      profile === "intern-agents-a1-probe-json-object-v1" ? { type: "json_object" } : {
        type: "json_schema", json_schema: { name: "provider_protocol_probe", strict: true,
          schema: JSON.parse(schemaPayload) }
      });
    expect(calls[0]!.messages).toEqual([
      { role: "system", content: 'Return JSON only.\n\nSchema identifier (metadata): "provider_protocol_probe"\n' +
        "Return only a JSON object conforming to this complete JSON Schema. Preserve every required field and constraint; the receiver validates the result.\n" + schemaPayload },
      { role: "user", content: '{"probe":true}' }
    ]);
    expect(receipt).toMatchObject({ json_schema_valid: valid, physical_calls: 1, profile,
      provider_url: ENDPOINT, usage_present: false, declared_bounds: {
        max_output_tokens: 8192, timeout_ms: 180000, maximum_attempts: 1 },
      http_response: { bodyBase64: Buffer.from(wire).toString("base64"), bodyComplete: true } });
    expect(receipt.request_digest).toBe(createHash("sha256")
      .update(JSON.stringify([`${ENDPOINT}/chat/completions`, JSON.stringify(calls[0])])).digest("hex"));
    expect(receipt.usage).toBeUndefined();
    const request = { providerUrl: ENDPOINT, apiKey: "loopback-only", model: MODEL,
      profile, systemPrompt: "s", userPrompt: "u", maxOutputTokens: 8192,
      jsonSchema: { name: "named", schema: { type: "object" } } };
    for (const invalid of [{ ...request, providerUrl: "https://chat.intern-ai.org.cn/v1" },
      { ...request, model: "intern-s2" }, { ...request, mode: "sse" as const },
      { ...request, maxOutputTokens: undefined }, { ...request, jsonSchema: undefined }]) {
      expect(() => buildProviderChatRequestBody(invalid)).toThrow(/Intern provider profile/u);
    }
  });
});

it.each(probeProfiles)("retains one quota failure for %s and emits the native CLI receipt with nonzero status", async profile => {
  await localHttp(null, null, 429, async (fetchImpl, calls, wire) => {
    vi.stubEnv("OFFICIAL_API_GARDEN_API_KEY", "loopback-only");
    vi.stubGlobal("fetch", fetchImpl);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runProviderPreflightCommand(["--mode", "probe", "--model", MODEL,
      "--provider-route", ENDPOINT, "--request-profile", profile])).toBe(2);
    const receipt = JSON.parse(String(output.mock.calls[0]![0]));
    expect(receipt).toMatchObject({ profile, physical_calls: 1, json_schema_valid: false, usage_present: false,
      failure: { kind: "http_error", http_status: 429, provider_code: "quota_exceeded" },
      http_response: { bodyBase64: Buffer.from(wire).toString("base64"), bodyComplete: true } });
    expect(calls).toHaveLength(1);
  });
});

it.each(probeProfiles.slice(1))("denies mismatched %s probe bindings without dispatch or semantic admission", async profile => {
  const fetchImpl = vi.fn<typeof fetch>();
  const input = { providerUrl: ENDPOINT, apiKey: "loopback-only", model: MODEL,
    requestProfile: profile, fetchImpl };
  for (const invalid of [{ ...input, model: "mimo-v2.5" },
    { ...input, requestProfile: "unknown-profile" },
    { ...input, framing: "sse" as const },
    { ...input, providerUrl: "https://chat.intern-ai.org.cn/v1" }]) {
    await expect(probeProviderProtocol(invalid)).rejects.toThrow();
  }
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(isChatSemanticRequestProfile(profile)).toBe(false);
  expect(isExtractionRequestProfile(profile)).toBe(false);
  expect(supportsProviderRequestProfile(MODEL, profile)).toBe(false);
  expect(() => parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v4", kind: "query",
    model: MODEL, request_profile: profile, provider_url: ENDPOINT,
    items: [{ original_query: "Who sent the parcel?" }] })).toThrow();
});

it.each(probeProfiles.slice(1))("retains reported usage and exact malformed final bytes for %s without repair", async profile => {
  await localHttp('```json\n{"probe":true}\n```', "stop", 200, async (fetchImpl, calls, wire) => {
    const receipt = await probeProviderProtocol({ providerUrl: ENDPOINT, apiKey: "loopback-only",
      model: MODEL, requestProfile: profile, fetchImpl });
    expect(receipt).toMatchObject({ profile, physical_calls: 1, json_object: false, json_schema_valid: false,
      usage_present: true, usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      http_response: { bodyComplete: true, bodyBase64: Buffer.from(wire).toString("base64") } });
    expect(calls).toHaveLength(1);
  }, { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
});

it.each(([PROFILE, "intern-agents-a1-json-schema-v1"] as const).flatMap(profile => [
  { content: '{"contract":"source-semantic-query-response-v8","outcome":{"status":"abstained"}}', finish: "stop" },
  { content: "{malformed", finish: "stop" }, { content: "partial", finish: "length" }
].map(row => ({ ...row, profile }))))(
  "retains one $profile Q $finish attempt and its terminal or abstained result on reopen", async ({ content, finish, profile }) => {
    const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v4", kind: "query",
      model: MODEL, request_profile: profile, provider_url: ENDPOINT,
      items: [{ original_query: "Who sent the parcel?" }] });
    const cacheRoot = root(), preflight = prepareSemanticProposal(workset, cacheRoot, 8192);
    expect(preflight).toMatchObject({ maximum_attempts: 1, maximum_attempts_per_key: 1,
      quote_basis: INTERN_DISCOVERY_QUOTE_BASIS });
    expect(() => prepareSemanticProposal(workset, root(), 8192, 2)).toThrow(/one attempt per key/u);
    expect(() => pinSemanticProposalAuthority({ preflight, inputUsdPerMillion: 1, outputUsdPerMillion: 0 }))
      .toThrow(/published zero/u);
    const authority = pinSemanticProposalAuthority({ preflight, inputUsdPerMillion: 0,
      outputUsdPerMillion: 0, spendCeilingUsd: 0 });
    expect(authority.price.estimated_upper_usd).toBe(0);
    expect(authority.price.maximum_input_tokens_per_attempt).toBeGreaterThan(0);
    const config = { providerUrl: ENDPOINT, model: MODEL, requestProfile: profile, apiKey: "loopback-only" };
    await localHttp(content, finish, 200, async (fetchImpl, calls, wire) => {
      const run = () => executeSemanticProposalFill({ workset, cacheRoot, authority, config,
        extractor: createSemanticProviderHttpExtractor(config, "source_semantic_proposal", fetchImpl) });
      if (finish === "length") { await expect(run()).rejects.toThrow(/stopped after incomplete/u); }
      else if (content === "{malformed") await expect(run()).rejects.toThrow(/stopped after retryable/u);
      else await run();
      const line = materializeSemanticProposalLines(workset, 8192)[0]!;
      const validate = new Ajv2020({ strict: false }).compile(line.responseJsonSchema);
      const envelope = { contract: "source-semantic-query-response-v8", outcome: { status: "interpreted" } };
      expect(validate(envelope)).toBe(false);
      expect(validate({ ...envelope, outcome: { status: "abstained" } })).toBe(true);
      expect(calls[0]!.response_format).toEqual(profile === PROFILE ? undefined : {
        type: "json_schema", json_schema: { name: "source_semantic_proposal", strict: true, schema: line.responseJsonSchema }
      });
      expect(calls[0]!.messages).toEqual([
        { role: "system", content: `${line.systemPrompt}\n\nSchema identifier (metadata): "source_semantic_proposal"\nReturn only a JSON object conforming to this complete JSON Schema. Preserve every required field and constraint; the receiver validates the result.\n${JSON.stringify(line.responseJsonSchema)}` },
        { role: "user", content: line.userPrompt }
      ]);
      const other = materializeSemanticProposalLines(parseSemanticProposalWorkset({ ...workset,
        request_profile: profile === PROFILE ? "intern-agents-a1-json-schema-v1" : PROFILE }), 8192)[0]!;
      expect(other.systemPrompt).toBe(line.systemPrompt);
      expect(other.userPrompt).toBe(line.userPrompt);
      expect(other.responseJsonSchema).toEqual(line.responseJsonSchema);
      expect(other.key).not.toBe(line.key);
      expect(other.requestDigest).not.toBe(line.requestDigest);
      expect(readProviderRawAttempt(cacheRoot, line.key, 1)).toMatchObject({ request_profile: profile,
        request_digest: line.requestDigest, decoded_text: content, usage_known: false, usage: null,
        http_response: { bodyBase64: Buffer.from(wire).toString("base64"), bodyComplete: true } });
      if (finish === "length") await expect(run()).rejects.toThrow(/retained incomplete/u);
      else if (content === "{malformed") await expect(run()).rejects.toThrow(/retained retryable/u);
      else await run();
      expect(calls).toHaveLength(1);
      expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot().attempts).toBe(1);
    });
  });

it.each([
  { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 13 }, crash: false },
  { usage: { prompt_tokens: 10, completion_tokens: 8193, total_tokens: 8203 }, crash: false },
  { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 13 }, crash: true }
])("settles invalid Q metering and recovers publication-before-settlement crash=$crash without dispatch", async ({ usage, crash }) => {
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v4", kind: "query",
    model: MODEL, request_profile: PROFILE, provider_url: ENDPOINT, items: [{ original_query: "Who sent the parcel?" }] });
  const cacheRoot = root(), authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(workset, cacheRoot, 8192), inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  const line = materializeSemanticProposalLines(workset, 8192)[0]!;
  const config = { providerUrl: ENDPOINT, model: MODEL, requestProfile: PROFILE, apiKey: "loopback-only" };
  const content = '{"contract":"source-semantic-query-response-v8","outcome":{"status":"abstained"}}';
  await localHttp(content, "stop", 200, async (fetchImpl, calls) => {
    const run = () => executeSemanticProposalFill({ workset, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, "source_semantic_proposal", fetchImpl) });
    if (crash) {
      const original = proposalAttempts.openSemanticProposalAttemptLedger;
      const spy = vi.spyOn(proposalAttempts, "openSemanticProposalAttemptLedger").mockImplementation(input => {
        const ledger = original(input);
        return { ...ledger, recordTransportOutcome: () => { throw new Error("injected before settlement"); } };
      });
      await expect(run()).rejects.toThrow(/injected before settlement/u);
      expect(readSemanticProposalAttemptState(cacheRoot, line.key, semanticProposalLookup(workset, line, 8192)).status).toBe("pending");
      expect(readSemanticProposalShard(cacheRoot, line.key)).toMatchObject({ outcome: { reason: "invalid_usage" }, admitted: false });
      spy.mockRestore();
    }
    await expect(run()).rejects.toThrow(/stopped after (retained )?terminal/u);
    const raw = readProviderRawAttempt(cacheRoot, line.key, 1)!;
    expect(raw).toMatchObject({ usage_known: true, usage: { inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens }, http_response: { bodyComplete: true } });
    expect(readSemanticProposalShard(cacheRoot, line.key)?.usage).toBeUndefined();
    const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
    expect(ledger.snapshot()).toMatchObject({ unresolvedAttempts: [], pendingKeys: [], successfulShards: 0,
      settledAttempts: [{ usageAccounting: "invalid", usageSha256: settledAttemptUsageDigest(raw.usage) }],
      telemetry: { inputTokens: 0, outputTokens: 0, totalTokens: 0, usageUnknownAttempts: 1, usageInvalidAttempts: 1 } });
    expect(readSemanticProposalAttemptState(cacheRoot, line.key, semanticProposalLookup(workset, line, 8192)).status).toBe("accounting_invalid");
    await expect(run()).rejects.toThrow(/retained terminal/u);
    expect(() => ledger.reserveAttemptOrdinal(line.key)).toThrow(/per-key attempt ceiling/u);
    expect(calls).toHaveLength(1);
    expect(inspectPopulationAttemptScopes([{ layer: "query", cacheRoot, model: MODEL,
      requestProfile: PROFILE, keys: [line.key], maxOutputTokens: 8192 }])).toMatchObject({
      observed_known_usage_attempts: 0, observed_invalid_usage_attempts: 1, scoped_unknown_usage_attempts: 1,
      actual_spend: null, attempts: [{ usage: null, usage_accounting: "invalid" }] });
    const path = ledgerPath(cacheRoot, authority.attempt_lineage_digest);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    delete stored.settled_attempts[0].usage_accounting;
    writeFileSync(path, JSON.stringify(stored));
    expect(() => readSemanticProposalAttemptState(cacheRoot, line.key, semanticProposalLookup(workset, line, 8192)))
      .toThrow(/lacks its invalid-accounting settlement/u);
  }, { usage });
});

it("rejects an oversized successful Q envelope, retaining partial bytes and terminal reopen without dispatch", async () => {
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v4", kind: "query",
    model: MODEL, request_profile: PROFILE, provider_url: ENDPOINT, items: [{ original_query: "Who sent the parcel?" }] });
  const cacheRoot = root(), authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(workset, cacheRoot, 8192), inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  const line = materializeSemanticProposalLines(workset, 8192)[0]!;
  const config = { providerUrl: ENDPOINT, model: MODEL, requestProfile: PROFILE, apiKey: "loopback-only" };
  await localHttp('{"contract":"source-semantic-query-response-v8","outcome":{"status":"abstained"}}', "stop", 200,
    async (fetchImpl, calls) => {
      const run = () => executeSemanticProposalFill({ workset, cacheRoot, authority, config,
        extractor: createSemanticProviderHttpExtractor(config, "source_semantic_proposal", fetchImpl) });
      await expect(run()).rejects.toThrow(/stopped after terminal/u);
      const raw = readProviderRawAttempt(cacheRoot, line.key, 1)!;
      expect(raw.http_response?.bodyComplete).toBe(false);
      expect(Buffer.from(raw.http_response!.bodyBase64, "base64")).toHaveLength(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES);
      expect(raw.decoded_text).toBe("");
      expect(raw.transport_failure?.kind).toBe("response_schema_error");
      expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot().unresolvedAttempts).toEqual([]);
      await expect(run()).rejects.toThrow(/retained empty/u);
      expect(calls).toHaveLength(1);
    }, { oversized: true });
});
