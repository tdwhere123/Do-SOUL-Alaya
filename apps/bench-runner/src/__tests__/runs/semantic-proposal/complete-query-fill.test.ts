import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { encodeSourceSemanticQueryCarrier } from "@do-soul/alaya-protocol";
import { admitSourceSemanticQuery, SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID } from "@do-soul/alaya-core";
import { proposeQuerySemantics } from "@do-soul/alaya-soul";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import {
  inspectSemanticProposalShard, hasAdmittedProposalOutcome
} from "../../../runs/semantic-proposal/artifact.js";
import {
  executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults
} from "../../../runs/semantic-proposal/fill.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { openSemanticProposalAttemptLedger } from "../../../runs/semantic-proposal/attempt.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";
import { proposalRecoveryCases } from "./proposal-recovery.test-support.js";

const MODEL = "gemini-3.1-flash-lite";
const PROFILE = "gemini-3.1-minimal-v1" as const;
const MIRA_QUERY = "Who sent the sample to Mira?";
const roots: string[] = [];

proposalRecoveryCases({ workset: () => queryWorkset(MIRA_QUERY), body: () => meaningBody("sample"), config });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "proposal-complete-fill-"));
  roots.push(root);
  return root;
}

function queryWorkset(originalQuery: string) {
  return parseSemanticProposalWorkset({
    contract: "source-semantic-proposal-workset-v3", provider_url: "http://127.0.0.1:9",
    kind: "query", model: MODEL, request_profile: PROFILE,
    items: [{ original_query: originalQuery }]
  });
}

function config(): CompileSeedExtractionConfig {
  return { providerUrl: "http://127.0.0.1:9", model: MODEL, requestProfile: PROFILE, apiKey: "synthetic-fixture-key" };
}

function extractor(raws: string[], extra: { finish?: string | null; usage?: boolean } = {}) {
  const queue = [...raws];
  const calls: string[] = [];
  const finish = extra.finish === undefined ? "STOP" : extra.finish;
  const withUsage = extra.usage !== false;
  return {
    calls,
    extract: async (input: { readonly userPrompt: string }) => {
      calls.push(input.userPrompt);
      const rawJson = queue.shift() ?? "{";
      return {
        rawJson,
        ...(withUsage ? { usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } } : {}),
        responseMetadata: finish === null
          ? { finishReason: null as string | null }
          : { finishReason: finish, completionWitness: "finish_reason" as const, completionContractVersion: 1 as const }
      };
    }
  };
}

function meaningBody(themeExcerpt: string): string {
  return JSON.stringify({
    contract: "source-semantic-query-response-v8",
    outcome: { status: "interpreted" },
    query: encodeSourceSemanticQueryCarrier({
      contract: "source-semantic-query-meaning-v5",
      alternatives: [{ conditions: [{
        kind: "statement", key: "send", predicate: "send",
        arguments: [
          { role: "sender", target: { kind: "free", key: "sender", return: true }, excerpt: "Who" },
          { role: "theme", target: { kind: "named", key: "sample", excerpt: themeExcerpt }, excerpt: themeExcerpt },
          { role: "recipient", target: { kind: "named", key: "mira", excerpt: "Mira" }, excerpt: "Mira" }
        ]
      }] }],
      gaps: []
    })
  });
}

it("commits a complete STOP query after settling the reserved attempt", async () => {
  const cacheRoot = join(tempRoot(), "cache");
  const prepared = queryWorkset(MIRA_QUERY);
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const first = extractor([meaningBody("sample")]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: first
  });
  const key = authority.keys[0]!;
  const shard = inspectSemanticProposalShard(cacheRoot, key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  });
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  expect(first.calls).toHaveLength(1);
  expect(result.newly_admitted).toBe(1);
  expect(result.interpreted).toBe(1);
  expect(result.attempts).toBe(1);
  expect(result.unknown).toBe(0);
  expect(shard?.admitted).toBe(true);
  expect(shard?.finish_reason).toBe("STOP");
  expect(hasAdmittedProposalOutcome(shard!)).toBe(true);
  expect(ledger.snapshot().unresolvedAttempts).toEqual([]);
  expect(ledger.snapshot().pendingKeys).toEqual([]);
  expect(ledger.snapshot().successfulKeys).toEqual([key]);
  expect(ledger.snapshot().telemetry.inputTokens).toBe(3);
  const second = extractor(["should-not-run"]);
  const replayed = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: second
  });
  expect(second.calls).toHaveLength(0);
  expect(replayed.cache_hits).toBe(1);
  expect(replayed.newly_admitted).toBe(0);
  expect(replayed.interpreted).toBe(1);
});

