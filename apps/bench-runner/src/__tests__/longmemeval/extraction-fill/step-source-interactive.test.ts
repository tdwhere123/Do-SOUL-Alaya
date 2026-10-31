import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.hoisted(() => {
  for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(input)).hostname !== "127.0.0.1" || init?.redirect !== "error") throw new Error("only no-redirect loopback transport allowed");
    return nativeFetch(input, init);
  });
});
import { hasCompleteExtractionFillAuthority } from "../../../runs/extraction/fill/fill-authority.js";
import { STEP_SEMANTIC_HIGH_REQUEST_PROFILE, STEP_PREVIEW_REQUEST_PROFILE, STEP_PREVIEW_JSON_REQUEST_PROFILE,
  stepSemanticRequestModel, type StepSemanticRequestProfile } from "@do-soul/alaya-protocol";
import { buildOfficialApiSourceCorpus, parseSourceSemanticRequest, sourceSemanticRequestCatalog } from "@do-soul/alaya-soul";
import { MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES, MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES } from
  "@do-soul/alaya-engine-gateway";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from
  "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { assertExtractionAuthorityReceipt, createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from
  "../../../runs/extraction/authority/receipt.js";
import { createExtractionExecutionAuthority } from "../../../runs/extraction/fill/execution-authority.js";
import { assertInteractiveSourcePreflightReceipt } from "../../../runs/extraction/authority/source-preflight-binding.js";
import { STEP_OPENAPI_QUOTE_BASIS, STEP_PLAN_QUOTE_BASIS, STEP_PREVIEW_OPENAPI_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { assertNativeChatReportedUsage } from "../../../runs/extraction/authority/native-chat-quote.js";
import { inspectCachedSourceSemantic } from
  "../../../runs/extraction/cache/source-semantic-artifact.js";
import { inspectInteractiveTransportEvidence } from "../../../runs/extraction/cache/source-interactive-binding.js";
import { readCachedEntry } from "../../../runs/compile-seed/cache/cache-shard.js";
import { readExtractionCacheManifestIdentity } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { listProviderRawAttempts, providerRawAttemptPath, readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { parseSourceSemanticInteractivePreflight, preflightSourceSemanticInteractive } from
  "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { prepareSourceSemanticRequestWire } from "../../../runs/extraction/fill/source-semantic-interactive-request.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";
import { tableCompletedResponse } from "./source-semantic-table-response.test-support.js";
import {
  authoredSourceCorpusFromRequest,
  authoredStepHttpWire,
  writeAuthoredHistoricalStepArtifact
} from "./historical-extraction-test-support.js";

const MODEL = "step-3.5-flash-2603";
const PROFILE = "step-3.5-2603-low-json-schema-v1";
let roots: { cacheRoot: string; dataDir: string; pinnedMetaRoot: string };
const writeDataset = registerExtractionFillHooks(value => { roots = value; }, "longmemeval_s");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function responseFor(userPrompt: string): string {
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions.find(row => row.text.includes("completed"))!;
  const theme = assertion.text.includes("alpha") ? "alpha" : "decoy";
  return JSON.stringify(tableCompletedResponse(assertion.assertion_id, theme));
}

function stepSourceCandidates(): string[] {
  const candidates: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    for (const fact of [`I completed alpha. The record is ${i}.`, `I completed decoy. The record is ${i}.`]) {
      const messages = [{ role: "user" as const, content: fact }, { role: "assistant" as const, content: "Acknowledged." }];
      candidates.push(fact, `User: ${fact}`, `User: ${fact}\nAssistant: Acknowledged.`,
        buildOfficialApiSourceCorpus(fact, messages),
        buildOfficialApiSourceCorpus(fact, [{ role: "user", content: fact }]),
        buildOfficialApiSourceCorpus(`${fact}\nAcknowledged.`, messages));
    }
  }
  return candidates;
}

function plannedLine(fixture: Awaited<ReturnType<typeof scenario>>, key: string) {
  const planned = fixture.preflight.planned_requests.find(row => row.key === key);
  if (planned === undefined) throw new Error("missing planned request");
  return planned;
}

async function authorLine(
  fixture: Awaited<ReturnType<typeof scenario>>,
  key: string,
  extra: {
    rawJson?: string; finishReason?: string; padding?: string; bodyComplete?: boolean; commitSuccess?: boolean;
  } = {}
) {
  const planned = plannedLine(fixture, key);
  const rawJson = extra.rawJson ?? responseFor(planned.userPrompt);
  await writeAuthoredHistoricalStepArtifact({
    cacheRoot: roots.cacheRoot, receipt: fixture.receipt,
    line: {
      key: planned.key, unitKeys: planned.unitKeys, requestSha256: planned.requestSha256,
      systemPrompt: planned.systemPrompt, userPrompt: planned.userPrompt
    },
    requestDigest: planned.request_digest, rawJson,
    sourceCorpus: authoredSourceCorpusFromRequest(planned.userPrompt, stepSourceCandidates()),
    httpWire: authoredStepHttpWire(rawJson, undefined, extra.finishReason ?? "stop", extra.padding ?? ""),
    ...(extra.finishReason === undefined ? {} : { finishReason: extra.finishReason }),
    ...(extra.bodyComplete === undefined ? {} : { bodyComplete: extra.bodyComplete }),
    ...(extra.commitSuccess === undefined ? {} : { commitSuccess: extra.commitSuccess })
  });
  return rawJson;
}

async function scenario(selectedCount: number, outputTokenCap?: number, logicalModel = MODEL,
  quoteBasis: typeof STEP_PLAN_QUOTE_BASIS | typeof STEP_OPENAPI_QUOTE_BASIS | typeof STEP_PREVIEW_OPENAPI_QUOTE_BASIS = STEP_PLAN_QUOTE_BASIS,
  profile: StepSemanticRequestProfile = PROFILE) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", logicalModel);
  if (logicalModel !== stepSemanticRequestModel(profile)) {
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_TRANSPORT_MODEL", stepSemanticRequestModel(profile));
  }
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", profile);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", quoteBasis.selected_provider_url);
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
    output_token_field: "max_tokens", quote_basis: quoteBasis
  });
  expect(preflight.planned_requests.map(row => row.key).sort()).toEqual([...selected].sort());
  expect(parseSourceSemanticInteractivePreflight(JSON.parse(JSON.stringify(preflight)))).toEqual(preflight);
  const scope = createExtractionSampleScope(selected, inspection);
  const receiptInput = { action: "sample" as const, sampleScope: scope,
    observation: inspection.observation, inspection, maxConcurrency: 1,
    sourcePreflight: preflight,
    outputTokenCap: { field: "max_tokens", value: outputTokenCap ?? 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: quoteBasis.input_usd_equivalent_per_million,
      outputUsdPerMillion: quoteBasis.output_usd_equivalent_per_million,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } } as const;
  const receipt = createExtractionAuthorityReceipt(receiptInput);
  expect(receipt.limits.maximum_attempts).toBe(selectedCount);
  expect(receipt.price.quote_basis).toEqual(preflight.quote_basis);
  const receiptPath = join(roots.cacheRoot, "step-sample-authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  return { options: { ...options, authorityReceiptPath: receiptPath }, selected, preflight, receipt,
    receiptInput };
}

