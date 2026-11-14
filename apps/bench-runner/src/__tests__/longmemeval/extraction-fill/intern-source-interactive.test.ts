import { Ajv2020 } from "ajv/dist/2020.js";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async (_host: string, options?: { all?: boolean }) => {
  const answer = { address: "93.184.216.34", family: 4 }; return options?.all ? [answer] : answer;
}) }));

import { INTERN_SEMANTIC_REQUEST_MODEL as MODEL, INTERN_SEMANTIC_REQUEST_PROFILE as PROFILE,
  INTERN_SEMANTIC_PROVIDER_URL as ENDPOINT, SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT } from "@do-soul/alaya-protocol";
import { buildOfficialApiSourceCorpus, parseSourceSemanticRequest, sourceSemanticResponseJsonSchema,
  SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT } from "@do-soul/alaya-soul";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { createExtractionExecutionAuthority } from "../../../runs/extraction/fill/execution-authority.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { readCachedEntry } from "../../../runs/compile-seed/cache/cache-shard.js";
import { listProviderRawAttempts, requestEnvelopeDigest } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { preflightSourceSemanticInteractive, parseSourceSemanticInteractivePreflight } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { INTERN_DISCOVERY_QUOTE_BASIS } from "../../../runs/extraction/authority/intern-quote.js";
import { prepareSourceSemanticRequestWire } from "../../../runs/extraction/fill/source-semantic-interactive-request.js";
import { settledAttemptUsageDigest } from "../../../runs/extraction/authority/attempt-ledger/outcome.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";
import { tableCompletedResponse, inlineCompletedResponse } from "./source-semantic-table-response.test-support.js";
import { computeCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import { preflightExtractionBatch } from "../../../runs/extraction/fill/batch-preflight.js";
import { authoredSourceCorpusFromRequest, openAuthoredHistoricalAttemptLedger,
  writeAuthoredHistoricalChatArtifact } from "./historical-extraction-test-support.js";

let roots: { cacheRoot: string; dataDir: string; pinnedMetaRoot: string };
const writeDataset = registerExtractionFillHooks(value => { roots = value; }, "longmemeval_s");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function scenario(projected = false, profile: typeof PROFILE | "intern-agents-a1-json-schema-v1" = PROFILE,
  inline = false, outputCap = 8192) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", profile);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", ENDPOINT);
  await writeDataset([buildExtractionFillQuestion("completed", "I completed alpha.", "I completed decoy.")]);
  const options = { ...roots, variant: "longmemeval_s" as const, sourcePacking: "complete-source" as const,
    openSemantics: { ...EXTRACTION_OPEN_SEMANTICS_GENERATION,
      ...(projected ? { generation_view_contract: SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT } : {}),
      ...(inline ? { generation_schema_contract: SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT } : {}) }, concurrency: 1, log: () => undefined };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  const selected = inspection.missingKeys.slice(0, 1);
  const preflight = await preflightSourceSemanticInteractive({ ...options, preflightKeys: selected,
    preflightOutputTokenCap: outputCap });
  const receipt = createExtractionAuthorityReceipt({ action: "sample",
    sampleScope: createExtractionSampleScope(selected, inspection), observation: inspection.observation,
    inspection, maxConcurrency: 1, sourcePreflight: preflight,
    outputTokenCap: { field: "max_tokens", value: outputCap }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0, outputUsdPerMillion: 0,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const receiptPath = join(roots.cacheRoot, "source-authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  return { options: { ...options, authorityReceiptPath: receiptPath }, selected, preflight, receipt };
}

type Fixture = Awaited<ReturnType<typeof scenario>>;
type ReportedUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

function sourceCandidates(): string[] {
  return ["I completed alpha.", "I completed decoy."].flatMap(fact => {
    const messages = [{ role: "user" as const, content: fact },
      { role: "assistant" as const, content: "Acknowledged." }];
    return [fact, `User: ${fact}`, `User: ${fact}\nAssistant: Acknowledged.`,
      buildOfficialApiSourceCorpus(fact, messages),
      buildOfficialApiSourceCorpus(fact, [{ role: "user", content: fact }]),
      buildOfficialApiSourceCorpus(`${fact}\nAcknowledged.`, messages)];
  });
}

// Explicitly authored retained bytes, never a replay of the retired producer.
async function authorResponse(fixture: Fixture, options: {
  finish?: "stop" | "length"; rawJson?: string; usage?: ReportedUsage;
  invalidUsage?: boolean; commitSuccess?: boolean; inline?: boolean;
} = {}) {
  const line = fixture.preflight.planned_requests[0]!;
  const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
  const assertion = request.source_request.source_assertions.find(row => row.text.includes("completed"))!;
  const rawJson = options.rawJson ?? JSON.stringify((options.inline ? inlineCompletedResponse : tableCompletedResponse)(
    assertion.assertion_id, assertion.text.includes("alpha") ? "alpha" : "decoy"));
  const finish = options.finish ?? "stop";
  const wire = JSON.stringify({ choices: [{ message: { content: rawJson, reasoning_content: "reasoning only" },
    finish_reason: finish }], ...(options.usage === undefined ? {} : { usage: options.usage }) });
  const usage = options.usage === undefined ? null : { inputTokens: options.usage.prompt_tokens,
    outputTokens: options.usage.completion_tokens, totalTokens: options.usage.total_tokens };
  const prepared = prepareSourceSemanticRequestWire({ ...fixture.preflight.config,
    openSemantics: fixture.options.openSemantics }, line, fixture.preflight.max_output_tokens);
  expect(line.request_digest).toBe(requestEnvelopeDigest(JSON.stringify([prepared.url.href, prepared.body])));
  await writeAuthoredHistoricalChatArtifact({
    cacheRoot: roots.cacheRoot, receipt: fixture.receipt,
    line: { key: line.key, unitKeys: line.unitKeys, requestSha256: line.requestSha256,
      systemPrompt: line.systemPrompt, userPrompt: line.userPrompt },
    requestDigest: line.request_digest,
    rawJson, httpWire: wire, usage, finishReason: finish, generation: fixture.options.openSemantics,
    sourceCorpus: authoredSourceCorpusFromRequest(line.userPrompt, sourceCandidates()),
    ...(options.commitSuccess === undefined ? {} : { commitSuccess: options.commitSuccess }),
    ...(options.invalidUsage && usage !== null ? { invalidReportedUsage: usage } : {})
  });
  if (options.commitSuccess === false && !options.invalidUsage) {
    openAuthoredHistoricalAttemptLedger(roots.cacheRoot, fixture.receipt).abandonPendingShard(line.key, 1);
  }
  return { body: JSON.parse(prepared.body) as Record<string, unknown>, wire, rawJson };
}

async function expectRetiredRefusal(fixture: Fixture) {
  const before = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!);
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  await expect(runExtractionFill(fixture.options)).rejects.toThrow("retired passive generation");
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)).toEqual(before);
}