it("sends the pinned Step query body through localhost HTTP and reopens the exact raw response", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    wires.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(wire);
  });
  const wires: { path: string | undefined; body: Record<string, unknown> }[] = [];
  const wire = `data: ${JSON.stringify({ choices: [{ delta: { content: meaningBody("sample") },
    finish_reason: "stop" }], usage: { prompt_tokens: 17, completion_tokens: 12,
    total_tokens: 29, completion_tokens_details: { reasoning_tokens: 4 } } })}\n\ndata: [DONE]\n\n`;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const prepared = parseSemanticProposalWorkset({
      contract: "source-semantic-proposal-workset-v4", provider_url: STEP_PLAN_QUOTE_BASIS.selected_provider_url,
      kind: "query", model: STEP_PLAN_QUOTE_BASIS.selected_model,
      request_profile: "step-3.5-2603-low-json-schema-v1",
      items: [{ original_query: MIRA_QUERY }]
    });
    const cacheRoot = join(tempRoot(), "cache");
    const preflight = prepareSemanticProposal(prepared, cacheRoot, 4096, 1);
    expect(preflight).toMatchObject({ contract: "source-semantic-proposal-preflight-v6",
      maximum_attempts_per_key: 1, quote_basis: STEP_PLAN_QUOTE_BASIS });
    const authority = pinSemanticProposalAuthority({ preflight,
      inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
      outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million });
    const stepConfig: CompileSeedExtractionConfig = { model: STEP_PLAN_QUOTE_BASIS.selected_model,
      requestProfile: "step-3.5-2603-low-json-schema-v1",
      providerUrl: STEP_PLAN_QUOTE_BASIS.selected_provider_url, apiKey: "loopback-only" };
    const nativeFetch = globalThis.fetch;
    const localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fetchImpl: typeof fetch = (url, init) => {
      const selected = new URL(String(url));
      expect(selected.href).toBe("https://api.stepfun.com/step_plan/v1/chat/completions");
      return nativeFetch(new URL(selected.pathname, localOrigin), init);
    };
    const first = await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: stepConfig,
      extractor: createSemanticProviderHttpExtractor(stepConfig, "source_semantic_proposal", fetchImpl) });
    expect(first).toMatchObject({ interpreted: 1, newly_admitted: 1, attempts: 1 });
    expect(wires).toHaveLength(1);
    expect(wires[0]).toMatchObject({ path: "/step_plan/v1/chat/completions",
      body: { model: STEP_PLAN_QUOTE_BASIS.selected_model, max_tokens: 4096, reasoning_effort: "low",
        response_format: { type: "json_schema", json_schema: { strict: true } } } });
    const raw = readProviderRawAttempt(cacheRoot, authority.keys[0]!, 1);
    expect(raw).toMatchObject({ contract: "semantic-proposal-raw-attempt-v2",
      finish_reason: "stop", usage: { inputTokens: 17, outputTokens: 12, reasoningOutputTokens: 4 },
      http_response: { bodyBase64: Buffer.from(wire).toString("base64"),
        bodyByteLength: Buffer.byteLength(wire), bodySha256: createHash("sha256").update(wire).digest("hex"),
        bodyComplete: true } });
    expect(readSemanticProposalResults(prepared, cacheRoot, 4096)[0]?.status).toBe("interpreted");
    const repeated = await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority,
      config: { ...stepConfig, apiKey: null } });
    expect(repeated).toMatchObject({ cache_hits: 1, attempts: 0 });
    expect(wires).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each([
  { support: [{ kind: "query_text", excerpt: "sample" }], status: "interpreted", admitted: true },
  { support: [{ kind: "query_text", excerpt: "foreign wording" }], status: "core_rejected", admitted: false },
  { support: [{ kind: "lexical", mentions: ["sample"] }], status: "invalid", admitted: false }
])("persists and replays located query gaps as $status without inventing source-interpretation mentions", async ({ support, status, admitted }) => {
  const body = JSON.parse(meaningBody("sample"));
  body.query.gaps = [{ kind: "unsupported_meaning", affected_ids: ["send"], support }];
  const rawJson = JSON.stringify(body);
  const cacheRoot = join(tempRoot(), "cache"), workset = queryWorkset(MIRA_QUERY);
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  await executeSemanticProposalFill({ workset, cacheRoot, authority, config: config(), extractor: extractor([rawJson]) });
  const result = readSemanticProposalResults(workset, cacheRoot, 128)[0]!;
  expect(result.status).toBe(status);
  expect(result.shard?.admitted).toBe(admitted);
  expect(result.shard?.raw_json).toBe(rawJson);
  if (admitted) expect(result.received?.outcome).toEqual({ status: "interpreted", gaps: body.query.gaps });
  const second = extractor(["must not run"]);
  await executeSemanticProposalFill({ workset, cacheRoot, authority, config: config(), extractor: second });
  expect(second.calls).toEqual([]);
  expect(readSemanticProposalResults(workset, cacheRoot, 128)[0]!.status).toBe(status);
  expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot().unresolvedAttempts).toEqual([]);
});

