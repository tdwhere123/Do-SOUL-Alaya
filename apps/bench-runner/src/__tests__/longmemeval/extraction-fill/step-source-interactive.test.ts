import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseSourceSemanticRequest, sourceSemanticRequestCatalog } from "@do-soul/alaya-soul";
import { MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES } from "@do-soul/alaya-engine-gateway";
import { openReadOnlyDatabase } from "@do-soul/alaya-storage";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from
  "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from
  "../../../runs/extraction/authority/receipt.js";
import { createExtractionExecutionAuthority } from "../../../runs/extraction/fill/execution-authority.js";
import { assertStepSourcePreflightReceipt } from "../../../runs/extraction/authority/source-preflight-binding.js";
import { STEP_PLAN_QUOTE_BASIS, assertStepReportedUsage } from "../../../runs/extraction/authority/step-quote.js";
import { inspectCachedSourceSemantic, inspectRetainedCachedSourceSemantic } from
  "../../../runs/extraction/cache/source-semantic-artifact.js";
import { listProviderRawAttempts, providerRawAttemptPath, readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { parseSourceSemanticInteractivePreflight, preflightSourceSemanticInteractive } from
  "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";
import { tableCompletedResponse } from "./source-semantic-table-response.test-support.js";

const MODEL = "step-3.5-flash-2603";
const PROFILE = "step-3.5-2603-low-json-schema-v1";
let roots: { cacheRoot: string; dataDir: string; pinnedMetaRoot: string };
const writeDataset = registerExtractionFillHooks(value => { roots = value; }, "longmemeval_s");
let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
});

function responseFor(userPrompt: string): string {
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions.find(row => row.text.includes("completed"))!;
  const theme = assertion.text.includes("alpha") ? "alpha" : "decoy";
  return JSON.stringify(tableCompletedResponse(assertion.assertion_id, theme));
}

async function scenario(selectedCount: number, outputTokenCap?: number, logicalModel = MODEL) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", logicalModel);
  if (logicalModel !== MODEL) vi.stubEnv("ALAYA_BENCH_EXTRACTION_TRANSPORT_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  await writeDataset(Array.from({ length: 3 }, (_, i) => buildExtractionFillQuestion(
    `step-q${i}`, `I completed alpha. The record is ${i}.`,
    `I completed decoy. The record is ${i}.`
  )));
  const options = { ...roots, variant: "longmemeval_s" as const,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    concurrency: 1, log: () => undefined };
  const inspection = await inspectExtractionAuthority({ ...options,
    action: "sample", revision: readCurrentExtractionAuthorityRevision() });
  const selected = inspection.missingKeys.slice(0, selectedCount);
  expect(selected).toHaveLength(selectedCount);
  const preflight = await preflightSourceSemanticInteractive({ ...options, cacheRoot: roots.cacheRoot,
    preflightKeys: selected,
    ...(outputTokenCap === undefined ? {} : { preflightOutputTokenCap: outputTokenCap }) });
  expect(preflight).toMatchObject({
    contract: "source-semantic-interactive-preflight-v3", provider_calls: 0,
    selected_requests: selectedCount, maximum_attempts_per_key: 1, max_output_tokens: outputTokenCap ?? 4096,
    output_token_field: "max_tokens", quote_basis: STEP_PLAN_QUOTE_BASIS
  });
  expect(preflight.planned_requests.map(row => row.key).sort()).toEqual([...selected].sort());
  expect(parseSourceSemanticInteractivePreflight(JSON.parse(JSON.stringify(preflight)))).toEqual(preflight);
  const scope = createExtractionSampleScope(selected, inspection);
  const receiptInput = { action: "sample" as const, sampleScope: scope,
    observation: inspection.observation, inspection, maxConcurrency: 1,
    sourcePreflight: preflight,
    outputTokenCap: { field: "max_tokens", value: outputTokenCap ?? 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
      outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } } as const;
  const receipt = createExtractionAuthorityReceipt(receiptInput);
  expect(receipt.limits.maximum_attempts).toBe(selectedCount);
  expect(receipt.price.quote_basis).toEqual(preflight.quote_basis);
  const receiptPath = join(roots.cacheRoot, "step-sample-authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  return { options: { ...options, authorityReceiptPath: receiptPath }, selected, preflight, receipt,
    receiptInput };
}