it.each([{ prompt_tokens: 10, completion_tokens: 2, total_tokens: 13 },
  { prompt_tokens: 10, completion_tokens: 8193, total_tokens: 8203 }])(
  "retains contradictory Intern usage and reopens accounting-invalid quarantine without dispatch", async usage => {
    const fixture = await scenario();
    await authorResponse(fixture, { usage, invalidUsage: true });
    const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
    expect(raw).toMatchObject({ usage_known: true, usage: { inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens }, http_response: { bodyComplete: true } });
    const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
    expect(reopened.snapshot()).toMatchObject({ unresolvedAttempts: [], pendingKeys: [], successfulShards: 0,
      settledAttempts: [{ attemptOrdinal: 1, usageAccounting: "invalid", usageSha256: settledAttemptUsageDigest(raw.usage) }],
      telemetry: { inputTokens: 0, outputTokens: 0, totalTokens: 0, usageUnknownAttempts: 1, usageInvalidAttempts: 1 } });
    await expect(reopened.reserveAttemptOrdinal!(raw.cache_key)).rejects.toThrow(/per-key attempt ceiling/u);
    expect(inspectCachedSourceSemantic(roots.cacheRoot, raw.cache_key, MODEL, PROFILE).status).not.toBe("hit");
    await expectRetiredRefusal(fixture);
  });

