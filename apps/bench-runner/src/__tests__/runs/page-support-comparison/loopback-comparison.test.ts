import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { encodeSourceDisclosure, sourceDisclosure, canonicalJson, type SourceDisclosure, type SourceDisclosureSemantic } from "@do-soul/alaya-protocol";
import {
  inspectProviderChatCompletionResponse,
  MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES
} from "@do-soul/alaya-engine-gateway";
import { inspectExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";
import { STEP_OPENAPI_QUOTE_BASIS, STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";
import { PAGE_SUPPORT_COMPARISON_SCHEMA_NAME } from "../../../runs/provider-request/request-binding.js";
import { projectGeminiGenerationSchema } from "../../../runs/extraction/fill/batch/generation-schema.js";
import { acquireExtractionCacheWriteLease } from "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { interpretPageSupportComparisonDecoded } from "../../../runs/page-support-comparison/assess.js";
import {
  pinPageSupportComparisonAuthority, quotePageSupportComparison
} from "../../../runs/page-support-comparison/authority.js";
import {
  executePageSupportComparisonFill, preparePageSupportComparison,
  readPageSupportComparisonResults
} from "../../../runs/page-support-comparison/execute.js";
import {
  PAGE_SUPPORT_COMPARISON_SYSTEM_PROMPT, PAGE_SUPPORT_COMPARISON_WORKSET_CONTRACT,
  capturePageSupportOriginal, materializePageSupportComparisonLines,
  pageSupportComparisonCacheKey, pageSupportComparisonResponseJsonSchema,
  parsePageSupportComparisonWorkset
} from "../../../runs/page-support-comparison/input.js";
import {
  inspectPageSupportComparisonShard, openPageSupportComparisonAttemptLedger,
  pageSupportComparisonShardPath
} from "../../../runs/page-support-comparison/persist.js";
import {
  evidenceSelectionCacheKey, EVIDENCE_SELECTION_WORKSET_CONTRACT, materializeEvidenceSelectionLines,
  parseEvidenceSelectionWorkset, SOURCE_EVIDENCE_SELECTION_SYSTEM_PROMPT, evidenceSelectionResponseJsonSchema
} from "../../../runs/evidence-selection/input.js";
import {
  SOURCE_EVIDENCE_PRESERVATION_WORKSET_CONTRACT, materializeSourceEvidencePreservationLines,
  parseSourceEvidencePreservationWorkset, SOURCE_EVIDENCE_PRESERVATION_SYSTEM_PROMPT,
  sourceEvidencePreservationResponseJsonSchema, sourceEvidencePreservationCacheKey
} from "../../../runs/source-evidence-preservation/input.js";

const MODEL = "gemini-3.1-flash-lite";
const PROFILE = "gemini-3.1-minimal-v1" as const;
const KEEP = "Lee left the lab on Tuesday after the sample arrived.";
const KEEP_QUOTE = "Lee left the lab on Tuesday";
const BREAK = "I am thinking of adding the series to my watch list next month.";
const BREAK_QUOTE = "adding the series to my watch list";
const ADVICE = "Advice: always label the sample before shipping.";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("captures native first-page originals anonymously and keeps query_as_of unknown in the request", () => {
  const native = {
    object_kind: "source_evidence",
    target: {
      kind: "source_evidence",
      workspace_id: "access-ceiling-pilot20-6cb6f249-82",
      root_id: "sha256:66bb3ace6cd9021c4f8ad4c37c4fadfeea8368fc204d392662e16f29015543e6",
      source_version: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
      span: {
        content_start: 0, content_end: Buffer.byteLength(KEEP, "utf8"),
        retained_extent: "body" as const, content_complete: false, original_complete: false
      }
    },
    content_preview: KEEP,
    source_disclosure: disclosure({ kind: "known", at: "2023-05-22T03:27:00.000Z" }),
    selection_reason: "Source evidence without a proved semantic answer; claim unknown."
  };
  const captured = capturePageSupportOriginal(native);
  expect(captured).toEqual({
    text: KEEP,
    source_disclosure: native.source_disclosure,
    span: native.target.span,
    preview_sha256: sha(KEEP)
  });
  expect(JSON.stringify(captured)).not.toMatch(/root_id|workspace_id|selection_reason|6cb6f249/u);
  const prepared = parsePageSupportComparisonWorkset({
    contract: PAGE_SUPPORT_COMPARISON_WORKSET_CONTRACT,
    model: MODEL, provider_url: "http://127.0.0.1:9", request_profile: PROFILE,
    items: [{
      pair_id: "parent-only-map-6cb6f249",
      question: "Did I complete a social-media break?",
      query_as_of: { status: "unknown", reason: "evaluator_gold_private_label" },
      arm_a: [captured],
      arm_b: [original(BREAK, { kind: "known", at: "2023-03-14T15:01:00.000Z" })]
    }]
  });
  const line = materializePageSupportComparisonLines(prepared, 128)[0]!;
  const prompt = JSON.parse(line.userPrompt) as {
    question: string;
    query_as_of: unknown;
    arm_a: Array<{ text: string; source_disclosure: SourceDisclosure }>;
    pair_id?: unknown;
  };
  expect(prompt).toMatchObject({
    question: "Did I complete a social-media break?",
    query_as_of: { status: "unknown" }
  });
  expect(prompt.query_as_of).toEqual({ status: "unknown" });
  expect(line.userPrompt).not.toContain("evaluator_gold_private_label");
  expect(line.userPrompt).not.toContain("parent-only-map-6cb6f249");
  expect(line.userPrompt).not.toMatch(/qid|gold|proposed|default|treatment|selection_reason/u);
  expect(sourceDisclosure(prompt.arm_a[0]!.source_disclosure).proof_use).toEqual({
    kind: "source_only", qualification: "not_current_proof"
  });
  expect(sourceDisclosure(prompt.arm_a[0]!.source_disclosure).evaluated_as_of).toBe("2024-06-01T00:00:00.000Z");
  expect(PAGE_SUPPORT_COMPARISON_SYSTEM_PROMPT).toMatch(/evaluated_as_of is a runtime evaluation/u);
  expect(PAGE_SUPPORT_COMPARISON_SYSTEM_PROMPT).toMatch(/future intention/u);
  expect(PAGE_SUPPORT_COMPARISON_SYSTEM_PROMPT).not.toMatch(/Lee left|watch list/u);
  expect(projectGeminiGenerationSchema(pageSupportComparisonResponseJsonSchema()).schema).toBeDefined();
  expect(() => parsePageSupportComparisonWorkset({
    ...prepared, items: [{ ...prepared.items[0], query_as_of: { status: "known" } }]
  })).toThrow();
});

it("admits exact quotes over loopback HTTP and replays reserved raw and settled cache without a second dispatch or bill", async () => {
  const captured: { hits: number; reservedLedger?: string; urls: string[] } = { hits: 0, urls: [] };
  const server = await listen((req, res) => {
    captured.hits += 1;
    captured.urls.push(req.url ?? "");
    captured.reservedLedger = readFileSync(ledgerPath, "utf8");
    succeed(res, assessedBody(), "STOP", usage());
  });
  const origin = originOf(server);
  const cacheRoot = join(tempRoot(), "cache");
  const prepared = workset(origin);
  const preflight = preparePageSupportComparison(prepared, cacheRoot, 128);
  expect(preflight).toMatchObject({
    contract: "page-support-comparison-preflight-v1",
    maximum_attempts_per_key: 1,
    maximum_attempts: 1,
    missing: 1,
    provider_calls: 0
  });
  const estimated = quotePageSupportComparison(preflight, 4, 18);
  const authority = pinPageSupportComparisonAuthority({
    preflight, inputUsdPerMillion: 4, outputUsdPerMillion: 18
  });
  expect(authority.price.estimated_upper_usd).toBe(estimated);
  expect(authority.limits.max_concurrency).toBe(1);
  const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
  const config = configOf(origin);
  const first = await executePageSupportComparisonFill({
    workset: prepared, cacheRoot, authority, config,
    extractor: createSemanticProviderHttpExtractor(config, PAGE_SUPPORT_COMPARISON_SCHEMA_NAME)
  });
  const key = authority.keys[0]!;
  const bound = readPageSupportComparisonResults(prepared, cacheRoot, 128)[0];
  expect(first).toMatchObject({ attempts: 1, newly_admitted: 1, assessed: 1, cache_hits: 0 });
  expect(captured.hits).toBe(1);
  expect(captured.urls[0]).toBe("/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse");
  expect(bound).toMatchObject({
    status: "assessed",
    assessment: {
      status: "assessed",
      claims: [{
        claim: "Lee left the lab on Tuesday.",
        support: "both",
        a_quotes: [{ source_index: 0, quote: KEEP_QUOTE }],
        b_quotes: [{ source_index: 0, quote: KEEP_QUOTE }]
      }],
      answer_a: "partial",
      answer_b: "partial"
    }
  });
  expect(JSON.stringify(bound?.assessment)).not.toMatch(/gain|loss|not_relevant/u);
  expect(openPageSupportComparisonAttemptLedger({ cacheRoot, authority }).snapshot()).toMatchObject({
    successfulKeys: [key], telemetry: { totalTokens: 18 }
  });
  expect(inspectPageSupportComparisonShard(cacheRoot, key, {
    model: MODEL, request_profile: PROFILE
  })?.admitted).toBe(true);

  const settledReplay = await executePageSupportComparisonFill({
    workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
  });
  expect(settledReplay).toMatchObject({ cache_hits: 1, newly_admitted: 0, assessed: 1, attempts: 0 });
  expect(captured.hits).toBe(1);
  expect(openPageSupportComparisonAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens)
    .toBe(18);

  unlinkSync(pageSupportComparisonShardPath(cacheRoot, key));
  writeFileSync(ledgerPath, captured.reservedLedger!);
  const rawReplay = await executePageSupportComparisonFill({
    workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
  });
  expect(rawReplay).toMatchObject({ newly_admitted: 1, assessed: 1, attempts: 1 });
  expect(captured.hits).toBe(1);
  expect(openPageSupportComparisonAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens)
    .toBe(18);
  expect(readPageSupportComparisonResults(prepared, cacheRoot, 128)[0]?.status).toBe("assessed");
  server.closeAllConnections();
  await closeServer(server);
});

it.each([
  { basis: STEP_PLAN_QUOTE_BASIS, path: "/step_plan/v1/chat/completions" },
  { basis: STEP_OPENAPI_QUOTE_BASIS, path: "/v1/chat/completions" }
])("requests full Step HTTP evidence over 64KiB on $path and resumes from the written raw", async ({ basis, path }) => {
  const content = JSON.stringify(assessedBody());
  const wire =
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "r".repeat(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES) } }] })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    })}\n\ndata: [DONE]\n\n`;
  const originalBytes = Buffer.from(wire);
  expect(originalBytes.length).toBeGreaterThan(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES);
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
    vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "true");
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = stepWorkset(basis);
    const preflight = preparePageSupportComparison(prepared, cacheRoot, 128);
    expect(preflight.quote_basis).toMatchObject(basis);
    const authority = pinPageSupportComparisonAuthority({
      preflight,
      inputUsdPerMillion: 0.14,
      outputUsdPerMillion: 0.42
    });
    ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
    const config = stepConfig(basis);
    const first = await executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, config
    });
    const key = authority.keys[0]!;
    expect(first).toMatchObject({ attempts: 1, newly_admitted: 1, assessed: 1, cache_hits: 0 });
    expect(captured.hits).toBe(1);
    expect(captured.urls[0]).toBe(path);
    const raw = readProviderRawAttempt(cacheRoot, key, 1)!;
    expect(raw.kind).toBe("page_support_comparison");
    expect(raw.http_response).toMatchObject({
      bodyByteLength: originalBytes.length, bodyComplete: true, bodyTruncated: false,
      bodySha256: createHash("sha256").update(originalBytes).digest("hex")
    });
    expect(Buffer.from(raw.http_response!.bodyBase64, "base64").equals(originalBytes)).toBe(true);
    expect(inspectProviderChatCompletionResponse(
      Buffer.from(raw.http_response!.bodyBase64, "base64"), raw.http_response!.contentType, 200,
      { sseCompletionPolicy: "require_witness" }
    )).toMatchObject({ text: content, finishReason: "stop",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } });
    unlinkSync(pageSupportComparisonShardPath(cacheRoot, key));
    writeFileSync(ledgerPath, captured.reservedLedger!);
    const rawReplay = await executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
    });
    expect(rawReplay).toMatchObject({ newly_admitted: 1, assessed: 1, attempts: 1 });
    expect(captured.hits).toBe(1);
    expect(openPageSupportComparisonAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens)
      .toBe(18);
  } finally {
    globalThis.fetch = nativeFetch;
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await closeServer(server);
  }
});

it.each([
  {
    label: "wrong quote",
    body: assessedClaim({
      a_quotes: [{ source_index: 0, quote: "Lee never left the lab" }],
      b_quotes: [{ source_index: 0, quote: KEEP_QUOTE }]
    }),
    reason: "quote_mismatch"
  },
  {
    label: "invalid source index",
    body: assessedClaim({
      a_quotes: [{ source_index: 9, quote: KEEP_QUOTE }],
      b_quotes: [{ source_index: 0, quote: KEEP_QUOTE }]
    }),
    reason: "invalid_source_index"
  },
  {
    label: "both without b quotes",
    body: assessedClaim({
      support: "both",
      a_quotes: [{ source_index: 0, quote: KEEP_QUOTE }],
      b_quotes: []
    }),
    reason: "incoherent_support"
  }
])("rejects $label as a distinct failure without correcting model text", async (fixture) => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, fixture.body, "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin);
    const authority = pinPageSupportComparisonAuthority({
      preflight: preparePageSupportComparison(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const config = configOf(origin);
    const result = await executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, PAGE_SUPPORT_COMPARISON_SCHEMA_NAME)
    });
    expect(result).toMatchObject({ attempts: 1, newly_admitted: 0, assessed: 0, rejected: 1 });
    expect(captured.hits).toBe(1);
    const row = readPageSupportComparisonResults(prepared, cacheRoot, 128)[0];
    expect(row).toMatchObject({
      status: "invalid",
      shard: { admitted: false, outcome: { reason: fixture.reason } }
    });
    expect(row && "assessment" in row ? row.assessment : undefined).toBeUndefined();
    const snapshot = inspectLedger(cacheRoot, authority);
    expect(snapshot?.successfulKeys).toEqual([]);
    expect(snapshot?.settledAttempts.map((item) => item.cacheKey)).toEqual([authority.keys[0]]);
    expect(snapshot?.telemetry.totalTokens).toBe(18);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("keeps incomplete MAX_TOKENS output distinct from invalid, abstain, and unattempted", async () => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, assessedBody(), "MAX_TOKENS", usage());
  });
  try {
    const origin = originOf(server);
    const idleRoot = join(tempRoot(), "idle");
    expect(readPageSupportComparisonResults(workset("http://127.0.0.1:9"), idleRoot, 128)[0])
      .toMatchObject({ status: "unattempted" });
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin);
    const authority = pinPageSupportComparisonAuthority({
      preflight: preparePageSupportComparison(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const config = configOf(origin);
    const result = await executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, PAGE_SUPPORT_COMPARISON_SCHEMA_NAME)
    });
    expect(result).toMatchObject({ attempts: 1, newly_admitted: 0, incomplete: 1, assessed: 0 });
    expect(readPageSupportComparisonResults(prepared, cacheRoot, 128)[0]).toMatchObject({
      status: "incomplete",
      shard: { admitted: false, outcome: { status: "incomplete", reason: "noncomplete" }, finish_reason: "MAX_TOKENS" }
    });
    const replay = await executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
    });
    expect(replay).toMatchObject({ cache_hits: 1, attempts: 0, incomplete: 1 });
    expect(captured.hits).toBe(1);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("rejects mutated route before HTTP and mutated cache on read", async () => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, {
      status: "cannot_assess",
      claims: [],
      answer_a: "none",
      answer_b: "none",
      unresolved: ["The supplied pages lack a usable original."]
    }, "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin);
    const authority = pinPageSupportComparisonAuthority({
      preflight: preparePageSupportComparison(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    await expect(executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority,
      config: { ...configOf(origin), providerUrl: "http://127.0.0.1:9" }
    })).rejects.toThrow(/authorized request|model\/profile|transport/u);
    expect(captured.hits).toBe(0);

    const config = configOf(origin);
    const result = await executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, PAGE_SUPPORT_COMPARISON_SCHEMA_NAME)
    });
    expect(result).toMatchObject({ attempts: 1, abstained: 1, newly_admitted: 0, assessed: 0 });
    expect(readPageSupportComparisonResults(prepared, cacheRoot, 128)[0]?.status).toBe("abstained");

    const key = authority.keys[0]!;
    const shardPath = pageSupportComparisonShardPath(cacheRoot, key);
    const shard = JSON.parse(readFileSync(shardPath, "utf8")) as Record<string, unknown>;
    writeFileSync(shardPath, `${JSON.stringify({
      ...shard,
      transport_provenance: { ...(shard.transport_provenance as object), model: "gemini-2.5-flash-lite" }
    }, null, 2)}\n`);
    expect(() => readPageSupportComparisonResults(prepared, cacheRoot, 128)).toThrow(/identity mismatch/u);
    expect(preparePageSupportComparison(workset("http://127.0.0.1:9"), join(tempRoot(), "other"), 128).keys[0])
      .not.toBe(key);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("stops later keys after the first settled comparison without a second request or reservation", async () => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, assessedBody(), "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin, QUESTIONS);
    const authority = pinPageSupportComparisonAuthority({
      preflight: preparePageSupportComparison(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    expect(authority.keys).toHaveLength(3);
    const config = configOf(origin);
    const firstKey = authority.keys[0]!;
    const result = await executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, PAGE_SUPPORT_COMPARISON_SCHEMA_NAME),
      continueAfterResult: (key) => {
        expect(key).toBe(firstKey);
        expect(captured.hits).toBe(1);
        expect(readPageSupportComparisonResults(prepared, cacheRoot, 128).map((row) => row.status))
          .toEqual(["assessed", "unattempted", "unattempted"]);
        expect(inspectLedger(cacheRoot, authority)).toMatchObject({
          attempts: 1, successfulKeys: [firstKey], pendingKeys: [], unresolvedAttempts: []
        });
        return false;
      }
    });
    expect(captured.hits).toBe(1);
    expect(result).toMatchObject({
      attempts: 1, newly_admitted: 1, assessed: 1, unattempted: 2, cache_hits: 0
    });
    const snapshot = inspectLedger(cacheRoot, authority);
    expect(snapshot).toMatchObject({ attempts: 1, successfulKeys: [firstKey], pendingKeys: [] });
    for (const key of authority.keys.slice(1)) {
      expect(readProviderRawAttempt(cacheRoot, key, 1)).toBeUndefined();
      expect(snapshot?.settledAttempts.some((item) => item.cacheKey === key)).toBe(false);
    }
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("recovers retained raw without dispatching unknown or never-called keys and keeps failed usage distinct", async () => {
  let hits = 0;
  let reservedLedger = "";
  const server = await listen((_req, res) => {
    hits += 1;
    reservedLedger = readFileSync(ledgerPath, "utf8");
    succeed(res, assessedBody(), "STOP", usage());
  });
  const origin = originOf(server);
  const cacheRoot = join(tempRoot(), "cache");
  const prepared = workset(origin, QUESTIONS);
  const authority = pinPageSupportComparisonAuthority({
    preflight: preparePageSupportComparison(prepared, cacheRoot, 128),
    inputUsdPerMillion: 4, outputUsdPerMillion: 18
  });
  const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
  const config = configOf(origin);
  const http = createSemanticProviderHttpExtractor(config, PAGE_SUPPORT_COMPARISON_SCHEMA_NAME);
  let extractorCalls = 0;
  const extractor = { ...http, extract: async (input: Parameters<typeof http.extract>[0]) => {
    extractorCalls += 1;
    if (extractorCalls > 1) throw new Error("interrupted after reservation, before transport");
    return http.extract(input);
  } };
  try {
    await expect(executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, config, extractor
    })).rejects.toThrow("interrupted after reservation");
    expect(hits).toBe(1);
    const before = openPageSupportComparisonAttemptLedger({ cacheRoot, authority }).snapshot();
    expect(before.attempts).toBe(2);
    const partial = await executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, mode: "recover",
      config: { ...config, apiKey: null }, extractor
    });
    expect(partial).toMatchObject({ attempts: 0, assessed: 1, unknown: 1, unattempted: 1 });
    expect(readPageSupportComparisonResults(prepared, cacheRoot, 128).map((row) => row.status))
      .toEqual(["assessed", "unknown", "unattempted"]);
    expect(openPageSupportComparisonAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens)
      .toBe(18);

    unlinkSync(pageSupportComparisonShardPath(cacheRoot, authority.keys[0]!));
    writeFileSync(ledgerPath, reservedLedger);
    expect(await executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, mode: "recover",
      config: { ...config, apiKey: null }
    })).toMatchObject({ attempts: 0, newly_admitted: 1, assessed: 1, unattempted: 2 });
    expect(hits).toBe(1);
    expect(extractorCalls).toBe(2);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("reads HTTP transport failure as transport_failure and does not manufacture zero gain or loss", async () => {
  const server = await listen((_req, res) => {
    res.statusCode = 500;
    res.end("provider unavailable");
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache-fail");
    const prepared = workset(origin);
    const authority = pinPageSupportComparisonAuthority({
      preflight: preparePageSupportComparison(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const config = configOf(origin);
    const result = await executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, PAGE_SUPPORT_COMPARISON_SCHEMA_NAME)
    });
    expect(result).toMatchObject({ attempts: 1, newly_admitted: 0, assessed: 0, terminal_failures: 1 });
    const row = readPageSupportComparisonResults(prepared, cacheRoot, 128)[0];
    expect(row).toMatchObject({ status: "transport_failure" });
    expect(row && "assessment" in row ? row.assessment : undefined).toBeUndefined();
    expect(JSON.stringify(row)).not.toMatch(/gain_without_loss|loss-only|unchanged/u);
    const snapshot = inspectLedger(cacheRoot, authority);
    expect(snapshot?.successfulKeys).toEqual([]);
    expect(snapshot?.transportFailures.map((item) => item.cacheKey)).toEqual([authority.keys[0]]);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("releases the writer lease when continuation throws after a settled comparison", async () => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, assessedBody(), "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin, QUESTIONS.slice(0, 2));
    const authority = pinPageSupportComparisonAuthority({
      preflight: preparePageSupportComparison(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const config = configOf(origin);
    const firstKey = authority.keys[0]!;
    await expect(executePageSupportComparisonFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, PAGE_SUPPORT_COMPARISON_SCHEMA_NAME),
      continueAfterResult: () => {
        throw new Error("continueAfterResult rejected further comparison");
      }
    })).rejects.toThrow(/continueAfterResult rejected further comparison/u);
    expect(captured.hits).toBe(1);
    const lease = acquireExtractionCacheWriteLease(cacheRoot);
    lease.release();
    expect(readPageSupportComparisonResults(prepared, cacheRoot, 128).map((row) => row.status))
      .toEqual(["assessed", "unattempted"]);
    expect(inspectLedger(cacheRoot, authority)?.successfulKeys).toEqual([firstKey]);
    expect(readProviderRawAttempt(cacheRoot, authority.keys[1]!, 1)).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("keeps historical selection and preservation keys unchanged beside the comparison schema", () => {
  const origin = "http://127.0.0.1:9";
  const compared = materializePageSupportComparisonLines(workset(origin), 128)[0]!;
  const selected = parseEvidenceSelectionWorkset({
    contract: EVIDENCE_SELECTION_WORKSET_CONTRACT, model: MODEL, provider_url: origin, request_profile: PROFILE,
    items: [{
      original_question: QUESTIONS[0],
      sources: [
        { root_id: "src-keep", version: "v1", digest: `sha256:${"a".repeat(64)}`, span: { start: 0, end: KEEP.length }, preview: KEEP }
      ]
    }]
  });
  const selection = materializeEvidenceSelectionLines(selected, 128)[0]!;
  expect(evidenceSelectionCacheKey({
    model: MODEL, requestProfile: PROFILE, systemPrompt: SOURCE_EVIDENCE_SELECTION_SYSTEM_PROMPT,
    userPrompt: selection.userPrompt, schema: evidenceSelectionResponseJsonSchema(),
    maxOutputTokens: 128, providerUrl: selected.provider_url
  })).toBe(selection.key);
  expect(compared.key).not.toBe(selection.key);
  const preserved = parseSourceEvidencePreservationWorkset({
    contract: SOURCE_EVIDENCE_PRESERVATION_WORKSET_CONTRACT,
    model: MODEL, provider_url: origin, request_profile: PROFILE,
    items: [{
      question: QUESTIONS[0],
      unknown: { query_as_of: { status: "unknown" } },
      baseline: { items: [{
        root_id: "src-keep", source_version: "v1", content_digest: `sha256:${"a".repeat(64)}`,
        span: { content_start: 0, content_end: Buffer.byteLength(KEEP, "utf8"), retained_extent: "body",
          content_complete: true, original_complete: false },
        preview_sha256: sha(KEEP), source_disclosure: disclosure({ kind: "known", at: "2024-05-01T12:00:00.000Z" }),
        text: KEEP
      }] },
      candidate: { items: [] }
    }]
  });
  const preservation = materializeSourceEvidencePreservationLines(preserved, 128)[0]!;
  expect(sourceEvidencePreservationCacheKey({
    model: MODEL, requestProfile: PROFILE, systemPrompt: SOURCE_EVIDENCE_PRESERVATION_SYSTEM_PROMPT,
    userPrompt: preservation.userPrompt, schema: sourceEvidencePreservationResponseJsonSchema(),
    maxOutputTokens: 128, providerUrl: preserved.provider_url
  })).toBe(preservation.key);
  expect(compared.key).not.toBe(preservation.key);
  expect(pageSupportComparisonCacheKey({
    model: MODEL, requestProfile: PROFILE, systemPrompt: PAGE_SUPPORT_COMPARISON_SYSTEM_PROMPT,
    userPrompt: compared.userPrompt, schema: pageSupportComparisonResponseJsonSchema(),
    maxOutputTokens: 128, providerUrl: origin
  })).toBe(compared.key);
});

it("binds a_only, b_only, and both from exact source indexes and rejects not_relevant auto-approval", () => {
  const prepared = parsePageSupportComparisonWorkset({
    contract: PAGE_SUPPORT_COMPARISON_WORKSET_CONTRACT,
    model: MODEL, provider_url: "http://127.0.0.1:9", request_profile: PROFILE,
    items: [{
      question: QUESTIONS[0],
      query_as_of: { status: "unknown" },
      arm_a: [original(KEEP, { kind: "known", at: "2024-05-01T12:00:00.000Z" })],
      arm_b: [original(BREAK, { kind: "known", at: "2024-05-02T12:00:00.000Z" })]
    }]
  });
  const line = materializePageSupportComparisonLines(prepared, 128)[0]!;
  const aOnly = interpret(line, {
    status: "assessed",
    claims: [{
      claim: "Lee left the lab on Tuesday.",
      support: "a_only",
      qualifications: ["Departure is reported only on arm_a."],
      a_quotes: [{ source_index: 0, quote: KEEP_QUOTE }],
      b_quotes: [],
      uncertainty: "Speaker identity is unknown."
    }],
    answer_a: "partial",
    answer_b: "none",
    unresolved: []
  });
  expect(aOnly).toMatchObject({ classified: "interpreted", admitted: true, outcome: { status: "assessed" } });
  const bOnly = interpret(line, {
    status: "assessed",
    claims: [{
      claim: "The speaker intends to add a series to a watch list.",
      support: "b_only",
      qualifications: ["This is a future intention, not a completed addition."],
      a_quotes: [],
      b_quotes: [{ source_index: 0, quote: BREAK_QUOTE }],
      uncertainty: "The addition has not occurred."
    }],
    answer_a: "none",
    answer_b: "partial",
    unresolved: []
  });
  expect(bOnly.outcome).toMatchObject({ status: "assessed", claims: [{ support: "b_only" }] });
  expect(interpret(line, {
    status: "assessed",
    claims: [{
      claim: "Lee left.",
      support: "a_only",
      qualifications: [],
      a_quotes: [{ source_index: 0, quote: KEEP_QUOTE }],
      b_quotes: [{ source_index: 0, quote: BREAK_QUOTE }],
      uncertainty: "x"
    }],
    answer_a: "partial", answer_b: "partial", unresolved: []
  }).outcome).toMatchObject({ status: "invalid", reason: "incoherent_support" });
  expect(interpret(line, {
    status: "assessed",
    records: [{ disposition: "not_relevant" }],
    answer_a: "complete", answer_b: "complete", unresolved: []
  }).outcome).toMatchObject({ status: "invalid", reason: "invalid_shape" });
});

function interpret(
  line: ReturnType<typeof materializePageSupportComparisonLines>[number], body: unknown
) {
  return interpretPageSupportComparisonDecoded(line, {
    rawJson: typeof body === "string" ? body : JSON.stringify(body), finishReason: "STOP"
  }, PROFILE);
}

const QUESTIONS = [
  "Who left after the sample arrived?",
  "When did Lee leave?",
  "What arrived?"
] as const;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "page-support-comparison-"));
  roots.push(root);
  return root;
}

function workset(providerUrl: string, questions: readonly string[] = [QUESTIONS[0]]) {
  return parsePageSupportComparisonWorkset({
    contract: PAGE_SUPPORT_COMPARISON_WORKSET_CONTRACT,
    model: MODEL, provider_url: providerUrl, request_profile: PROFILE,
    items: questions.map((question) => ({
      question,
      query_as_of: { status: "unknown" as const },
      arm_a: [original(KEEP, { kind: "known", at: "2024-05-01T12:00:00.000Z" })],
      arm_b: [original(KEEP, { kind: "known", at: "2024-05-01T12:00:00.000Z" }),
        original(ADVICE, { kind: "known", at: "2024-05-02T12:00:00.000Z" })]
    }))
  });
}

function original(text: string, source_time: SourceDisclosureSemantic["source_time"], content_start = 0) {
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    text,
    source_disclosure: disclosure(source_time),
    span: {
      content_start,
      content_end: content_start + bytes,
      retained_extent: "body" as const,
      content_complete: content_start === 0,
      original_complete: false
    },
    preview_sha256: sha(text)
  };
}

function disclosure(source_time: SourceDisclosureSemantic["source_time"]): SourceDisclosure {
  return encodeSourceDisclosure({
    material_kind: "original_body",
    source_binding: "checked_record",
    evaluated_as_of: "2024-06-01T00:00:00.000Z",
    source_time,
    validity: { kind: "unknown", reason: "not_recorded" },
    temporal_state: "unknown",
    proof_use: { kind: "source_only", qualification: "not_current_proof" }
  });
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function inspectLedger(cacheRoot: string, authority: ReturnType<typeof pinPageSupportComparisonAuthority>) {
  return inspectExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: authority.attempt_lineage_digest,
    cacheIdentity: { model: MODEL, requestProfile: PROFILE }
  });
}

function configOf(origin: string): CompileSeedExtractionConfig {
  return { providerUrl: origin, model: MODEL, requestProfile: PROFILE, apiKey: "loopback-only" };
}

function stepWorkset(basis: typeof STEP_PLAN_QUOTE_BASIS | typeof STEP_OPENAPI_QUOTE_BASIS = STEP_PLAN_QUOTE_BASIS) {
  return parsePageSupportComparisonWorkset({
    ...workset(new URL(basis.selected_provider_url).origin),
    model: basis.selected_model,
    provider_url: basis.selected_provider_url,
    request_profile: "step-3.5-2603-low-json-schema-v1"
  });
}

function stepConfig(basis: typeof STEP_PLAN_QUOTE_BASIS | typeof STEP_OPENAPI_QUOTE_BASIS = STEP_PLAN_QUOTE_BASIS): CompileSeedExtractionConfig {
  return {
    providerUrl: basis.selected_provider_url,
    model: basis.selected_model,
    requestProfile: "step-3.5-2603-low-json-schema-v1",
    apiKey: "loopback-only"
  };
}

function usage() {
  return { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
}

function assessedClaim(overrides: {
  support?: "a_only" | "b_only" | "both";
  a_quotes?: readonly { source_index: number; quote: string }[];
  b_quotes?: readonly { source_index: number; quote: string }[];
}) {
  return {
    status: "assessed" as const,
    claims: [{
      claim: "Lee left the lab on Tuesday.",
      support: overrides.support ?? "both",
      qualifications: ["First-person departure report."],
      a_quotes: overrides.a_quotes ?? [{ source_index: 0, quote: KEEP_QUOTE }],
      b_quotes: overrides.b_quotes ?? [{ source_index: 0, quote: KEEP_QUOTE }],
      uncertainty: "Speaker identity is unknown."
    }],
    answer_a: "partial" as const,
    answer_b: "partial" as const,
    unresolved: ["Person identity is unknown."]
  };
}

function assessedBody() {
  return assessedClaim({});
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
    candidates: [{
      finishReason,
      content: { parts: [{ text: typeof body === "string" ? body : JSON.stringify(body) }] }
    }],
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
