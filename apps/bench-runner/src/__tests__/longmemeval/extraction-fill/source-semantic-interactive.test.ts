import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { runCli } from "../../../cli/cli.js";
import * as geminiHttp from "../../../runs/compile-seed/http/gemini-http.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { listProviderRawAttempts } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import type { LongMemEvalExpansionCapability } from "../../../datasets/longmemeval/promotion/expansion/expansion-capability.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { assertNativeSemanticChain } from "./semantic-chain.test-support.js";

const MODEL = "gemini-2.5-flash-lite";
const REQUEST_PROFILE = "gemini-2.5-nonthinking-v1" as const;
const VARIANT = "longmemeval_s" as const;
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), VARIANT);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function authoredResponse(userPrompt: string, mode: "semantic" | "unknown_alias" = "semantic") {
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions.find((row) => row.text.includes("completed"))!;
  const catalog = request.source_catalog.assertions.find((row) => row.assertion_id === assertion.assertion_id)!;
  const segment = (text: string) => catalog.segments.find((row) => row.text === text)!;
  const anchor = (text: string) => ({
    assertion_id: assertion.assertion_id, source_ref: { first: segment(text).id, last: segment(text).id }
  });
  const theme = assertion.text.includes("alpha") ? "alpha" : "decoy";
  const contract = request.source_request.proposal_contract ?? "source-semantic-proposal-v3";
  const envelope = contract === "source-semantic-proposal-v5" ? {
    contract, outcome: { status: "interpreted" }, content: {
      roots: [{ act: "assertion", expression: {
        kind: "statement", predicate: { kind: "explicit", reading: "complete", support: segment("completed").id },
        arguments: [{ role: "theme", target: { kind: "entity", key: "r0", mentions: [segment(theme).id] } }]
      } }]
    }
  } : contract === "source-semantic-proposal-v4" ? {
    contract, outcome: { status: "interpreted" }, content: {
      roots: [{ act: "assertion", expression: {
        kind: "statement", predicate: { kind: "explicit", reading: "complete", at: segment("completed").id },
        arguments: [{ role: "theme", target: { key: "r0", at: segment(theme).id } }]
      } }]
    }
  } : {
    contract: "source-semantic-proposal-v3",
    outcome: { status: "interpreted" },
    content: {
      roots: [{ act: "assertion", expression: {
        kind: "statement", key: "f0", predicate: { kind: "explicit", reading: "complete", evidence: [anchor("completed")] },
        arguments: [{ role: "theme", target: { kind: "entity", key: "r0", referent_kind: "grouped", mentions: [anchor(theme)] }, evidence: [anchor(theme)] }]
      } }],
      gaps: []
    }
  };
  const editable = JSON.parse(JSON.stringify(envelope));
  if (mode === "unknown_alias") editable.content.roots[0].expression.arguments[0].target = { kind: "reference", key: segment(theme).id };
  return JSON.stringify(editable);
}

async function setupInteractive(mode: "semantic" | "unknown_alias" = "semantic", questions = 1) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  await writeDataset(Array.from({ length: questions }, (_, index) => buildExtractionFillQuestion(`q${index}`,
    "I completed alpha. The room was quiet. The desk was clear. The lamp was on. The window was open. " +
    `The door was closed. The shelf was full. The clock was ticking. The floor was clean. It is ready. Record ${index}.`,
    `I completed decoy. Record ${index}.`)));
  const inspection = await inspectExtractionAuthority({
    variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot, sourcePacking: "complete-source",
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, revision: readCurrentExtractionAuthorityRevision(),
    action: "fill"
  });
  const receipt = createExtractionAuthorityReceipt({
    action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 },
    inspection
  });
  const receiptPath = join(cacheRoot, "authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("batchGenerateContent") || path.startsWith("/v1beta/batches/") || path.includes("/upload")) {
      throw new Error(`interactive fill must not dispatch Batch ${path}`);
    }
    if (!path.endsWith(":streamGenerateContent")) throw new Error(`unexpected offline request ${path}`);
    const userPrompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    return Response.json({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: authoredResponse(userPrompt, mode) }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, receiptPath, keys: inspection.missingKeys };
}