it.each([PROFILE, "intern-agents-a1-json-schema-v1"] as const)(
  "reopens authored %s JSON wire with finite limits and explicitly unknown usage", async profile => {
    const fixture = await scenario(false, profile);
    expect(fixture.preflight.quote_basis).toMatchObject(INTERN_DISCOVERY_QUOTE_BASIS);
    expect(fixture.preflight.cost_bound_usd).toBe(0);
    expect(fixture.preflight.input_token_bound).toBeGreaterThan(0);
    expect(fixture.preflight.planned_requests[0]?.wire_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.receipt.limits).toMatchObject({ maximum_attempts: 1, max_output_tokens: 8192 });
    const authored = await authorResponse(fixture);
    expect(Object.keys(authored.body).sort()).toEqual(profile === PROFILE
      ? ["max_tokens", "messages", "model"] : ["max_tokens", "messages", "model", "response_format"]);
    expect(authored.body).toMatchObject({ model: MODEL, max_tokens: 8192 });
    const line = fixture.preflight.planned_requests[0]!;
    const schema = sourceSemanticResponseJsonSchema(parseSourceSemanticRequest(JSON.parse(line.userPrompt)));
    expect(authored.body.response_format).toEqual(profile === PROFILE ? undefined : {
      type: "json_schema", json_schema: { name: "source_semantic", strict: true, schema }
    });
    expect(authored.body.messages).toEqual([
      { role: "system", content: `${line.systemPrompt}\n\nSchema identifier (metadata): "source_semantic"\nReturn only a JSON object conforming to this complete JSON Schema. Preserve every required field and constraint; the receiver validates the result.\n${JSON.stringify(schema)}` },
      { role: "user", content: line.userPrompt }
    ]);
    const otherProfile = profile === PROFILE ? "intern-agents-a1-json-schema-v1" : PROFILE;
    expect(computeCacheKey(MODEL, otherProfile, line.systemPrompt, line.userPrompt)).not.toBe(line.key);
    expect(() => parseSourceSemanticInteractivePreflight({ ...fixture.preflight,
      config: { ...fixture.preflight.config, requestProfile: otherProfile } })).toThrow();
    const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
    expect(raw).toMatchObject({ request_profile: profile, finish_reason: "stop", usage: null, usage_known: false,
      request_digest: line.request_digest, http_response: { contentType: "application/json",
        bodyBase64: Buffer.from(authored.wire).toString("base64"), bodyComplete: true } });
    const cached = readCachedEntry(roots.cacheRoot, fixture.selected[0]!, MODEL, profile);
    expect(cached.status === "hit" && cached.entry.source_semantic?.kind).toBe("intern_chat_completion");
    expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL, profile).status).toBe("hit");
    const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
    expect(reopened.snapshot()?.telemetry).toMatchObject({ usageUnknownAttempts: 1 });
    await expect(reopened.reserveAttemptOrdinal!(fixture.selected[0]!)).rejects.toThrow(/per-key attempt ceiling/u);
    expect(() => parseSourceSemanticInteractivePreflight({ ...fixture.preflight,
      max_output_tokens: 4096 })).toThrow(/encoded wire/u);
    await expectRetiredRefusal(fixture);
  });