it("does not treat a Core-invalid receive as an executable cache hit", async () => {
  const invalidBody = meaningBody("parcel");
  const received = proposeQuerySemantics({
    original_query: MIRA_QUERY,
    producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID,
    producer_version: "1"
  }, { rawJson: invalidBody });
  expect(received.outcome.status).toBe("interpreted");
  expect(admitSourceSemanticQuery(received.query, MIRA_QUERY).kind).toBe("invalid");

  const cacheRoot = join(tempRoot(), "cache");
  const prepared = queryWorkset(MIRA_QUERY);
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const first = extractor([invalidBody]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: first
  });
  const key = authority.keys[0]!;
  const shard = inspectSemanticProposalShard(cacheRoot, key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  });
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  expect(first.calls).toHaveLength(1);
  expect(result.newly_admitted).toBe(0);
  expect(result.interpreted).toBe(0);
  expect(readProviderRawAttempt(cacheRoot, key, 1)?.decoded_text).toBe(invalidBody);
  expect(shard?.admitted).toBe(false);
  expect(hasAdmittedProposalOutcome(shard!)).toBe(false);
  expect(ledger.snapshot().unresolvedAttempts).toEqual([]);
  expect(ledger.snapshot().successfulKeys).toEqual([]);
  const second = extractor(["should-not-run"]);
  const replayed = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: second
  });
  expect(second.calls).toHaveLength(0);
  expect(replayed.cache_hits).toBe(1);
  expect(replayed.cached_invalid).toBe(1);
  expect(replayed.newly_admitted).toBe(0);
  expect(replayed.interpreted).toBe(0);
});

async function fillInterpretedQuery(finish: string | null) {
  const cacheRoot = join(tempRoot(), "cache");
  const prepared = queryWorkset(MIRA_QUERY);
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const first = extractor([meaningBody("sample")], { finish });
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: first
  });
  return { cacheRoot, prepared, authority, first, result, key: authority.keys[0]! };
}

it("replays interpreted JSON with a missing finish as cached incomplete", async () => {
  const { cacheRoot, prepared, authority, first, result, key } =
    await fillInterpretedQuery(null);
  const shard = inspectSemanticProposalShard(cacheRoot, key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  });
  const raw = readProviderRawAttempt(cacheRoot, key, 1);
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  expect(first.calls).toHaveLength(1);
  expect(result.newly_admitted).toBe(0);
  expect(result).toMatchObject({ terminal_failures: 0, incomplete: 1, unknown: 0 });
  expect(shard?.admitted).toBe(false);
  expect(shard?.finish_reason).toBeNull();
  expect(shard?.outcome).toMatchObject({ status: "interpreted" });
  expect(hasAdmittedProposalOutcome(shard!)).toBe(false);
  expect(raw?.finish_reason).toBeNull();
  expect(raw?.completion_witness).toBeNull();
  expect(ledger.snapshot().unresolvedAttempts).toEqual([]);
  expect(ledger.snapshot().successfulKeys).toEqual([]);
  expect(() => prepareSemanticProposal(prepared, cacheRoot, 128)).not.toThrow();
  const second = extractor(["should-not-run"]);
  const replayed = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: second
  });
  expect(second.calls).toHaveLength(0);
  expect(replayed.cache_hits).toBe(1);
  expect(replayed.cached_invalid).toBe(1);
  expect(replayed.newly_admitted).toBe(0);
});

it("replays interpreted JSON with MAX_TOKENS as cached incomplete", async () => {
  const { cacheRoot, prepared, authority, first, result, key } =
    await fillInterpretedQuery("MAX_TOKENS");
  const shard = inspectSemanticProposalShard(cacheRoot, key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  });
  const raw = readProviderRawAttempt(cacheRoot, key, 1);
  expect(first.calls).toHaveLength(1);
  expect(result.newly_admitted).toBe(0);
  expect(shard?.admitted).toBe(false);
  expect(shard?.finish_reason).toBe("MAX_TOKENS");
  expect(shard?.outcome).toMatchObject({ status: "interpreted" });
  expect(hasAdmittedProposalOutcome(shard!)).toBe(false);
  expect(raw?.finish_reason).toBe("MAX_TOKENS");
  expect(raw?.completion_witness).toBe("finish_reason");
  expect(() => prepareSemanticProposal(prepared, cacheRoot, 128)).not.toThrow();
  const second = extractor(["should-not-run"]);
  const replayed = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: second
  });
  expect(second.calls).toHaveLength(0);
  expect(replayed.cache_hits).toBe(1);
  expect(replayed.cached_invalid).toBe(1);
  expect(replayed.newly_admitted).toBe(0);
});

it("records unknown usage against one reserved attempt", async () => {
  const cacheRoot = join(tempRoot(), "cache");
  mkdirSync(cacheRoot, { recursive: true });
  const prepared = queryWorkset("Who chairs SHADOW?");
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const spy = extractor(['{"outcome":{"status":"abstained"}}'], { usage: false });
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: spy
  });
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  expect(spy.calls).toHaveLength(1);
  expect(result.attempts).toBe(1);
  expect(result.newly_admitted).toBe(0);
  expect(ledger.snapshot().unresolvedAttempts).toEqual([]);
  expect(ledger.snapshot().attempts).toBe(1);
  expect(ledger.snapshot().telemetry.usageUnavailableRequests).toBe(1);
  expect(result).toMatchObject({ unknown: 0, pending: 0, incomplete: 0 });
});