it("keeps a fully settled interactive sample partial across warm replay", async () => {
  const fixture = await scenario(6);
  for (const key of fixture.selected) await authorLine(fixture, key);
  const manifest = readExtractionCacheManifestIdentity(roots.cacheRoot)!.manifest;
  expect(manifest.fill_status).toBe("in_progress");
  expect(manifest.content_closure_index).toBeUndefined();
  expect(hasCompleteExtractionFillAuthority(manifest)).toBe(false);
  for (const key of fixture.selected) {
    expect(inspectCachedSourceSemantic(roots.cacheRoot, key, MODEL, PROFILE).status).toBe("hit");
  }
  await expect(runExtractionFill(fixture.options)).rejects.toThrow("retired passive generation");
  expect(hasCompleteExtractionFillAuthority(readExtractionCacheManifestIdentity(roots.cacheRoot)!.manifest)).toBe(false);
});

it("reopens a configured logical model alias through its recorded Step transport", async () => {
  const logicalModel = "fixture-step-alias";
  const fixture = await scenario(1, undefined, logicalModel);
  await authorLine(fixture, fixture.selected[0]!);
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, logicalModel, PROFILE))
    .toMatchObject({ status: "hit", transportProvenance: { model: MODEL } });
  await expect(runExtractionFill(fixture.options)).rejects.toThrow("retired passive generation");
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, logicalModel, PROFILE).status).toBe("hit");
});