it("fills complete-source open semantics through interactive generateContent without Batch isolation or packing-size errors", async () => {
  const fixture = await setupInteractive("semantic", 9);
  const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8")) as {
    readonly limits: { readonly starting_missing: number; readonly maximum_attempts: number };
  };
  expect(receipt.limits.maximum_attempts).toBe(receipt.limits.starting_missing * 2);
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath
  ])).toBe(0);
  expect(existsSync(join(cacheRoot, "gemini-batch-plan.json"))).toBe(false);
  expect(fixture.fetchMock).toHaveBeenCalled();
  expect(fixture.keys.length).toBeGreaterThan(0);
  const key = fixture.keys[0]!;
  expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({
    status: "hit", sourceBinding: "unbound"
  });
  const shard = JSON.parse(readFileSync(cacheFilePath(cacheRoot, key), "utf8")) as {
    readonly source_semantic: {
      readonly kind: string;
      readonly result: { readonly provenance: { readonly transport: string; readonly job?: string } };
    };
  };
  expect(shard.source_semantic.kind).toBe("gemini_generate_content");
  expect(shard.source_semantic.result.provenance.transport).toBe("gemini-generate-content");
  expect(shard.source_semantic.result.provenance.job).toBeUndefined();
  expect(JSON.stringify(shard)).not.toMatch(/batches\//u);
  const census = await censusCompleteSourceRecords({ population: "fixture", dataDir, pinnedMetaRoot });
  const publicationAssociations = census.records.map((source) => {
    const key = fixture.keys.find((candidate) => {
      const h = inspectCachedSourceSemantic(cacheRoot, candidate, MODEL, REQUEST_PROFILE);
      return h.status === "hit" && h.admitted.request.source_catalog.source_digest === source.corpus_digest;
    })!;
    const h = inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE);
    if (h.status !== "hit") throw new Error("fixture H missing");
    return { source_id: source.source_id, source_version: source.source_version,
      generation_key: key, request_digest: h.requestDigest };
  });
  const secondCache = join(dirname(cacheRoot), "second-generation");
  mkdirSync(secondCache);
  for (const moved of fixture.keys.slice(1)) {
    mkdirSync(dirname(cacheFilePath(secondCache, moved)), { recursive: true });
    renameSync(cacheFilePath(cacheRoot, moved), cacheFilePath(secondCache, moved));
  }
  expect(inspectCachedSourceSemantic(secondCache, fixture.keys[1]!, MODEL, REQUEST_PROFILE)).toMatchObject({
    status: "invalid", reason: "typed open-semantics generation binding mismatch"
  });
  copyFileSync(join(cacheRoot, "manifest.json"), join(secondCache, "manifest.json"));
  const report = await publishSourceSemanticSnapshot({
    snapshotPath: join(cacheRoot, "published.sqlite"), dataDirRoot: join(cacheRoot, "publication"),
    recordedAt: "2026-09-21T00:00:00.000Z", producerCommit: "a".repeat(40),
    populations: [{ name: "fixture", dataDir, pinnedMetaRoot, cacheRoots: [cacheRoot, secondCache], model: MODEL, requestProfile: REQUEST_PROFILE, publicationAssociations }]
  });
  expect(report.published_count).toBe(census.records.length);
  expect(report.h_binding_complete).toBe(true);
  expect(report.sources.every((source) => source.h_binding?.kind === "host_publication_association")).toBe(true);
  const providerCalls = fixture.fetchMock.mock.calls.length;
  await assertNativeSemanticChain(cacheRoot);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(providerCalls);
}, 60000);

it("quarantines an interactive generateContent line through the same source-semantic receiver as Batch", async () => {
  const fixture = await setupInteractive("unknown_alias");
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath
  ])).toBe(0);
  for (const key of fixture.keys) {
    const inspected = inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE);
    expect(inspected.status).not.toBe("hit");
    expect(listProviderRawAttempts(cacheRoot, key)[0]).toMatchObject({
      kind: "source_semantic", full_replay_possible: true
    });
  }
  expect(existsSync(join(cacheRoot, "gemini-batch-plan.json"))).toBe(false);
}, 60000);