it("reopens a configured logical model alias through its recorded Step transport", async () => {
  const logicalModel = "fixture-step-alias";
  const fixture = await scenario(1, undefined, logicalModel);
  const http = await listen(body => ({
    text: responseFor((body.messages as { content: string }[])[1]!.content), finish: "stop"
  }));
  await runExtractionFill(fixture.options);
  expect(http.calls).toHaveLength(1);
  expect(http.calls[0]!.body.model).toBe(MODEL);
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, logicalModel, PROFILE))
    .toMatchObject({ status: "hit", transportProvenance: { model: MODEL } });
  await runExtractionFill(fixture.options);
  expect(http.calls).toHaveLength(1);
});

it("rejects complete Step HTTP bytes that contradict normalized finish and usage", async () => {
  const fixture = await scenario(1);
  const http = await listen(body => ({
    text: responseFor((body.messages as { content: string }[])[1]!.content), finish: "stop"
  }));
  await runExtractionFill(fixture.options);
  const key = fixture.selected[0]!;
  const rawPath = providerRawAttemptPath(roots.cacheRoot, key, 1);
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  expect(readProviderRawAttempt(roots.cacheRoot, key, 1)?.finish_reason).toBe("stop");
  const original = Buffer.from(raw.http_response.bodyBase64, "base64").toString("utf8");
  const changed = original.replace('"finish_reason":"stop"', '"finish_reason":"length"')
    .replace('"prompt_tokens":11', '"prompt_tokens":110')
    .replace('"total_tokens":18', '"total_tokens":117');
  expect(changed).not.toBe(original);
  const bytes = Buffer.from(changed);
  raw.http_response.bodyBase64 = bytes.toString("base64");
  raw.http_response.bodyByteLength = bytes.length;
  raw.http_response.bodySha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(rawPath, `${JSON.stringify(raw)}\n`);
  expect(inspectCachedSourceSemantic(roots.cacheRoot, key, MODEL, PROFILE))
    .toMatchObject({ status: "invalid", reason: expect.stringContaining("physical response differs") });
  expect(() => readProviderRawAttempt(roots.cacheRoot, key, 1)).toThrow(/physical response differs/u);
  expect(() => createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot))
    .toThrow(/successful shard closure drifted/u);
  expect(http.calls).toHaveLength(1);
});

async function listen(
  onRequest: (body: Record<string, unknown>, index: number) =>
    { text: string; finish: string; usage?: Record<string, unknown>; padding?: string }
) {
  const calls: { path: string | undefined; body: Record<string, unknown>; wire: string }[] = [];
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const answer = onRequest(body, calls.length);
    const wire = `data: ${JSON.stringify({ choices: [{
      delta: { content: answer.text }, finish_reason: answer.finish
    }], usage: answer.usage ?? { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 4 } } })}\n\ndata: [DONE]\n\n${answer.padding ?? ""}`;
    calls.push({ path: request.url, body, wire });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(wire);
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  const intercepted = vi.fn<typeof fetch>((url, init) => {
    const selected = new URL(String(url));
    expect(selected.origin).toBe("https://api.stepfun.com");
    return nativeFetch(new URL(selected.pathname + selected.search, origin), init);
  });
  vi.stubGlobal("fetch", intercepted);
  return { calls, intercepted };
}