it("rejects a changed current Step wire digest while retained accounting stays unbound", async () => {
  const fixture = await scenario(1);
  const key = fixture.selected[0]!;
  await authorLine(fixture, key);
  const cached = readCachedEntry(roots.cacheRoot, key, MODEL, PROFILE);
  if (cached.status !== "hit" || cached.entry.source_semantic?.kind !== "step_chat_completion") {
    throw new Error("expected an admitted Step source artifact");
  }
  const sourceSemantic = cached.entry.source_semantic;
  expect(inspectCachedSourceSemantic(roots.cacheRoot, key, MODEL, PROFILE).status).toBe("hit");
  expect(inspectInteractiveTransportEvidence(sourceSemantic, cached.entry, roots.cacheRoot, true))
    .toMatchObject({ requestBinding: "unbound", admissionState: "admitted" });
  const path = providerRawAttemptPath(roots.cacheRoot, key, 1);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...raw, request_digest: "e".repeat(64) }));
  expect(inspectCachedSourceSemantic(roots.cacheRoot, key, MODEL, PROFILE).status).toBe("invalid");
  expect(() => inspectInteractiveTransportEvidence(sourceSemantic, cached.entry, roots.cacheRoot, false))
    .toThrow();
  expect(inspectInteractiveTransportEvidence(sourceSemantic, cached.entry, roots.cacheRoot, true))
    .toMatchObject({ requestBinding: "unbound", admissionState: "admitted" });
});

it("rejects complete Step HTTP bytes that contradict normalized finish and usage", async () => {
  const fixture = await scenario(1);
  const key = fixture.selected[0]!;
  await authorLine(fixture, key);
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
});

it.each([PROFILE, STEP_SEMANTIC_HIGH_REQUEST_PROFILE, STEP_PREVIEW_REQUEST_PROFILE, STEP_PREVIEW_JSON_REQUEST_PROFILE] as const)(
  "retains complete %s source bytes beyond the diagnostic prefix for cache reuse", async profile => {
  const model = stepSemanticRequestModel(profile);
  const quote = model === "step-5-preview" ? STEP_PREVIEW_OPENAPI_QUOTE_BASIS : STEP_PLAN_QUOTE_BASIS;
  const fixture = await scenario(1, undefined, model, quote, profile);
  const key = fixture.selected[0]!;
  const planned = plannedLine(fixture, key);
  const wire = prepareSourceSemanticRequestWire(fixture.preflight.config, planned, fixture.preflight.max_output_tokens);
  const body = JSON.parse(wire.body) as { model: string; reasoning_effort: string };
  expect(body.model).toBe(model);
  expect(body.reasoning_effort).toBe(profile === STEP_SEMANTIC_HIGH_REQUEST_PROFILE ? "high" : "low");
  await authorLine(fixture, key, { padding: " ".repeat(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES) });
  const raw = readProviderRawAttempt(roots.cacheRoot, key, 1)!;
  expect(raw.http_response).toMatchObject({ bodyComplete: true, bodyTruncated: false });
  expect(raw.http_response!.bodyByteLength).toBeGreaterThan(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES);
  expect(raw.request_profile).toBe(profile);
  expect(inspectCachedSourceSemantic(roots.cacheRoot, key, model, profile).status).toBe("hit");
  await expect(runExtractionFill(fixture.options)).rejects.toThrow("retired passive generation");
});

