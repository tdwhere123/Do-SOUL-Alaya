import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { INTERN_SEMANTIC_REQUEST_MODEL as MODEL, INTERN_SEMANTIC_REQUEST_PROFILE as PROFILE,
  INTERN_SEMANTIC_PROVIDER_URL as ENDPOINT } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest, SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT, type SourceSemanticRequest } from "@do-soul/alaya-soul";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { createExtractionExecutionAuthority } from "../../../runs/extraction/fill/execution-authority.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { readCachedEntry } from "../../../runs/compile-seed/cache/cache-shard.js";
import { listProviderRawAttempts } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { preflightSourceSemanticInteractive, parseSourceSemanticInteractivePreflight } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { INTERN_DISCOVERY_QUOTE_BASIS } from "../../../runs/extraction/authority/intern-quote.js";
import { prepareSourceSemanticRequestWire } from "../../../runs/extraction/fill/source-semantic-interactive-request.js";
import { requestEnvelopeDigest } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { settledAttemptUsageDigest } from "../../../runs/extraction/authority/attempt-ledger/outcome.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";
import { tableCompletedResponse } from "./source-semantic-table-response.test-support.js";

let roots: { cacheRoot: string; dataDir: string; pinnedMetaRoot: string };
const writeDataset = registerExtractionFillHooks(value => { roots = value; }, "longmemeval_s");
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
});

async function scenario(projected = false) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", ENDPOINT);
  await writeDataset([buildExtractionFillQuestion("completed", "I completed alpha.", "I completed decoy.")]);
  const options = { ...roots, variant: "longmemeval_s" as const, sourcePacking: "complete-source" as const,
    openSemantics: { ...EXTRACTION_OPEN_SEMANTICS_GENERATION,
      ...(projected ? { generation_view_contract: SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT } : {}) }, concurrency: 1, log: () => undefined };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  const selected = inspection.missingKeys.slice(0, 1);
  const preflight = await preflightSourceSemanticInteractive({ ...options, preflightKeys: selected,
    preflightOutputTokenCap: 8192 });
  const receipt = createExtractionAuthorityReceipt({ action: "sample",
    sampleScope: createExtractionSampleScope(selected, inspection), observation: inspection.observation,
    inspection, maxConcurrency: 1, sourcePreflight: preflight,
    outputTokenCap: { field: "max_tokens", value: 8192 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0, outputUsdPerMillion: 0,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const receiptPath = join(roots.cacheRoot, "source-authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  return { options: { ...options, authorityReceiptPath: receiptPath }, selected, preflight, receipt };
}

async function listen(finish: "stop" | "length", valid = true,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  const calls: { body: Record<string, unknown>; wire: string }[] = [];
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const source: { source_request: Pick<SourceSemanticRequest["source_request"], "source_assertions"> } = JSON.parse(body.messages[1].content);
    const assertion = source.source_request.source_assertions.find(row => row.text.includes("completed"))!;
    const content = valid ? JSON.stringify(tableCompletedResponse(assertion.assertion_id,
      assertion.text.includes("alpha") ? "alpha" : "decoy")) : "{bad JSON";
    const wire = JSON.stringify({ choices: [{ message: { content, reasoning_content: "reasoning only" }, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }) });
    calls.push({ body, wire });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(wire);
  });

  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(String(url)).toBe(`${ENDPOINT}/chat/completions`);
    expect(init?.redirect).toBe("error");
    return nativeFetch(new URL(new URL(String(url)).pathname, localOrigin), init);
  });
  return calls;
}

it.each([{ prompt_tokens: 10, completion_tokens: 2, total_tokens: 13 },
  { prompt_tokens: 10, completion_tokens: 8193, total_tokens: 8203 }])(
  "closes contradictory H usage with immutable reported values and accounting-invalid quarantine", async usage => {
    const fixture = await scenario();
    const calls = await listen("stop", true, usage);
    await expect(runExtractionFill(fixture.options)).rejects.toThrow(/stopped after quarantined/u);
    const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
    expect(raw).toMatchObject({ usage_known: true, usage: { inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens }, http_response: { bodyComplete: true } });
    const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
    expect(reopened.snapshot()).toMatchObject({ unresolvedAttempts: [], pendingKeys: [], successfulShards: 0,
      settledAttempts: [{ attemptOrdinal: 1, usageAccounting: "invalid", usageSha256: settledAttemptUsageDigest(raw.usage) }],
      telemetry: { inputTokens: 0, outputTokens: 0, totalTokens: 0, usageUnknownAttempts: 1, usageInvalidAttempts: 1 } });
    await expect(runExtractionFill(fixture.options)).rejects.toThrow(/stopped after quarantined/u);
    await expect(reopened.reserveAttemptOrdinal!(raw.cache_key)).rejects.toThrow(/per-key attempt ceiling/u);
    expect(calls).toHaveLength(1);
    expect(inspectCachedSourceSemantic(roots.cacheRoot, raw.cache_key, MODEL, PROFILE).status).not.toBe("hit");
  });