it("withholds a truncated Step source response from reuse and SQLite publication after one attempt", async () => {
  vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "1");
  const fixture = await scenario(2);
  const http = await listen((body, index) => ({
    text: responseFor((body.messages as { content: string }[])[1]!.content), finish: "stop",
    ...(index === 1 ? { padding: " ".repeat(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES) } : {})
  }));
  await expect(runExtractionFill(fixture.options)).rejects.toThrow(/stopped after quarantined/u);
  expect(http.calls).toHaveLength(2);
  const [completeKey, truncatedKey] = fixture.selected;
  const complete = listProviderRawAttempts(roots.cacheRoot, completeKey!)[0]!;
  const truncated = listProviderRawAttempts(roots.cacheRoot, truncatedKey!)[0]!;
  expect(complete.http_response).toMatchObject({ bodyComplete: true, bodyTruncated: false });
  expect(truncated.http_response).toMatchObject({ bodyComplete: true, bodyTruncated: true });
  expect(inspectCachedSourceSemantic(roots.cacheRoot, completeKey!, MODEL, PROFILE).status).toBe("hit");
  expect(inspectCachedSourceSemantic(roots.cacheRoot, truncatedKey!, MODEL, PROFILE).status).not.toBe("hit");
  const rawPath = providerRawAttemptPath(roots.cacheRoot, truncatedKey!, truncated.attempt_ordinal);
  const rawBytes = readFileSync(rawPath);
  const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot).snapshot()!;
  expect(reopened).toMatchObject({ attempts: 2, successfulShards: 1 });
  await expect(runExtractionFill(fixture.options)).rejects.toThrow(/stopped after quarantined/u);
  expect(http.calls).toHaveLength(2);
  expect(readFileSync(rawPath).equals(rawBytes)).toBe(true);
  expect(createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot).snapshot()).toEqual(reopened);

  const census = await censusCompleteSourceRecords({ population: "fixture", dataDir: roots.dataDir,
    pinnedMetaRoot: roots.pinnedMetaRoot });
  const associations = fixture.preflight.planned_requests.flatMap(line => {
    const sourceDigest = sourceSemanticRequestCatalog(parseSourceSemanticRequest(JSON.parse(line.userPrompt))).source_digest;
    return census.records.filter(source => source.corpus_digest === sourceDigest).map(source => ({
      source_id: source.source_id, source_version: source.source_version,
      generation_key: line.key, request_digest: line.requestSha256
    }));
  });
  expect(associations).toHaveLength(2);
  const snapshotPath = join(roots.cacheRoot, "step-truncated-publication.sqlite");
  const published = await publishSourceSemanticSnapshot({ snapshotPath,
    dataDirRoot: join(roots.cacheRoot, "step-truncated-publication"),
    recordedAt: "2026-09-25T00:00:00.000Z", producerCommit: "a".repeat(40),
    populations: [{ name: "fixture", dataDir: roots.dataDir, pinnedMetaRoot: roots.pinnedMetaRoot,
      cacheRoots: [roots.cacheRoot], model: MODEL, requestProfile: PROFILE,
      publicationAssociations: associations }] });
  expect(published.published_count).toBe(1);
  const database = openReadOnlyDatabase(snapshotPath);
  try {
    expect(database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules").get()).toEqual({ n: 1 });
  } finally { database.close(); }
});

it("binds a four-key Step sample to exact HTTP bytes and stops after its first incomplete response", async () => {
  const fixture = await scenario(4);
  const http = await listen((body) => {
    const userPrompt = (body.messages as { content: string }[])[1]!.content;
    return { text: responseFor(userPrompt), finish: "length" };
  });
  await expect(runExtractionFill(fixture.options)).rejects.toThrow(/stopped after quarantined/u);
  expect(http.calls).toHaveLength(1);
  expect(http.calls[0]).toMatchObject({ path: "/step_plan/v1/chat/completions",
    body: { model: MODEL, reasoning_effort: "low", max_tokens: 4096, stream: true,
      response_format: { type: "json_schema", json_schema: { strict: true } } } });
  const raws = fixture.selected.flatMap(key => listProviderRawAttempts(roots.cacheRoot, key));
  expect(raws).toHaveLength(1);
  const raw = raws[0]!;
  const received = Buffer.from(http.calls[0]!.wire);
  expect(raw).toMatchObject({ contract: "provider-raw-attempt-v3", finish_reason: "length",
    request_digest: fixture.preflight.planned_requests.find(row => row.key === raw.cache_key)!.request_digest,
    http_response: { bodyBase64: received.toString("base64"), bodyByteLength: received.length,
      bodySha256: createHash("sha256").update(received).digest("hex"), bodyComplete: true },
    usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, reasoningOutputTokens: 4 } });
  expect(fixture.selected.slice(1).every(key => listProviderRawAttempts(roots.cacheRoot, key).length === 0)).toBe(true);
  const reopenedAuthority = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
  await expect(reopenedAuthority.reserveAttemptOrdinal!(raw.cache_key)).rejects.toThrow(/per-key attempt ceiling/u);
  expect(reopenedAuthority.snapshot()?.attempts).toBe(1);
  vi.stubEnv("E0_TEST_GARDEN_KEY", "");
  expect(readProviderRawAttempt(roots.cacheRoot, raw.cache_key, 1)).toEqual(raw);
  await expect(runExtractionFill(fixture.options)).rejects.toThrow();
  expect(http.calls).toHaveLength(1);
});