it("withholds a Step source stream beyond the complete evidence limit from reuse and SQLite publication", async () => {
  const fixture = await scenario(2);
  const [completeKey, truncatedKey] = fixture.selected;
  await authorLine(fixture, completeKey!);
  const truncatedPlanned = plannedLine(fixture, truncatedKey!);
  const truncatedJson = responseFor(truncatedPlanned.userPrompt);
  const truncatedBase = authoredStepHttpWire(truncatedJson);
  const truncatedPad = Math.max(0, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES - Buffer.byteLength(truncatedBase));
  await writeAuthoredHistoricalStepArtifact({
    cacheRoot: roots.cacheRoot, receipt: fixture.receipt,
    line: {
      key: truncatedPlanned.key, unitKeys: truncatedPlanned.unitKeys, requestSha256: truncatedPlanned.requestSha256,
      systemPrompt: truncatedPlanned.systemPrompt, userPrompt: truncatedPlanned.userPrompt
    },
    requestDigest: truncatedPlanned.request_digest, rawJson: truncatedJson,
    sourceCorpus: authoredSourceCorpusFromRequest(truncatedPlanned.userPrompt, stepSourceCandidates()),
    httpWire: truncatedBase + " ".repeat(truncatedPad),
    bodyComplete: false, commitSuccess: false
  });
  const complete = listProviderRawAttempts(roots.cacheRoot, completeKey!)[0]!;
  const truncated = listProviderRawAttempts(roots.cacheRoot, truncatedKey!)[0]!;
  expect(complete.http_response).toMatchObject({ bodyComplete: true, bodyTruncated: false });
  expect(truncated.http_response).toMatchObject({ bodyComplete: false });
  expect(inspectCachedSourceSemantic(roots.cacheRoot, completeKey!, MODEL, PROFILE).status).toBe("hit");
  expect(inspectCachedSourceSemantic(roots.cacheRoot, truncatedKey!, MODEL, PROFILE).status).not.toBe("hit");
  const rawPath = providerRawAttemptPath(roots.cacheRoot, truncatedKey!, truncated.attempt_ordinal);
  const rawBytes = readFileSync(rawPath);
  const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot).snapshot()!;
  expect(reopened).toMatchObject({ attempts: 2, successfulShards: 1 });
  await expect(runExtractionFill(fixture.options)).rejects.toThrow("retired passive generation");
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
  await expect(publishSourceSemanticSnapshot({ snapshotPath: join(roots.cacheRoot, "step-truncated-publication.sqlite"),
    dataDirRoot: join(roots.cacheRoot, "step-truncated-publication"),
    recordedAt: "2026-09-25T00:00:00.000Z", producerCommit: "a".repeat(40),
    populations: [{ name: "fixture", dataDir: roots.dataDir, pinnedMetaRoot: roots.pinnedMetaRoot,
      cacheRoots: [roots.cacheRoot], model: MODEL, requestProfile: PROFILE,
      publicationAssociations: associations }] })).rejects.toThrow(/retired/u);
});