it("retains raw and refuses an executable cache entry when generateContent omits finishReason", async () => {
  const fixture = await setupInteractive();
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (!path.endsWith(":streamGenerateContent")) throw new Error(`unexpected offline request ${path}`);
    const userPrompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    return Response.json({
      candidates: [{ content: { parts: [{ text: authoredResponse(userPrompt) }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
    });
  }));
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath
  ])).toBe(0);
  for (const key of fixture.keys) {
    expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status).not.toBe("hit");
    const raw = listProviderRawAttempts(cacheRoot, key)[0];
    expect(raw?.finish_reason).toBeNull();
    expect(raw?.completion_witness).toBeNull();
    expect(raw?.decoded_text.length).toBeGreaterThan(0);
  }
}, 60000);

it("does not retry thought-only STOP generateContent as transport", async () => {
  const fixture = await setupInteractive();
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (!path.endsWith(":streamGenerateContent")) throw new Error(`unexpected offline request ${path}`);
    return Response.json({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ thought: true, text: "private synthetic thought" }] }
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: 3, totalTokenCount: 13 }
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath
  ])).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(fixture.keys.length);
  for (const key of fixture.keys) {
    expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status).not.toBe("hit");
    expect(listProviderRawAttempts(cacheRoot, key)[0]).toMatchObject({
      decoded_text: "",
      finish_reason: "STOP", completion_witness: "finish_reason",
      transport_failure: { kind: "response_schema_error", phase: "response_schema" },
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 }
    });
  }
  const ledgerName = readdirSync(cacheRoot).find((name) => name.startsWith("extraction-attempt-ledger"));
  expect(ledgerName).toBeDefined();
  const ledger = JSON.parse(readFileSync(join(cacheRoot, ledgerName!), "utf8")) as {
    readonly attempts: number;
  };
  expect(ledger.attempts).toBe(fixture.keys.length);
}, 60000);

it.each(["network", "http"])("retains each interactive %s failure and never repeats exhausted attempts", async (kind) => {
  const fixture = await setupInteractive();
  const fetchMock = vi.fn(async () => {
    if (kind === "http") return Response.json({ error: { code: 500, message: "fixture server failure" } }, { status: 500 });
    throw Object.assign(new TypeError("fetch failed"), { cause: new Error("socket hang up") });
  });
  vi.stubGlobal("fetch", fetchMock);
  const args = [
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath
  ];
  expect(await runCli(args)).toBe(0);
  const ledgerName = readdirSync(cacheRoot).find((name) => name.startsWith("extraction-attempt-ledger"));
  expect(ledgerName).toBeDefined();
  const ledger = JSON.parse(readFileSync(join(cacheRoot, ledgerName!), "utf8")) as {
    readonly successful_shards: unknown[];
    readonly transport_failures: readonly unknown[];
    readonly attempts: number;
  };
  expect(ledger.successful_shards).toEqual([]);
  expect(ledger.transport_failures.length).toBeGreaterThan(0);
  expect(ledger.attempts).toBe(fixture.keys.length * 2);
  for (const key of fixture.keys) {
    const raws = listProviderRawAttempts(cacheRoot, key);
    expect(raws).toHaveLength(2);
    expect(raws.every((raw) => raw.failure_retryable === true && raw.usage_known === false)).toBe(true);
    if (kind === "http") expect(raws[0]).toMatchObject({
      transport_failure: { kind: "http_error", httpStatus: 500 }, response_body: { text: expect.stringContaining("fixture server failure") }
    });
  }
  expect(await runCli(args)).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(fixture.keys.length * 2);
}, 60000);

