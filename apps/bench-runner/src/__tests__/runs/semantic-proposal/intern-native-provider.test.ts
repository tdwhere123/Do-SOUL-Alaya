import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { INTERN_SEMANTIC_REQUEST_MODEL as MODEL, INTERN_SEMANTIC_REQUEST_PROFILE as PROFILE,
  INTERN_SEMANTIC_PROVIDER_URL as ENDPOINT } from "@do-soul/alaya-protocol";
import { buildProviderChatRequestBody, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES } from "@do-soul/alaya-engine-gateway";
import { probeProviderProtocol } from "../../../runs/provider/protocol-probe.js";
import { runProviderPreflightCommand } from "../../../cli/provider-preflight/command.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { parseSemanticProposalWorkset, materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { openSemanticProposalAttemptLedger, readSemanticProposalAttemptState, semanticProposalLookup } from "../../../runs/semantic-proposal/attempt.js";
import * as proposalAttempts from "../../../runs/semantic-proposal/attempt.js";
import { readSemanticProposalShard } from "../../../runs/semantic-proposal/artifact.js";
import { ledgerPath } from "../../../runs/extraction/authority/attempt-ledger.js";
import { settledAttemptUsageDigest } from "../../../runs/extraction/authority/attempt-ledger/outcome.js";
import { inspectPopulationAttemptScopes } from "../../../runs/longmemeval-semantic/population-attempts.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { INTERN_DISCOVERY_QUOTE_BASIS } from "../../../runs/extraction/authority/intern-quote.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
function root() {
  const value = mkdtempSync(join(tmpdir(), "intern-native-provider-")); roots.push(value); return value;
}

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

it.each([
  { content: '{"probe":true}', finish: "stop", valid: true },
  { content: "{invalid", finish: "stop", valid: false },
  { content: '{"probe":true,"extra":1}', finish: "stop", valid: false },
  { content: '{"probe":true}', finish: "length", valid: false },
  { content: null, finish: "stop", valid: false }
])("parses probe final content and retains $finish evidence for $content", async ({ content, finish, valid }) => {
  await localHttp(content, finish, 200, async (fetchImpl, calls, wire) => {
    const receipt = await probeProviderProtocol({ providerUrl: ENDPOINT, apiKey: "loopback-only",
      model: MODEL, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!).sort()).toEqual(["max_tokens", "messages", "model"]);
    expect(calls[0]).toMatchObject({ model: MODEL, max_tokens: 8192 });
    const schemaPayload = '{"type":"object","properties":{"probe":{"type":"boolean"}},"required":["probe"],"additionalProperties":false}';
    expect(calls[0]!.messages).toEqual([
      { role: "system", content: 'Return JSON only.\n\nSchema identifier (metadata): "provider_protocol_probe"\n' +
        "Return only a JSON object conforming to this complete JSON Schema. Preserve every required field and constraint; the receiver validates the result.\n" + schemaPayload },
      { role: "user", content: '{"probe":true}' }
    ]);
    expect(receipt).toMatchObject({ json_schema_valid: valid, physical_calls: 1, profile: PROFILE,
      provider_url: ENDPOINT, usage_present: false, declared_bounds: {
        max_output_tokens: 8192, timeout_ms: 180000, maximum_attempts: 1 },
      http_response: { bodyBase64: Buffer.from(wire).toString("base64"), bodyComplete: true } });
    expect(receipt.request_digest).toBe(createHash("sha256")
      .update(JSON.stringify([`${ENDPOINT}/chat/completions`, JSON.stringify(calls[0])])).digest("hex"));
    expect(receipt.usage).toBeUndefined();
    const request = { providerUrl: ENDPOINT, apiKey: "loopback-only", model: MODEL,
      profile: PROFILE, systemPrompt: "s", userPrompt: "u", maxOutputTokens: 8192,
      jsonSchema: { name: "named", schema: { type: "object" } } };
    for (const invalid of [{ ...request, providerUrl: "https://chat.intern-ai.org.cn/v1" },
      { ...request, model: "intern-s2" }, { ...request, mode: "sse" as const },
      { ...request, maxOutputTokens: undefined }, { ...request, jsonSchema: undefined }]) {
      expect(() => buildProviderChatRequestBody(invalid)).toThrow(/Intern semantic profile/u);
    }
  });
});

it("retains one quota failure and emits the native CLI receipt with nonzero status", async () => {
  await localHttp(null, null, 429, async (fetchImpl, calls, wire) => {
    vi.stubEnv("OFFICIAL_API_GARDEN_API_KEY", "loopback-only");
    vi.stubGlobal("fetch", fetchImpl);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runProviderPreflightCommand(["--mode", "probe", "--model", MODEL,
      "--provider-route", ENDPOINT])).toBe(2);
    const receipt = JSON.parse(String(output.mock.calls[0]![0]));
    expect(receipt).toMatchObject({ physical_calls: 1, json_schema_valid: false, usage_present: false,
      failure: { kind: "http_error", http_status: 429, provider_code: "quota_exceeded" },
      http_response: { bodyBase64: Buffer.from(wire).toString("base64"), bodyComplete: true } });
    expect(calls).toHaveLength(1);
  });
});

it.each([{ content: '{"contract":"source-semantic-query-response-v8","outcome":{"status":"abstained"}}', finish: "stop" },
  { content: "{malformed", finish: "stop" }, { content: "partial", finish: "length" }])(
  "retains one Q $finish attempt and its terminal or abstained result on reopen", async ({ content, finish }) => {
    const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v4", kind: "query",
      model: MODEL, request_profile: PROFILE, provider_url: ENDPOINT,
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
    const config = { providerUrl: ENDPOINT, model: MODEL, requestProfile: PROFILE, apiKey: "loopback-only" };
    await localHttp(content, finish, 200, async (fetchImpl, calls, wire) => {
      const run = () => executeSemanticProposalFill({ workset, cacheRoot, authority, config,
        extractor: createSemanticProviderHttpExtractor(config, "source_semantic_proposal", fetchImpl) });
      if (finish === "length") { await expect(run()).rejects.toThrow(/stopped after incomplete/u); }
      else if (content === "{malformed") await expect(run()).rejects.toThrow(/stopped after retryable/u);
      else await run();
      const line = materializeSemanticProposalLines(workset, 8192)[0]!;
      expect(readProviderRawAttempt(cacheRoot, line.key, 1)).toMatchObject({ request_profile: PROFILE,
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