it.each([PROFILE, STEP_SEMANTIC_HIGH_REQUEST_PROFILE, STEP_PREVIEW_REQUEST_PROFILE, STEP_PREVIEW_JSON_REQUEST_PROFILE] as const)(
  "binds %s to exact HTTP bytes and stops after its first incomplete response", async profile => {
  const model = stepSemanticRequestModel(profile);
  const quote = model === "step-5-preview" ? STEP_PREVIEW_OPENAPI_QUOTE_BASIS : STEP_PLAN_QUOTE_BASIS;
  const fixture = await scenario(4, undefined, model, quote, profile);
  const planned = plannedLine(fixture, fixture.selected[0]!);
  const wire = prepareSourceSemanticRequestWire(fixture.preflight.config, planned, fixture.preflight.max_output_tokens);
  const body = JSON.parse(wire.body) as {
    model: string; reasoning_effort: string; max_tokens: number; stream: boolean; response_format: { type: string };
  };
  expect(wire.url.pathname).toBe(model === "step-5-preview" ? "/v1/chat/completions" : "/step_plan/v1/chat/completions");
  expect(body).toMatchObject({ model, reasoning_effort: profile === STEP_SEMANTIC_HIGH_REQUEST_PROFILE ? "high" : "low",
    max_tokens: 4096, stream: true,
    response_format: profile === STEP_PREVIEW_JSON_REQUEST_PROFILE ? { type: "json_object" }
      : { type: "json_schema" } });
  await authorLine(fixture, fixture.selected[0]!, { finishReason: "length", commitSuccess: false });
  const raws = fixture.selected.flatMap(key => listProviderRawAttempts(roots.cacheRoot, key));
  expect(raws).toHaveLength(1);
  const raw = raws[0]!;
  expect(raw).toMatchObject({ contract: "provider-raw-attempt-v3", finish_reason: "length",
    request_digest: planned.request_digest });
  expect(fixture.selected.slice(1).every(key => listProviderRawAttempts(roots.cacheRoot, key).length === 0)).toBe(true);
  const reopenedAuthority = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
  await expect(reopenedAuthority.reserveAttemptOrdinal!(raw.cache_key)).rejects.toThrow(/per-key attempt ceiling/u);
  expect(reopenedAuthority.snapshot()?.attempts).toBe(1);
  await expect(runExtractionFill(fixture.options)).rejects.toThrow("retired passive generation");
});

it("quarantines valid JSON that violates the source contract under JSON Mode", async () => {
  const fixture = await scenario(2, undefined, "step-5-preview", STEP_PREVIEW_OPENAPI_QUOTE_BASIS,
    STEP_PREVIEW_JSON_REQUEST_PROFILE);
  await authorLine(fixture, fixture.selected[0]!, {
    rawJson: '{"unrelated":"valid JSON"}', commitSuccess: false
  });
  const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
  expect(raw.finish_reason).toBe("stop");
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, "step-5-preview",
    STEP_PREVIEW_JSON_REQUEST_PROFILE).status).not.toBe("hit");
  expect(listProviderRawAttempts(roots.cacheRoot, fixture.selected[1]!)).toHaveLength(0);
  await expect(runExtractionFill(fixture.options)).rejects.toThrow("retired passive generation");
});