it("retains interpreted-only inline bytes without admitting the invalid strict-schema response", async () => {
  const fixture = await scenario(true, "intern-agents-a1-json-schema-v1", true);
  const original = '{"contract":"source-semantic-proposal-v9","outcome":{"status":"interpreted"}}';
  const authored = await authorResponse(fixture, { rawJson: original, commitSuccess: false });
  const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
  expect(Buffer.byteLength(original)).toBe(77);
  expect(raw.decoded_text).toBe(original);
  expect(raw.http_response?.bodyBase64).toBe(Buffer.from(authored.wire).toString("base64"));
  const format = authored.body.response_format as { json_schema: { schema: object } };
  expect(new Ajv2020({ strict: false }).compile(format.json_schema.schema)(JSON.parse(original))).toBe(false);
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL,
    "intern-agents-a1-json-schema-v1").status).not.toBe("hit");
  await expectRetiredRefusal(fixture);
});

it("denies the strict semantic profile at Batch preflight and fill without dispatch", async () => {
  const fixture = await scenario(false, "intern-agents-a1-json-schema-v1");
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const batch = { operation: "prepare" as const, limits: {
    maxJobs: 1, maxRequestsPerJob: 1, maxFileBytes: 1_000_000,
    maxInputTokensPerJob: 1_000_000, maxEnqueuedTokens: 1_000_000, maxOutputTokens: 8192,
    maxUsd: 0, inputUsdPerMillion: 0, outputUsdPerMillion: 0,
    deadlineMs: 60_000, requestTimeoutMs: 5_000, maxPolls: 1
  } };
  const { authorityReceiptPath: _authorityReceiptPath, ...dry } = fixture.options;
  await expect(preflightExtractionBatch({ ...dry, batch })).rejects.toThrow(/unsupported Batch request profile/u);
  await expect(runExtractionFill({ ...fixture.options, batch })).rejects.toThrow("retired passive generation");
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("binds the independently expected generation view to preflight and retained request bytes", async () => {
  const fixture = await scenario(true), retained = fixture.preflight.planned_requests[0]!;
  const host = parseSourceSemanticRequest(JSON.parse(retained.userPrompt));
  const sourceText = retained.userPrompt.includes("alpha") ? "User: I completed alpha." : "User: I completed decoy.";
  const expectedView = { contract: "source-semantic-generation-view-v1",
    response_schema: sourceSemanticResponseJsonSchema(host), source_request: {
    source_scope: "complete-source", resource_limits: { output_byte_limit: 1048576 },
    attribution_context: { contract: "utterance-attribution-v1", status: "unknown" }, source_assertions: [
      { assertion_id: 1, text: sourceText, source_role: "user" },
      ...(sourceText.includes("alpha") ? [{ assertion_id: 2, text: "Assistant: Acknowledged.", source_role: "assistant" }] : [])
    ]
  } };
  const authored = await authorResponse(fixture);
  expect(host.source_request.generation_view_contract).toBe(SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT);
  expect(host.source_request.assertion_locations).toHaveLength(sourceText.includes("alpha") ? 2 : 1);
  const messages = authored.body.messages as { role: string; content: string }[];
  expect(messages[1]!.content).toBe(JSON.stringify(expectedView));
  const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
  expect(raw).toMatchObject({ source_request_sha256: retained.requestSha256, request_digest: retained.request_digest });
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL, PROFILE).status).toBe("hit");
  expect(() => parseSourceSemanticInteractivePreflight({ ...fixture.preflight,
    config: { ...fixture.preflight.config, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION } })).toThrow(/view differs/u);
  await expectRetiredRefusal(fixture);
});