it("binds free complete-source H to exact JSON wire, finite resource limits and retained unknown usage", async () => {
  const fixture = await scenario();
  expect(fixture.preflight.quote_basis).toMatchObject(INTERN_DISCOVERY_QUOTE_BASIS);
  expect(fixture.preflight.cost_bound_usd).toBe(0);
  expect(fixture.preflight.input_token_bound).toBeGreaterThan(0);
  expect(fixture.preflight.planned_requests[0]?.wire_sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(fixture.receipt.limits).toMatchObject({ maximum_attempts: 1, max_output_tokens: 8192 });
  const calls = await listen("stop");
  const filled = await runExtractionFill(fixture.options);
  expect(filled.newlyExtracted).toBe(1);
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0]!.body).sort()).toEqual(["max_tokens", "messages", "model"]);
  expect(calls[0]!.body).toMatchObject({ model: MODEL, max_tokens: 8192 });
  const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
  expect(raw).toMatchObject({ request_profile: PROFILE, finish_reason: "stop", usage: null, usage_known: false,
    request_digest: fixture.preflight.planned_requests[0]!.request_digest,
    http_response: { bodyBase64: Buffer.from(calls[0]!.wire).toString("base64"), bodyComplete: true } });
  const cached = readCachedEntry(roots.cacheRoot, fixture.selected[0]!, MODEL, PROFILE);
  expect(cached.status === "hit" && cached.entry.source_semantic?.kind).toBe("intern_chat_completion");
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL, PROFILE).status).toBe("hit");
  const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
  expect(reopened.snapshot()?.telemetry).toMatchObject({ usageUnknownAttempts: 1 });
  await expect(reopened.reserveAttemptOrdinal!(fixture.selected[0]!)).rejects.toThrow(/per-key attempt ceiling/u);
  await runExtractionFill(fixture.options);
  expect(calls).toHaveLength(1);
  expect(() => parseSourceSemanticInteractivePreflight({ ...fixture.preflight,
    max_output_tokens: 4096 })).toThrow(/encoded wire/u);
});

it("sends the independently expected view through preflight, actual HTTP, retained raw and reopened cache", async () => {
  const fixture = await scenario(true), retained = fixture.preflight.planned_requests[0]!;
  const host = parseSourceSemanticRequest(JSON.parse(retained.userPrompt));
  const sourceText = retained.userPrompt.includes("alpha") ? "User: I completed alpha." : "User: I completed decoy.";
  const expectedView = { contract: "source-semantic-generation-view-v1", source_request: {
    source_scope: "complete-source", resource_limits: { output_byte_limit: 1048576 },
    attribution_context: { contract: "utterance-attribution-v1", status: "unknown" }, source_assertions: [
      { assertion_id: 1, text: sourceText, source_role: "user" },
      ...(sourceText.includes("alpha") ? [{ assertion_id: 2, text: "Assistant: Acknowledged.", source_role: "assistant" }] : [])
    ]
  } };
  const wire = prepareSourceSemanticRequestWire({ ...fixture.preflight.config, openSemantics: fixture.options.openSemantics }, retained, 8192);
  expect(host.source_request.generation_view_contract).toBe(SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT);
  expect(host.source_request.assertion_locations).toHaveLength(sourceText.includes("alpha") ? 2 : 1);
  expect(JSON.parse(wire.body).messages[1].content).toBe(JSON.stringify(expectedView));
  const calls = await listen("stop");
  const filled = await runExtractionFill(fixture.options);
  expect(filled.newlyExtracted).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toEqual(JSON.parse(wire.body));
  expect(retained.request_digest).toBe(requestEnvelopeDigest(JSON.stringify([wire.url.href, wire.body])));
  const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
  expect(raw).toMatchObject({ source_request_sha256: retained.requestSha256 });
  expect(raw.request_digest).toBe(retained.request_digest);
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL, PROFILE).status).toBe("hit");
  await runExtractionFill(fixture.options);
  expect(calls).toHaveLength(1);
  expect(() => parseSourceSemanticInteractivePreflight({ ...fixture.preflight,
    config: { ...fixture.preflight.config, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION } })).toThrow(/view differs/u);
});

it.each([{ finish: "length", valid: true }, { finish: "stop", valid: false }] as const)(
  "retains and quarantines $finish H response without another attempt", async ({ finish, valid }) => {
    const fixture = await scenario();
    const calls = await listen(finish, valid);
    await expect(runExtractionFill(fixture.options)).rejects.toThrow(/stopped after quarantined/u);
    expect(calls).toHaveLength(1);
    const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
    expect(raw.finish_reason).toBe(finish);
    expect(raw.http_response?.bodyBase64).toBe(Buffer.from(calls[0]!.wire).toString("base64"));
    expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL, PROFILE).status).not.toBe("hit");
    await expect(runExtractionFill(fixture.options)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