it.each([
  { basis: STEP_PLAN_QUOTE_BASIS, path: "/step_plan/v1/chat/completions" },
  { basis: STEP_OPENAPI_QUOTE_BASIS, path: "/v1/chat/completions" }
])("binds an explicit source cap to $path, retained bounds, receipt price, and the reopened attempt", async ({ basis, path }) => {
  const fixture = await scenario(1, 16384, MODEL, basis);
  const line = fixture.preflight.planned_requests[0]!;
  const wire = prepareSourceSemanticRequestWire(fixture.preflight.config, line, fixture.preflight.max_output_tokens);
  expect(wire.url.pathname).toBe(path);
  expect(JSON.parse(wire.body).max_tokens).toBe(16384);
  const encodedInputUpper = Buffer.byteLength(wire.body, "utf8") + 256;
  expect(line.input_byte_upper).toBe(encodedInputUpper);
  expect(fixture.preflight.maximum_input_tokens_per_attempt).toBe(encodedInputUpper);
  expect(fixture.preflight.input_token_bound).toBe(encodedInputUpper);
  expect(fixture.preflight.cost_bound_usd).toBe((
    encodedInputUpper * 0.14 + 16384 * 0.42
  ) / 1_000_000);
  expect(fixture.receipt.limits.max_output_tokens).toBe(16384);
  expect(fixture.receipt.source_preflight_digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(assertInteractiveSourcePreflightReceipt(fixture.preflight, fixture.receipt)).toEqual(fixture.preflight);
  expect(() => assertInteractiveSourcePreflightReceipt({ ...fixture.preflight,
    max_output_tokens: 4096 }, fixture.receipt)).toThrow();
  expect(fixture.receipt.price.estimated_upper_usd).toBe(fixture.preflight.cost_bound_usd);
  expect(() => assertExtractionAuthorityReceipt({ ...fixture.receipt,
    price: { ...fixture.receipt.price, input_usd_per_million: 0.13 } },
  fixture.receipt.observation)).toThrow(/frozen route-specific/u);
  await authorLine(fixture, fixture.selected[0]!);
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
    outputTokenCap: { field: "max_tokens", value: 4096 } })).toThrow(/interactive source sample authority differs from retained preflight/u);
  expect(() => createExtractionAuthorityReceipt({ ...fixture.receiptInput,
    priceEstimate: { ...fixture.receiptInput.priceEstimate,
      maximumInputTokensPerAttempt: fixture.preflight.maximum_input_tokens_per_attempt - 1 } }))
    .toThrow(/interactive source sample authority differs from retained preflight/u);
  expect(() => createExtractionAuthorityReceipt({ ...fixture.receiptInput,
    sourcePreflight: { ...fixture.preflight, selected_keys: ["f".repeat(64)] } }))
    .toThrow(/foreign ready key/u);
  expect(() => createExtractionAuthorityReceipt({ ...fixture.receiptInput,
    sourcePreflight: { ...fixture.preflight, config: { ...fixture.preflight.config,
      providerUrl: "https://logical-other.example.test/v1",
      transportProviderUrl: fixture.preflight.config.providerUrl } } }))
    .toThrow(/interactive source sample authority differs from retained preflight/u);
  expect(() => createExtractionAuthorityReceipt({ ...fixture.receiptInput,
    sourcePreflight: { ...fixture.preflight, config: { ...fixture.preflight.config,
      modelFamily: "different-logical-family" } } }))
    .toThrow(/interactive source sample authority differs from retained preflight/u);
  expect(() => createExtractionAuthorityReceipt({ ...fixture.receiptInput,
    sourcePreflight: undefined })).toThrow(/interactive source sample requires retained preflight and native scope/u);
});