it.each([{ finish: "length", rawJson: undefined }, { finish: "stop", rawJson: "{bad JSON" }] as const)(
  "retains $finish response bytes without cache admission or another attempt", async ({ finish, rawJson }) => {
    const fixture = await scenario();
    const authored = await authorResponse(fixture, { finish, ...(rawJson === undefined ? {} : { rawJson }), commitSuccess: false });
    const key = fixture.selected[0]!;
    const raw = listProviderRawAttempts(roots.cacheRoot, key)[0]!;
    expect(raw.finish_reason).toBe(finish);
    expect(raw.http_response?.bodyBase64).toBe(Buffer.from(authored.wire).toString("base64"));
    expect(inspectCachedSourceSemantic(roots.cacheRoot, key, MODEL, PROFILE).status).not.toBe("hit");
    await expect(createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot).reserveAttemptOrdinal!(key))
      .rejects.toThrow(/per-key attempt ceiling/u);
    await expectRetiredRefusal(fixture);
  });

it.each([PROFILE, "intern-agents-a1-json-schema-v1"] as const)(
  "keeps inline %s schema and authored response JSON bound on reopen", async profile => {
    const fixture = await scenario(true, profile, true);
    const authored = await authorResponse(fixture, { inline: true });
    const line = fixture.preflight.planned_requests[0]!;
    const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
    expect(request.source_request.proposal_contract).toBe("source-semantic-proposal-v9");
    expect(request.source_request.generation_schema_contract).toBe("host-owned-inline-entity-use-schema-v1");
    const messages = authored.body.messages as { role: string; content: string }[];
    expect(messages[0]!.content).toContain('"source-semantic-proposal-v9"');
    expect(messages[0]!.content).not.toContain('"semantic_key"');
    expect(messages[1]!.content).toBe(JSON.stringify({ contract: "source-semantic-generation-view-v1",
      response_schema: sourceSemanticResponseJsonSchema(request), source_request: {
      source_scope: "complete-source", resource_limits: { output_byte_limit: 1048576 },
      attribution_context: { contract: "utterance-attribution-v1", status: "unknown" },
      source_assertions: request.source_request.source_assertions
    } }));
    if (profile === "intern-agents-a1-json-schema-v1") {
      const format = authored.body.response_format as { json_schema: { schema: unknown } };
      expect(JSON.parse(messages[1]!.content).response_schema).toEqual(format.json_schema.schema);
    }
    const assertion = request.source_request.source_assertions.find(row => row.text.includes("completed"))!;
    expect(JSON.parse(authored.rawJson)).toEqual(inlineCompletedResponse(assertion.assertion_id,
      assertion.text.includes("alpha") ? "alpha" : "decoy"));
    const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
    expect(raw.decoded_text).toBe(authored.rawJson);
    expect(raw.http_response?.bodyBase64).toBe(Buffer.from(authored.wire).toString("base64"));
    expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL, profile).status).toBe("hit");
    await expectRetiredRefusal(fixture);
  });

it("reopens empty-final length as a consumed attempt with known usage and no cache", async () => {
  const fixture = await scenario(false, PROFILE, false, 16384);
  await authorResponse(fixture, { finish: "length", rawJson: "", commitSuccess: false,
    usage: { prompt_tokens: 2822, completion_tokens: 16384, total_tokens: 19206 } });
  const key = fixture.selected[0]!;
  const raw = listProviderRawAttempts(roots.cacheRoot, key)[0]!;
  expect(raw).toMatchObject({ decoded_text: "", finish_reason: "length", usage_known: true,
    usage: { inputTokens: 2822, outputTokens: 16384, totalTokens: 19206 }, http_response: { bodyComplete: true } });
  expect(raw.transport_failure).toBeUndefined();
  expect(inspectCachedSourceSemantic(roots.cacheRoot, key, MODEL, PROFILE).status).not.toBe("hit");
  const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
  expect(reopened.snapshot()).toMatchObject({ unresolvedAttempts: [], pendingKeys: [], successfulShards: 0, transportFailures: [],
    settledAttempts: [{ attemptOrdinal: 1, usageSha256: settledAttemptUsageDigest(raw.usage) }] });
  await expect(reopened.reserveAttemptOrdinal!(key)).rejects.toThrow(/per-key attempt ceiling/u);
  await expectRetiredRefusal(fixture);
});