it("continues later complete-source keys after one interactive transport failure", async () => {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  await writeDataset([
    buildExtractionFillQuestion("q0",
      "I completed alpha. The room was quiet. The desk was clear. The lamp was on. The window was open. " +
      "The door was closed. The shelf was full. The clock was ticking. The floor was clean. It is ready.",
      "I completed decoy."),
    buildExtractionFillQuestion("q1",
      "I completed beta. The room was quiet. The desk was clear. The lamp was on. The window was open. " +
      "The door was closed. The shelf was full. The clock was ticking. The floor was clean. It is ready.",
      "I completed other.")
  ]);
  const inspection = await inspectExtractionAuthority({
    variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot, sourcePacking: "complete-source",
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, revision: readCurrentExtractionAuthorityRevision(),
    action: "fill"
  });
  const receipt = createExtractionAuthorityReceipt({
    action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 },
    inspection
  });
  const receiptPath = join(cacheRoot, "authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (!path.endsWith(":streamGenerateContent")) throw new Error(`unexpected offline request ${path}`);
    const userPrompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    if (userPrompt.includes("completed alpha")) {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("socket hang up") });
    }
    return Response.json({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: authoredResponse(userPrompt) }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
    });
  }));
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", receiptPath,
    "--concurrency", "1"
  ])).toBe(0);
  const statuses = inspection.missingKeys.map((key) =>
    inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status);
  expect(statuses).toContain("hit");
  expect(statuses.some((status) => status !== "hit")).toBe(true);
}, 60000);

it("does not classify a programmer extract error as transport failure", async () => {
  const fixture = await setupInteractive();
  vi.spyOn(geminiHttp, "createGeminiHttpExtractor").mockReturnValue({
    extract: async () => {
      throw new TypeError("extractor contract broken");
    }
  } as never);
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath
  ])).toBe(2);
  const ledgerName = readdirSync(cacheRoot).find((name) => name.startsWith("extraction-attempt-ledger"));
  expect(ledgerName).toBeDefined();
  const ledger = JSON.parse(readFileSync(join(cacheRoot, ledgerName!), "utf8")) as {
    readonly attempts: number;
    readonly unresolved_attempts: readonly unknown[];
    readonly transport_failures: readonly unknown[];
  };
  expect(ledger.transport_failures).toEqual([]);
  expect(ledger.unresolved_attempts.length).toBeGreaterThan(0);
  expect(ledger.attempts).toBeGreaterThan(0);
  expect(ledger.attempts).toBeLessThanOrEqual(fixture.keys.length);
}, 60000);

it("replays persisted raw without a second provider call after a shard write failure", async () => {
  const fixture = await setupInteractive();
  const buckets = [...new Set(fixture.keys.map((key) => join(cacheRoot, key.slice(0, 2))))];
  for (const bucket of buckets) {
    mkdirSync(bucket, { recursive: true });
    chmodSync(bucket, 0o500);
  }
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath,
    "--concurrency", String(Math.max(fixture.keys.length, 1))
  ])).toBe(2);
  expect(fixture.fetchMock).toHaveBeenCalled();
  expect(fixture.keys.some((key) => listProviderRawAttempts(cacheRoot, key).length > 0)).toBe(true);
  for (const bucket of buckets) chmodSync(bucket, 0o700);
  fixture.fetchMock.mockClear();
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath,
    "--concurrency", "1"
  ])).toBe(0);
  expect(fixture.fetchMock).not.toHaveBeenCalled();
  for (const key of fixture.keys) {
    if (listProviderRawAttempts(cacheRoot, key).length === 0) continue;
    expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("hit");
  }
}, 60000);

it("still refuses mixing lazy_field, expansion, or an injected extractor with open semantics", async () => {
  await expect(runExtractionFill({
    variant: VARIANT, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, cacheRoot,
    extractorFactory: () => ({ extract: async () => { throw new Error("unused"); } })
  })).rejects.toThrow(/cannot mix lazy_field, expansion, or an injected extractor/u);
  await expect(runExtractionFill({
    variant: VARIANT, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, cacheRoot,
    ingestionMode: "lazy_field", semanticArtifactRoot: join(cacheRoot, "semantic")
  })).rejects.toThrow(/cannot mix lazy_field, expansion, or an injected extractor/u);
  await expect(runExtractionFill({
    variant: VARIANT, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, cacheRoot,
    expansionCapability: {} as LongMemEvalExpansionCapability
  })).rejects.toThrow(/cannot mix lazy_field, expansion, or an injected extractor/u);
});
