import { fetchLoopbackProvider } from "../../support/loopback-provider-fetch.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from
  "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from
  "../../../runs/extraction/authority/receipt.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { inspectCachedSourceSemantic } from
  "../../../runs/extraction/cache/source-semantic-artifact.js";
import { inspectInteractiveTransportEvidence } from "../../../runs/extraction/cache/source-interactive-binding.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { providerRawAttemptPath } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { parseSourceSemanticInteractivePreflight, preflightSourceSemanticInteractive } from
  "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
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
    return fetchLoopbackProvider(nativeFetch, new URL(selected.pathname + selected.search, origin), init);
  });
  vi.stubGlobal("fetch", intercepted);
  return { calls, intercepted };
}

it("retired Step read uses retained outer binding", async () => {
  const fixture = await scenario(1);
  const http = await listen(body => ({
    text: responseFor((body.messages as { content: string }[])[1]!.content), finish: "stop"
  }));
  await runExtractionFill(fixture.options);
  const key = fixture.selected[0]!;
  const shardPath = cacheFilePath(roots.cacheRoot, key);
  const shard = JSON.parse(readFileSync(shardPath, "utf8"));
  const retired = JSON.parse(shard.source_semantic.result.line.userPrompt);
  retired.source_request.proposal_contract = "source-semantic-proposal-v7";
  shard.source_semantic.result.line.userPrompt = JSON.stringify(retired);
  const digest = createHash("sha256").update(shard.source_semantic.result.line.userPrompt).digest("hex");
  shard.source_semantic.result.line.requestSha256 = digest;
  const rawPath = providerRawAttemptPath(roots.cacheRoot, key, 1);
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  raw.source_request_sha256 = digest;
  writeFileSync(rawPath, JSON.stringify(raw));
  writeFileSync(shardPath, JSON.stringify(shard));
  const outer = inspectInteractiveTransportEvidence(shard.source_semantic, shard, roots.cacheRoot, true);
  expect(outer).toMatchObject({ requestBinding: "unbound", admissionState: "admitted" });
  const before = readFileSync(shardPath, "utf8");
  const actual = inspectCachedSourceSemantic(roots.cacheRoot, key, MODEL, PROFILE);
  expect(readFileSync(shardPath, "utf8")).toBe(before);
  expect(http.calls).toHaveLength(1);
  expect(actual.status).toBe("retired");
});