it("binds an explicit source cap to encoded HTTP, retained bounds, receipt price, and the reopened attempt", async () => {
  const fixture = await scenario(1, 16384);
  const http = await listen(body => ({
    text: responseFor((body.messages as { content: string }[])[1]!.content), finish: "stop"
  }));
  await runExtractionFill(fixture.options);
  expect(http.calls).toHaveLength(1);
  expect(http.calls[0]!.body.max_tokens).toBe(16384);
  const line = fixture.preflight.planned_requests[0]!;
  const encodedInputUpper = Buffer.byteLength(JSON.stringify(http.calls[0]!.body), "utf8") + 256;
  expect(line.input_byte_upper).toBe(encodedInputUpper);
  expect(fixture.preflight.maximum_input_tokens_per_attempt).toBe(encodedInputUpper);
  expect(fixture.preflight.input_token_bound).toBe(encodedInputUpper);
  expect(fixture.preflight.cost_bound_usd).toBe((
    encodedInputUpper * STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million +
    16384 * STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million
  ) / 1_000_000);
  expect(fixture.receipt.limits.max_output_tokens).toBe(16384);
  expect(fixture.receipt.source_preflight_digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(assertStepSourcePreflightReceipt(fixture.preflight, fixture.receipt)).toEqual(fixture.preflight);
  expect(() => assertStepSourcePreflightReceipt({ ...fixture.preflight,
    max_output_tokens: 4096 }, fixture.receipt)).toThrow();
  expect(fixture.receipt.price.estimated_upper_usd).toBe(fixture.preflight.cost_bound_usd);
  const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
  expect(raw.request_digest).toBe(line.request_digest);
  expect(raw.finish_reason).toBe("stop");
  const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
  expect(reopened.snapshot()?.attempts).toBe(1);
  await expect(reopened.reserveAttemptOrdinal!(raw.cache_key)).rejects.toThrow(/per-key attempt ceiling/u);
});

it("rejects a Step sample authority whose cap, input reservation, or selected proof differs before dispatch", async () => {
  const fixture = await scenario(1, 16384);
  expect(() => createExtractionAuthorityReceipt({ ...fixture.receiptInput,
    outputTokenCap: { field: "max_tokens", value: 4096 } })).toThrow(/differs from its retained source preflight/u);
  expect(() => createExtractionAuthorityReceipt({ ...fixture.receiptInput,
    priceEstimate: { ...fixture.receiptInput.priceEstimate,
      maximumInputTokensPerAttempt: fixture.preflight.maximum_input_tokens_per_attempt - 1 } }))
    .toThrow(/differs from its retained source preflight/u);
  expect(() => createExtractionAuthorityReceipt({ ...fixture.receiptInput,
    sourcePreflight: { ...fixture.preflight, selected_keys: ["f".repeat(64)] } }))
    .toThrow(/foreign ready key/u);
  expect(() => createExtractionAuthorityReceipt({ ...fixture.receiptInput,
    sourcePreflight: { ...fixture.preflight, config: { ...fixture.preflight.config,
      providerUrl: "https://logical-other.example.test/v1",
      transportProviderUrl: fixture.preflight.config.providerUrl } } }))
    .toThrow(/differs from its retained source preflight/u);
  expect(() => createExtractionAuthorityReceipt({ ...fixture.receiptInput,
    sourcePreflight: { ...fixture.preflight, config: { ...fixture.preflight.config,
      modelFamily: "different-logical-family" } } }))
    .toThrow(/differs from its retained source preflight/u);
  expect(() => createExtractionAuthorityReceipt({ ...fixture.receiptInput,
    sourcePreflight: undefined })).toThrow(/requires its retained source preflight/u);
});

it("rejects altered retained Step preflight wire, route, and selected-key proof", async () => {
  const { preflight } = await scenario(1);
  expect(() => parseSourceSemanticInteractivePreflight({ ...preflight,
    planned_requests: [{ ...preflight.planned_requests[0], request_digest: "f".repeat(64) }] }))
    .toThrow(/encoded wire/u);
  expect(() => parseSourceSemanticInteractivePreflight({ ...preflight,
    config: { ...preflight.config, transportProviderUrl: "https://api.stepfun.com/v1" } }))
    .toThrow(/selected subscription endpoint/u);
  expect(() => parseSourceSemanticInteractivePreflight({ ...preflight,
    selected_keys: ["f".repeat(64)] })).toThrow(/foreign ready key/u);
  expect(() => parseSourceSemanticInteractivePreflight({ ...preflight,
    max_output_tokens: 16384 })).toThrow(/encoded wire/u);
  expect(() => parseSourceSemanticInteractivePreflight({ ...preflight,
    contract: "source-semantic-interactive-preflight-v1" })).toThrow();
});

it.each([null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  "rejects an invalid explicit Step source output cap %s before preparation", async cap => {
    await expect(preflightSourceSemanticInteractive({ variant: "longmemeval_s", cacheRoot: "unused",
      sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
      preflightOutputTokenCap: cap as unknown as number })).rejects.toThrow();
  });

it("retains contradictory Step usage before refusing settlement or another request", async () => {
  const fixture = await scenario(4);
  const http = await listen(body => ({
    text: responseFor((body.messages as { content: string }[])[1]!.content), finish: "stop",
    usage: { prompt_tokens: 11, completion_tokens: 4097, total_tokens: 4108 }
  }));
  await expect(runExtractionFill(fixture.options)).rejects.toThrow(/reported usage contradicts/u);
  expect(http.calls).toHaveLength(1);
  const raw = fixture.selected.flatMap(key => listProviderRawAttempts(roots.cacheRoot, key))[0]!;
  expect(raw).toMatchObject({ usage: { inputTokens: 11, outputTokens: 4097, totalTokens: 4108 },
    http_response: { bodyComplete: true } });
  const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
  expect(reopened.snapshot()?.unresolvedAttempts).toContainEqual({
    cacheKey: raw.cache_key, attemptOrdinal: 1
  });
  await expect(reopened.reserveAttemptOrdinal!(raw.cache_key)).rejects.toThrow(/per-key attempt ceiling/u);
  expect(http.calls).toHaveLength(1);
});

it.each([
  { inputTokens: 8, outputTokens: 3, totalTokens: 11, cachedInputTokens: 9 },
  { inputTokens: 8, outputTokens: 3, totalTokens: 11, reasoningOutputTokens: 4 },
  { inputTokens: 8, outputTokens: 3, totalTokens: 12 }
])("rejects contradictory inclusive usage dimensions", usage => {
  expect(() => assertStepReportedUsage(PROFILE, usage, 4096)).toThrow(/reported usage contradicts/u);
});

it("reopens a successful Step source interpretation without a second HTTP request", async () => {
  const fixture = await scenario(1);
  const http = await listen((body) => {
    const userPrompt = (body.messages as { content: string }[])[1]!.content;
    return { text: responseFor(userPrompt), finish: "stop" };
  });
  const filled = await runExtractionFill(fixture.options);
  expect(filled.newlyExtracted).toBe(1);
  expect(http.calls).toHaveLength(1);
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL, PROFILE).status).toBe("hit");
  expect(inspectRetainedCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL, PROFILE))
    .toMatchObject({ status: "retired", eligibility: "retained_only" });
  vi.stubEnv("E0_TEST_GARDEN_KEY", "");
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL, PROFILE).status).toBe("hit");
  expect(listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]?.http_response?.bodyComplete).toBe(true);
  await expect(runExtractionFill(fixture.options)).rejects.toThrow(/credentials are unavailable/u);
  expect(http.calls).toHaveLength(1);
  vi.stubEnv("E0_TEST_GARDEN_KEY", "test-key");
  await runExtractionFill(fixture.options);
  expect(http.calls).toHaveLength(1);
});

it("retains bytes received before caller cancellation and spends no second Step slot", async () => {
  const fixture = await scenario(1);
  const controller = new AbortController();
  const prefix = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  let calls = 0;
  server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the real HTTP request */ }
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(prefix);
    setTimeout(() => controller.abort(), 80);
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((url, init) =>
    nativeFetch(new URL(new URL(String(url)).pathname, origin), init)));
  await expect(runExtractionFill({ ...fixture.options, signal: controller.signal })).rejects.toThrow();
  expect(calls).toBe(1);
  const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
  expect(raw).toMatchObject({ contract: "provider-raw-attempt-v3", http_response: {
    bodyBase64: Buffer.from(prefix).toString("base64"), bodyComplete: false,
    bodyByteLength: Buffer.byteLength(prefix), bodySha256: createHash("sha256").update(prefix).digest("hex")
  } });
  const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
  expect(reopened.snapshot()?.attempts).toBe(1);
  await expect(reopened.reserveAttemptOrdinal!(fixture.selected[0]!)).rejects.toThrow(/per-key attempt ceiling/u);
});