it("rejects altered retained Step preflight wire, route, and selected-key proof", async () => {
  const { preflight } = await scenario(1);
  expect(() => parseSourceSemanticInteractivePreflight({ ...preflight,
    planned_requests: [{ ...preflight.planned_requests[0], request_digest: "f".repeat(64) }] }))
    .toThrow(/encoded wire/u);
  expect(() => parseSourceSemanticInteractivePreflight({ ...preflight,
    config: { ...preflight.config, transportProviderUrl: "https://api.stepfun.com/v1" } }))
    .toThrow(/quote differs from its model or transport route/u);
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

it("settles contradictory Step usage as accounting-invalid quarantine without trusting counts or reopening a request", async () => {
  const fixture = await scenario(4);
  const invalid = { inputTokens: 11, outputTokens: 4097, totalTokens: 4108 };
  const planned = plannedLine(fixture, fixture.selected[0]!);
  const rawJson = responseFor(planned.userPrompt);
  await writeAuthoredHistoricalStepArtifact({
    cacheRoot: roots.cacheRoot, receipt: fixture.receipt,
    line: {
      key: planned.key, unitKeys: planned.unitKeys, requestSha256: planned.requestSha256,
      systemPrompt: planned.systemPrompt, userPrompt: planned.userPrompt
    },
    requestDigest: planned.request_digest, rawJson,
    sourceCorpus: authoredSourceCorpusFromRequest(planned.userPrompt, stepSourceCandidates()),
    httpWire: authoredStepHttpWire(rawJson, invalid),
    usage: invalid, invalidReportedUsage: invalid
  });
  const raw = fixture.selected.flatMap(key => listProviderRawAttempts(roots.cacheRoot, key))[0]!;
  expect(raw).toMatchObject({ usage: { inputTokens: 11, outputTokens: 4097, totalTokens: 4108 },
    http_response: { bodyComplete: true } });
  const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
  expect(reopened.snapshot()?.unresolvedAttempts).toEqual([]);
  expect(reopened.snapshot()?.settledAttempts).toContainEqual(expect.objectContaining({
    cacheKey: raw.cache_key, attemptOrdinal: 1, usageAccounting: "invalid"
  }));
  expect(reopened.snapshot()?.telemetry).toMatchObject({ inputTokens: 0, outputTokens: 0,
    totalTokens: 0, usageInvalidAttempts: 1, usageUnavailableRequests: 1, usageUnknownAttempts: 1 });
  await expect(runExtractionFill(fixture.options)).rejects.toThrow("retired passive generation");
  await expect(reopened.reserveAttemptOrdinal!(raw.cache_key)).rejects.toThrow(/per-key attempt ceiling/u);
});

it.each([
  { inputTokens: 8, outputTokens: 3, totalTokens: 11, cachedInputTokens: 9 },
  { inputTokens: 8, outputTokens: 3, totalTokens: 11, reasoningOutputTokens: 4 },
  { inputTokens: 8, outputTokens: 3, totalTokens: 12 }
])("rejects contradictory inclusive usage dimensions", usage => {
  expect(() => assertNativeChatReportedUsage(PROFILE, usage, 4096)).toThrow(/reported usage contradicts/u);
});

it("reopens a successful Step source interpretation without a second HTTP request", async () => {
  const fixture = await scenario(1);
  await authorLine(fixture, fixture.selected[0]!);
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL, PROFILE).status).toBe("hit");
  expect(listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]?.http_response?.bodyComplete).toBe(true);
  await expect(runExtractionFill(fixture.options)).rejects.toThrow("retired passive generation");
  expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.selected[0]!, MODEL, PROFILE).status).toBe("hit");
});

it("retains bytes received before caller cancellation and spends no second Step slot", async () => {
  const fixture = await scenario(1);
  const prefix = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  const planned = plannedLine(fixture, fixture.selected[0]!);
  await writeAuthoredHistoricalStepArtifact({
    cacheRoot: roots.cacheRoot, receipt: fixture.receipt,
    line: {
      key: planned.key, unitKeys: planned.unitKeys, requestSha256: planned.requestSha256,
      systemPrompt: planned.systemPrompt, userPrompt: planned.userPrompt
    },
    requestDigest: planned.request_digest, rawJson: "partial",
    sourceCorpus: authoredSourceCorpusFromRequest(planned.userPrompt, stepSourceCandidates()),
    httpWire: prefix, finishReason: "stop", bodyComplete: false, commitSuccess: false
  });
  const raw = listProviderRawAttempts(roots.cacheRoot, fixture.selected[0]!)[0]!;
  expect(raw).toMatchObject({ contract: "provider-raw-attempt-v3", http_response: {
    bodyBase64: Buffer.from(prefix).toString("base64"), bodyComplete: false,
    bodyByteLength: Buffer.byteLength(prefix), bodySha256: createHash("sha256").update(prefix).digest("hex")
  } });
  const reopened = createExtractionExecutionAuthority(fixture.receipt, roots.cacheRoot);
  expect(reopened.snapshot()?.attempts).toBe(1);
  await expect(reopened.reserveAttemptOrdinal!(fixture.selected[0]!)).rejects.toThrow(/per-key attempt ceiling/u);
});
