import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  inspectProviderChatCompletionResponse,
  MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES
} from "@do-soul/alaya-engine-gateway";
import { inspectExtractionAttemptLedger, listExtractionAttemptLedgerRecords } from "../../../runs/extraction/authority/attempt-ledger.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";
import { SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME } from "../../../runs/provider-request/request-binding.js";
import { evidenceSelectionShardPath, inspectEvidenceSelectionShard } from "../../../runs/evidence-selection/artifact.js";
import { executeEvidenceSelectionFill, prepareEvidenceSelection, readEvidenceSelectionResults } from "../../../runs/evidence-selection/execute.js";
import { EVIDENCE_SELECTION_SOURCE_REFERENCE_PAIR_POLICY, materializeEvidenceSelectionLines,
  parseEvidenceSelectionWorkset } from "../../../runs/evidence-selection/input.js";
import { openEvidenceSelectionAttemptLedger } from "../../../runs/evidence-selection/attempt.js";
import { pinEvidenceSelectionAuthority, quoteEvidenceSelection } from "../../../runs/evidence-selection/authority.js";
import { acquireExtractionCacheWriteLease } from "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";

const MODEL = "gemini-3.1-flash-lite";
const PROFILE = "gemini-3.1-minimal-v1" as const;
const PREVIEW = "Lee left the lab on Tuesday after the sample arrived.";
const OTHER = "Advice: always label the sample before shipping.";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("selects exact quotes over loopback HTTP and replays reserved raw and settled cache without a second dispatch or bill", async () => {
  const captured: { hits: number; reservedLedger?: string; urls: string[] } = { hits: 0, urls: [] };
  const server = await listen((req, res) => {
    captured.hits += 1;
    captured.urls.push(req.url ?? "");
    captured.reservedLedger = readFileSync(ledgerPath, "utf8");
    succeed(res, proposalBody([{
      root_id: "src-alpha",
      quotes: ["Lee left the lab on Tuesday"],
      contribution: "Names the departure day."
    }]), "STOP", usage());
  });
  const origin = originOf(server);
  const cacheRoot = join(tempRoot(), "cache");
  const prepared = workset(origin);
  const preflight = prepareEvidenceSelection(prepared, cacheRoot, 128);
  expect(preflight).toMatchObject({
    contract: "source-evidence-selection-preflight-v1",
    maximum_attempts_per_key: 1,
    maximum_attempts: 1,
    missing: 1,
    provider_calls: 0
  });
  expect(preflight.keys).toHaveLength(1);
  expect(preflight.maximum_input_tokens_per_attempt).toBeGreaterThan(0);
  const estimated = quoteEvidenceSelection(preflight, 4, 18);
  expect(estimated).toBeGreaterThan(0);
  const authority = pinEvidenceSelectionAuthority({
    preflight, inputUsdPerMillion: 4, outputUsdPerMillion: 18
  });
  expect(authority.price.estimated_upper_usd).toBe(estimated);
  expect(authority.limits.max_concurrency).toBe(1);
  const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
  const config = configOf(origin);
  const first = await executeEvidenceSelectionFill({
    workset: prepared, cacheRoot, authority, config,
    extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME)
  });
  const key = authority.keys[0]!;
  const line = materializeEvidenceSelectionLines(prepared, 128)[0]!;
  const bound = readEvidenceSelectionResults(prepared, cacheRoot, 128)[0];
  expect(first).toMatchObject({ attempts: 1, newly_admitted: 1, interpreted: 1, cache_hits: 0 });
  expect(captured.hits).toBe(1);
  expect(captured.urls[0]).toBe("/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse");
  expect(bound).toMatchObject({
    status: "interpreted",
    selection: {
      selected: [{
        root_id: "src-alpha",
        quotes: ["Lee left the lab on Tuesday"],
        identity: { root_id: "src-alpha", version: "v1", digest: DIGEST_ALPHA, span: { start: 10, end: 64 } }
      }],
      unresolved: ["Speaker identity is unknown."]
    }
  });
  expect(bound && "selection" in bound && bound.selection
    ? JSON.stringify(bound.selection) : "").not.toMatch(/contribution|Names the departure/u);
  const ledger = openEvidenceSelectionAttemptLedger({ cacheRoot, authority });
  expect(ledger.snapshot().telemetry.totalTokens).toBe(18);
  expect(ledger.snapshot().successfulKeys).toEqual([key]);
  expect(inspectEvidenceSelectionShard(cacheRoot, key, {
    model: MODEL, request_profile: PROFILE
  })?.admitted).toBe(true);

  const settledReplay = await executeEvidenceSelectionFill({
    workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
  });
  expect(settledReplay).toMatchObject({ cache_hits: 1, newly_admitted: 0, interpreted: 1, attempts: 0 });
  expect(captured.hits).toBe(1);
  expect(openEvidenceSelectionAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens).toBe(18);

  unlinkSync(evidenceSelectionShardPath(cacheRoot, key));
  writeFileSync(ledgerPath, captured.reservedLedger!);
  const rawReplay = await executeEvidenceSelectionFill({
    workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
  });
  expect(rawReplay).toMatchObject({ newly_admitted: 1, interpreted: 1, attempts: 1 });
  expect(captured.hits).toBe(1);
  expect(openEvidenceSelectionAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens).toBe(18);
  expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)[0]?.status).toBe("interpreted");
  expect(line.sourcesDigest).toHaveLength(64);
  server.closeAllConnections();
  await closeServer(server);
});

