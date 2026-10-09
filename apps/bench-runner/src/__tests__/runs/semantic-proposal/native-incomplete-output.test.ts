import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async (_host: string, options?: { all?: boolean }) => {
  const answer = { address: "93.184.216.34", family: 4 }; return options?.all ? [answer] : answer;
}) }));

import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { readSemanticProposalShard } from "../../../runs/semantic-proposal/artifact.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { openSemanticProposalAttemptLedger } from "../../../runs/semantic-proposal/attempt.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";

const PROFILE = "step-3.5-2603-low-json-schema-v1" as const;
const USAGE = { prompt_tokens: 6985, completion_tokens: 16384, total_tokens: 23369 };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root() {
  const value = mkdtempSync(join(tmpdir(), "native-incomplete-output-"));
  roots.push(value);
  return value;
}

function workset() {
  return parseSemanticProposalWorkset({
    contract: "source-semantic-proposal-workset-v4",
    kind: "query",
    model: STEP_PLAN_QUOTE_BASIS.selected_model,
    request_profile: PROFILE,
    provider_url: STEP_PLAN_QUOTE_BASIS.selected_provider_url,
    items: [{ original_query: "Who sent the parcel?" }]
  });
}

function config(): CompileSeedExtractionConfig {
  return {
    model: STEP_PLAN_QUOTE_BASIS.selected_model, requestProfile: PROFILE,
    providerUrl: STEP_PLAN_QUOTE_BASIS.selected_provider_url, apiKey: "loopback-only"
  };
}

const COMPLETE_EMPTY_LENGTH_WIRE =
  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ finish_reason: "length" }], usage: USAGE })}\n\n` +
  "data: [DONE]\n\n";

async function withLoopback(
  send: (response: import("node:http").ServerResponse) => void,
  run: (fetchImpl: typeof fetch, callCount: () => number) => Promise<void>
): Promise<void> {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      calls += 1;
      send(response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  const fetchImpl: typeof fetch = (url, init) => {
    const selected = new URL(String(url));
    expect(selected.href).toBe("https://api.stepfun.com/step_plan/v1/chat/completions");
    expect(init?.redirect).toBe("error");
    return nativeFetch(new URL(selected.pathname, origin), init);
  };
  try { await run(fetchImpl, () => calls); }
  finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

it("classifies complete reasoning-only length SSE as incomplete and reopens without dispatch", async () => {
  const prepared = workset();
  const cacheRoot = root();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 16384, 1),
    inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
    outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million
  });
  const stepConfig = config();
  await withLoopback(response => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(COMPLETE_EMPTY_LENGTH_WIRE);
  }, async (fetchImpl, calls) => {
    const run = () => executeSemanticProposalFill({
      workset: prepared, cacheRoot, authority, config: stepConfig,
      extractor: createSemanticProviderHttpExtractor(stepConfig, "source_semantic_proposal", fetchImpl)
    });
    await expect(run()).rejects.toThrow(/stopped after incomplete/u);
    const key = authority.keys[0]!;
    const raw = readProviderRawAttempt(cacheRoot, key, 1)!;
    expect(raw).toMatchObject({
      decoded_text: "", finish_reason: "length", usage_known: true,
      usage: { inputTokens: 6985, outputTokens: 16384, totalTokens: 23369 },
      http_response: { bodyComplete: true, bodyBase64: Buffer.from(COMPLETE_EMPTY_LENGTH_WIRE).toString("base64") }
    });
    expect(raw.transport_failure).toBeUndefined();
    const shard = readSemanticProposalShard(cacheRoot, key)!;
    expect(shard).toMatchObject({
      admitted: false, finish_reason: "length", raw_json: "",
      outcome: { status: "incomplete", reason: "noncomplete" },
      usage: { inputTokens: 6985, outputTokens: 16384, totalTokens: 23369 }
    });
    expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot())
      .toMatchObject({ attempts: 1, transportFailures: [], successfulShards: 0, unresolvedAttempts: [] });
    expect(readSemanticProposalResults(prepared, cacheRoot, 16384)[0]).toMatchObject({
      status: "incomplete", shard: { outcome: { status: "incomplete", reason: "noncomplete" } }
    });
    await expect(run()).rejects.toThrow(/retained incomplete/u);
    expect(calls()).toBe(1);
  });
});

it("keeps a truncated length SSE as transport failure and does not reclassify it from finish_reason", async () => {
  const prepared = workset();
  const cacheRoot = root();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 16384, 1),
    inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
    outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million
  });
  const stepConfig = config();
  const prefix = 'data: {"choices":[{"delta":{"reasoning_content":"think"},"finish_reason":"length"}]}\n\ndata: {"choices":';
  await withLoopback(response => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(prefix);
    setTimeout(() => response.destroy(), 30);
  }, async (fetchImpl, calls) => {
    const run = () => executeSemanticProposalFill({
      workset: prepared, cacheRoot, authority, config: stepConfig,
      extractor: createSemanticProviderHttpExtractor(stepConfig, "source_semantic_proposal", fetchImpl)
    });
    await expect(run()).rejects.toThrow(/stopped after (terminal|retryable)/u);
    const key = authority.keys[0]!;
    const raw = readProviderRawAttempt(cacheRoot, key, 1)!;
    expect(raw.transport_failure).toBeDefined();
    expect(raw.http_response?.bodyComplete).toBe(false);
    expect(readSemanticProposalResults(prepared, cacheRoot, 16384)[0]?.status).toBe("transport_failure");
    const stored = readSemanticProposalShard(cacheRoot, key)?.outcome;
    await expect(run()).rejects.toThrow(/retained (terminal|retryable|empty)/u);
    expect(readSemanticProposalShard(cacheRoot, key)?.outcome).toEqual(stored);
    expect(calls()).toBe(1);
  });
});