it.each([
  {
    label: "unknown root",
    body: proposalBody([{ root_id: "missing-root", quotes: ["Lee left"], contribution: "Not in the pool." }]),
    status: "invalid",
    reason: "unknown_root"
  },
  {
    label: "duplicate root",
    body: proposalBody([
      { root_id: "src-alpha", quotes: ["Lee left the lab"], contribution: "First." },
      { root_id: "src-alpha", quotes: ["sample arrived"], contribution: "Again." }
    ]),
    status: "invalid",
    reason: "duplicate_root"
  },
  {
    label: "quote mismatch",
    body: proposalBody([{
      root_id: "src-alpha",
      quotes: ["Lee never left the lab"],
      contribution: "Invented quote."
    }]),
    status: "invalid",
    reason: "quote_mismatch"
  }
])("rejects $label as a distinct failure without admitting empty success", async (fixture) => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, fixture.body, "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin);
    const authority = pinEvidenceSelectionAuthority({
      preflight: prepareEvidenceSelection(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const config = configOf(origin);
    const result = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME)
    });
    expect(result).toMatchObject({ attempts: 1, newly_admitted: 0, interpreted: 0, rejected: 1 });
    expect(captured.hits).toBe(1);
    const row = readEvidenceSelectionResults(prepared, cacheRoot, 128)[0];
    expect(row).toMatchObject({ status: fixture.status, shard: { admitted: false, outcome: { reason: fixture.reason } } });
    expect(row && "selection" in row ? row.selection : undefined).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("requests full Step HTTP evidence over 64KiB through the default extractor and resumes from the written raw", async () => {
  const content = JSON.stringify(proposalBody([{
    root_id: "src-alpha",
    quotes: ["Lee left the lab on Tuesday"],
    contribution: "Names the departure day."
  }]));
  const wire =
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "r".repeat(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES) } }] })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    })}\n\ndata: [DONE]\n\n`;
  const original = Buffer.from(wire);
  expect(original.length).toBeGreaterThan(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES);
  let ledgerPath = "";
  const captured: { hits: number; reservedLedger?: string; urls: string[] } = { hits: 0, urls: [] };
  const server = await listen((req, res) => {
    captured.hits += 1;
    captured.urls.push(req.url ?? "");
    captured.reservedLedger = readFileSync(ledgerPath, "utf8");
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.end(wire);
  });
  const origin = originOf(server);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((url, init) => {
    const selected = new URL(String(url));
    expect(selected.origin).toBe("https://api.stepfun.com");
    return nativeFetch(new URL(selected.pathname + selected.search, origin), init);
  }) as typeof fetch;
  try {
    // The fetch seam below routes the exact Step host to the real loopback server.
    vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "true");
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = stepWorkset();
    const preflight = prepareEvidenceSelection(prepared, cacheRoot, 128);
    const authority = pinEvidenceSelectionAuthority({
      preflight,
      inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
      outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million
    });
    ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
    const config = stepConfig();
    const first = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config
    });
    const key = authority.keys[0]!;
    expect(first).toMatchObject({ attempts: 1, newly_admitted: 1, interpreted: 1, cache_hits: 0 });
    expect(captured.hits).toBe(1);
    expect(captured.urls[0]).toBe("/step_plan/v1/chat/completions");
    const raw = readProviderRawAttempt(cacheRoot, key, 1)!;
    expect(raw.http_response).toMatchObject({
      bodyByteLength: original.length, bodyComplete: true, bodyTruncated: false,
      bodySha256: createHash("sha256").update(original).digest("hex")
    });
    expect(Buffer.from(raw.http_response!.bodyBase64, "base64").equals(original)).toBe(true);
    expect(inspectProviderChatCompletionResponse(
      Buffer.from(raw.http_response!.bodyBase64, "base64"), raw.http_response!.contentType, 200,
      { sseCompletionPolicy: "require_witness" }
    )).toMatchObject({ text: content, finishReason: "stop",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } });
    expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)[0]?.status).toBe("interpreted");
    const settledReplay = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
    });
    expect(settledReplay).toMatchObject({ cache_hits: 1, newly_admitted: 0, interpreted: 1, attempts: 0 });
    expect(captured.hits).toBe(1);
    unlinkSync(evidenceSelectionShardPath(cacheRoot, key));
    writeFileSync(ledgerPath, captured.reservedLedger!);
    const rawReplay = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
    });
    expect(rawReplay).toMatchObject({ newly_admitted: 1, interpreted: 1, attempts: 1 });
    expect(captured.hits).toBe(1);
    expect(openEvidenceSelectionAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens).toBe(18);
    expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)[0]?.status).toBe("interpreted");
  } finally {
    globalThis.fetch = nativeFetch;
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("keeps incomplete MAX_TOKENS output distinct from invalid and from abstain", async () => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, proposalBody([{
      root_id: "src-alpha",
      quotes: ["Lee left the lab on Tuesday"],
      contribution: "Truncated."
    }]), "MAX_TOKENS", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin);
    const authority = pinEvidenceSelectionAuthority({
      preflight: prepareEvidenceSelection(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const config = configOf(origin);
    const result = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME)
    });
    expect(result).toMatchObject({ attempts: 1, newly_admitted: 0, incomplete: 1, interpreted: 0 });
    expect(captured.hits).toBe(1);
    expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)[0]).toMatchObject({
      status: "incomplete",
      shard: { admitted: false, outcome: { status: "incomplete", reason: "noncomplete" }, finish_reason: "MAX_TOKENS" }
    });
    const replay = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
    });
    expect(replay).toMatchObject({ cache_hits: 1, attempts: 0, incomplete: 1 });
    expect(captured.hits).toBe(1);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it.each(["success", "grounding_failure"])("settles and reopens source reference pairs over native Step SSE: %s", async (mode) => {
  const replies = mode === "success" ? [
    { status: "proposal", selected: [{ sourceRef: "s1", witnessRefs: ["w1"], contribution: "Original departure report." }], unresolved: ["Time scope is unknown."] },
    { status: "proposal", selected: [{ sourceRef: "s1", quotes: ["Lee left the lab on Tuesday"], contribution: "Original departure report." }], unresolved: ["Time scope is unknown."] }
  ] : [
    { status: "proposal", selected: [{ sourceRef: "s2", witnessRefs: ["w1"], contribution: "Wrong source pairing." }], unresolved: [] },
    { status: "proposal", selected: [{ sourceRef: "s1", quotes: ["Lee never left the lab"], contribution: "Wrong literal copy." }], unresolved: [] }
  ];
  const captured: { bodies: string[]; reservations: string[]; wires: string[] } = { bodies: [], reservations: [], wires: [] };
  let ledgerPath = "";
  const server = await listen(async (req, res) => {
    let requestBody = "";
    for await (const chunk of req) requestBody += String(chunk);
    const index = captured.bodies.push(requestBody) - 1;
    captured.reservations.push(readFileSync(ledgerPath, "utf8"));
    const wire = `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(replies[index]) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`;
    captured.wires.push(wire);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(wire);
  });
  const origin = originOf(server);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((url, init) => {
    const selected = new URL(String(url));
    expect(selected.origin).toBe("https://api.stepfun.com");
    return nativeFetch(new URL(selected.pathname + selected.search, origin), init);
  }) as typeof fetch;
  try {
    vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "true");
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = { ...stepWorkset(), request_policy: EVIDENCE_SELECTION_SOURCE_REFERENCE_PAIR_POLICY };
    const lines = materializeEvidenceSelectionLines(prepared, 128);
    const authority = pinEvidenceSelectionAuthority({ preflight: prepareEvidenceSelection(prepared, cacheRoot, 128),
      inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
      outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million });
    ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
    const result = await executeEvidenceSelectionFill({ workset: prepared, cacheRoot, authority, config: stepConfig() });
    expect(result).toMatchObject({ attempts: 2, newly_admitted: mode === "success" ? 2 : 0,
      interpreted: mode === "success" ? 2 : 0, rejected: mode === "success" ? 0 : 2 });
    expect(captured.bodies).toHaveLength(2);
    const bodies = captured.bodies.map((body) => JSON.parse(body));
    for (const [index, line] of lines.entries()) {
      expect(bodies[index]).toMatchObject({ stream: true, reasoning_effort: "low",
        response_format: { type: "json_schema", json_schema: { strict: true, schema: line.responseJsonSchema } },
        messages: [{ role: "system", content: line.systemPrompt }, { role: "user", content: line.userPrompt }] });
    }
    expect(bodies[0].messages[1]).toEqual(bodies[1].messages[1]);
    const rows = readEvidenceSelectionResults(prepared, cacheRoot, 128);
    if (mode === "success") {
      expect(rows[0]).toMatchObject({ status: "interpreted", selection: { selected: [{ root_id: "src-alpha", quotes: [PREVIEW],
        identity: { root_id: "src-alpha", version: "v1", digest: DIGEST_ALPHA, span: { start: 10, end: 64 } } }] } });
      expect(rows[1]).toMatchObject({ status: "interpreted", selection: { selected: [{ root_id: "src-alpha", quotes: ["Lee left the lab on Tuesday"] }] } });
    } else {
      expect(rows[0]).toMatchObject({ status: "invalid", shard: { admitted: false, outcome: { reason: "witness_owner_mismatch" } } });
      expect(rows[1]).toMatchObject({ status: "invalid", shard: { admitted: false, outcome: { reason: "quote_mismatch" } } });
    }
    const rawAttempts = lines.map((line, index) => readProviderRawAttempt(cacheRoot, line.key, index + 1)!);
    rawAttempts.forEach((raw, index) => {
      expect(raw.decoded_text).toBe(JSON.stringify(replies[index]));
      expect(Buffer.from(raw.http_response!.bodyBase64, "base64").toString("utf8")).toBe(captured.wires[index]);
    });
    expect(openEvidenceSelectionAttemptLedger({ cacheRoot, authority }).snapshot()).toMatchObject({
      attempts: 2, maximumAttempts: 2, telemetry: { totalTokens: 36 },
      successfulKeys: mode === "success" ? lines.map((line) => line.key).sort() : [] });
    const reopened = await executeEvidenceSelectionFill({ workset: prepared, cacheRoot, authority, config: { ...stepConfig(), apiKey: null } });
    expect(reopened).toMatchObject({ attempts: 0, newly_admitted: 0, cache_hits: 2 });
    expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)).toEqual(rows);
    // Simulate the second write stopping after durable raw publication, before settlement.
    unlinkSync(evidenceSelectionShardPath(cacheRoot, lines[1]!.key));
    writeFileSync(ledgerPath, captured.reservations[1]!);
    const recovered = await executeEvidenceSelectionFill({ workset: prepared, cacheRoot, authority,
      config: { ...stepConfig(), apiKey: null } });
    expect(recovered).toMatchObject({ attempts: 1, newly_admitted: mode === "success" ? 1 : 0 });
    expect(captured.bodies).toHaveLength(2);
    expect(readEvidenceSelectionResults(prepared, cacheRoot, 128).map((row) => row.status))
      .toEqual(mode === "success" ? ["interpreted", "interpreted"] : ["invalid", "invalid"]);
    expect(lines.map((line, index) => readProviderRawAttempt(cacheRoot, line.key, index + 1))).toEqual(rawAttempts);
    expect(openEvidenceSelectionAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens).toBe(36);
    expect(prepareEvidenceSelection(prepared, cacheRoot, 128)).toMatchObject({ missing: 0, maximum_attempts: 0, keys: [] });
  } finally {
    globalThis.fetch = nativeFetch;
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("rejects mutated route before HTTP and mutated cache on read", async () => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, {
      status: "cannot_propose",
      selected: [],
      unresolved: ["The supplied previews lack the requested time scope."]
    }, "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin);
    const authority = pinEvidenceSelectionAuthority({
      preflight: prepareEvidenceSelection(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    await expect(executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority,
      config: { ...configOf(origin), providerUrl: "http://127.0.0.1:9" }
    })).rejects.toThrow(/authorized request|model\/profile|transport/u);
    expect(captured.hits).toBe(0);
    expect(listExtractionAttemptLedgerRecords(cacheRoot)).toEqual([]);

    const config = configOf(origin);
    const result = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME)
    });
    expect(result).toMatchObject({ attempts: 1, abstained: 1, newly_admitted: 0, interpreted: 0 });
    expect(captured.hits).toBe(1);
    expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)[0]?.status).toBe("abstained");

    const key = authority.keys[0]!;
    const shardPath = evidenceSelectionShardPath(cacheRoot, key);
    const shard = JSON.parse(readFileSync(shardPath, "utf8")) as Record<string, unknown>;
    writeFileSync(shardPath, `${JSON.stringify({
      ...shard,
      transport_provenance: { ...(shard.transport_provenance as object), model: "gemini-2.5-flash-lite" }
    }, null, 2)}\n`);
    expect(() => readEvidenceSelectionResults(prepared, cacheRoot, 128)).toThrow(/identity mismatch/u);
    expect(prepareEvidenceSelection(workset("http://127.0.0.1:9"), join(tempRoot(), "other"), 128).keys[0])
      .not.toBe(key);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("stops later keys after the first settled selection without a second request or reservation", async () => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, proposalBody([{
      root_id: "src-alpha",
      quotes: ["Lee left the lab on Tuesday"],
      contribution: "Names the departure day."
    }]), "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin, QUESTIONS);
    const authority = pinEvidenceSelectionAuthority({
      preflight: prepareEvidenceSelection(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    expect(authority.keys).toHaveLength(3);
    const config = configOf(origin);
    const firstKey = authority.keys[0]!;
    const result = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME),
      continueAfterResult: (key) => {
        expect(key).toBe(firstKey);
        expect(captured.hits).toBe(1);
        expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)).toMatchObject([
          { status: "interpreted", selection: { selected: [{ root_id: "src-alpha", quotes: ["Lee left the lab on Tuesday"] }] } },
          { status: "unattempted" },
          { status: "unattempted" }
        ]);
        expect(inspectLedger(cacheRoot, authority)).toMatchObject({
          attempts: 1, successfulKeys: [firstKey], pendingKeys: [], unresolvedAttempts: []
        });
        expect(inspectLedger(cacheRoot, authority)?.settledAttempts.map((item) => item.cacheKey)).toEqual([firstKey]);
        return false;
      }
    });
    expect(captured.hits).toBe(1);
    expect(result).toMatchObject({
      attempts: 1, newly_admitted: 1, interpreted: 1, unattempted: 2, cache_hits: 0
    });
    expect(readEvidenceSelectionResults(prepared, cacheRoot, 128).map((row) => row.status))
      .toEqual(["interpreted", "unattempted", "unattempted"]);
    const snapshot = inspectLedger(cacheRoot, authority);
    expect(snapshot).toMatchObject({ attempts: 1, successfulKeys: [firstKey], pendingKeys: [] });
    for (const key of authority.keys.slice(1)) {
      expect(readProviderRawAttempt(cacheRoot, key, 1)).toBeUndefined();
      expect(snapshot?.pendingKeys).not.toContain(key);
      expect(snapshot?.unresolvedAttempts.some((item) => item.cacheKey === key)).toBe(false);
      expect(snapshot?.settledAttempts.some((item) => item.cacheKey === key)).toBe(false);
    }
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("continues to the next key after a settled invalid grounding", async () => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, captured.hits === 1
      ? proposalBody([{ root_id: "missing-root", quotes: ["Lee left"], contribution: "Not in the pool." }])
      : proposalBody([{ root_id: "src-alpha", quotes: ["Lee left the lab on Tuesday"], contribution: "Names the departure day." }]),
    "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin, QUESTIONS.slice(0, 2));
    const authority = pinEvidenceSelectionAuthority({
      preflight: prepareEvidenceSelection(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const config = configOf(origin);
    const seen: string[] = [];
    const result = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME),
      continueAfterResult: (key) => {
        seen.push(key);
        if (seen.length === 1) {
          expect(key).toBe(authority.keys[0]);
          expect(captured.hits).toBe(1);
          expect(readEvidenceSelectionResults(prepared, cacheRoot, 128).map((row) => row.status))
            .toEqual(["invalid", "unattempted"]);
          expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)[0]).toMatchObject({
            shard: { admitted: false, outcome: { reason: "unknown_root" } }
          });
          expect(inspectLedger(cacheRoot, authority)).toMatchObject({
            attempts: 1, successfulKeys: [], pendingKeys: [], unresolvedAttempts: []
          });
          expect(inspectLedger(cacheRoot, authority)?.settledAttempts.map((item) => item.cacheKey))
            .toEqual([authority.keys[0]]);
        }
        return true;
      }
    });
    expect(seen).toEqual(authority.keys);
    expect(captured.hits).toBe(2);
    expect(result).toMatchObject({
      attempts: 2, newly_admitted: 1, interpreted: 1, rejected: 1, unattempted: 0
    });
    expect(readEvidenceSelectionResults(prepared, cacheRoot, 128).map((row) => row.status))
      .toEqual(["invalid", "interpreted"]);
    expect(inspectLedger(cacheRoot, authority)?.successfulKeys).toEqual([authority.keys[1]]);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("releases the writer lease when continuation throws after a settled selection", async () => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, proposalBody([{
      root_id: "src-alpha",
      quotes: ["Lee left the lab on Tuesday"],
      contribution: "Names the departure day."
    }]), "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin, QUESTIONS.slice(0, 2));
    const authority = pinEvidenceSelectionAuthority({
      preflight: prepareEvidenceSelection(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const config = configOf(origin);
    const firstKey = authority.keys[0]!;
    await expect(executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME),
      continueAfterResult: (key) => {
        expect(key).toBe(firstKey);
        expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)[0]?.status).toBe("interpreted");
        expect(inspectLedger(cacheRoot, authority)?.successfulKeys).toEqual([firstKey]);
        throw new Error("continueAfterResult rejected further selection");
      }
    })).rejects.toThrow(/continueAfterResult rejected further selection/u);
    expect(captured.hits).toBe(1);
    const lease = acquireExtractionCacheWriteLease(cacheRoot);
    lease.release();
    expect(readEvidenceSelectionResults(prepared, cacheRoot, 128).map((row) => row.status))
      .toEqual(["interpreted", "unattempted"]);
    const snapshot = inspectLedger(cacheRoot, authority);
    expect(snapshot).toMatchObject({ attempts: 1, successfulKeys: [firstKey], pendingKeys: [] });
    expect(readProviderRawAttempt(cacheRoot, authority.keys[1]!, 1)).toBeUndefined();
    expect(snapshot?.settledAttempts.map((item) => item.cacheKey)).toEqual([firstKey]);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

const DIGEST_ALPHA = `sha256:${"a".repeat(64)}`;
const DIGEST_BETA = `sha256:${"b".repeat(64)}`;
const QUESTIONS = [
  "Who left after the sample arrived?",
  "When did Lee leave?",
  "What arrived?"
] as const;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "evidence-selection-"));
  roots.push(root);
  return root;
}

function workset(providerUrl: string, questions: readonly string[] = [QUESTIONS[0]]) {
  const sources = [
    {
      root_id: "src-alpha",
      version: "v1",
      digest: DIGEST_ALPHA,
      span: { start: 10, end: 64 },
      preview: PREVIEW,
      metadata: null
    },
    {
      root_id: "src-beta",
      version: "v1",
      digest: DIGEST_BETA,
      span: { start: 0, end: OTHER.length },
      preview: OTHER
    }
  ];
  return parseEvidenceSelectionWorkset({
    contract: "source-evidence-selection-workset-v1",
    model: MODEL,
    provider_url: providerUrl,
    request_profile: PROFILE,
    items: questions.map((original_question) => ({
      original_question,
      metadata: null,
      sources
    }))
  });
}

function inspectLedger(cacheRoot: string, authority: ReturnType<typeof pinEvidenceSelectionAuthority>) {
  return inspectExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: authority.attempt_lineage_digest,
    cacheIdentity: { model: MODEL, requestProfile: PROFILE }
  });
}

function configOf(origin: string): CompileSeedExtractionConfig {
  return { providerUrl: origin, model: MODEL, requestProfile: PROFILE, apiKey: "loopback-only" };
}

function stepWorkset() {
  return parseEvidenceSelectionWorkset({
    ...workset(new URL(STEP_PLAN_QUOTE_BASIS.selected_provider_url).origin),
    model: STEP_PLAN_QUOTE_BASIS.selected_model,
    provider_url: STEP_PLAN_QUOTE_BASIS.selected_provider_url,
    request_profile: "step-3.5-2603-low-json-schema-v1"
  });
}

function stepConfig(): CompileSeedExtractionConfig {
  return {
    providerUrl: STEP_PLAN_QUOTE_BASIS.selected_provider_url,
    model: STEP_PLAN_QUOTE_BASIS.selected_model,
    requestProfile: "step-3.5-2603-low-json-schema-v1",
    apiKey: "loopback-only"
  };
}

function usage() {
  return { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
}

function proposalBody(selected: readonly { root_id: string; quotes: readonly string[]; contribution: string }[]) {
  return {
    status: "proposal" as const,
    selected,
    unresolved: ["Speaker identity is unknown."]
  };
}

function succeed(
  res: import("node:http").ServerResponse,
  body: unknown,
  finishReason: string,
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number }
): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(body) }] } }],
    usageMetadata: {
      promptTokenCount: tokens.inputTokens,
      candidatesTokenCount: tokens.outputTokens,
      totalTokenCount: tokens.totalTokens
    }
  }));
}

async function listen(handler: import("node:http").RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  return server;
}

function originOf(server: import("node:http").Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback server has no port");
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

function closeServer(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
