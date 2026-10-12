import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
vi.hoisted(() => {
  for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(input)).hostname !== "127.0.0.1" || init?.redirect !== "error") throw new Error("only no-redirect loopback transport allowed");
    return nativeFetch(input, init);
  });
});
import { openReadOnlyDatabase } from "@do-soul/alaya-storage";
import { buildSourceSemanticRequest, parseSourceSemanticRequest, sourceSemanticRequestCatalog,
  SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT, sourceSemanticGenerationInput, type SourceSemanticRequest } from "@do-soul/alaya-soul";
import { prepareSourceSemanticRequestWire } from "../../../runs/extraction/fill/source-semantic-interactive-request.js";
import { runCli } from "../../../cli/cli.js";
import * as geminiHttp from "../../../runs/compile-seed/http/gemini-http.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import * as sourceArtifacts from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { openExtractionAttemptLedger, readSettledExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";
import { importSourceSemanticArtifact, inspectCachedSourceSemantic,
  writeDeterministicSourceSemanticArtifact } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { readValidDeterministicLedgerShard, readValidLedgerShard } from "../../../runs/extraction/authority/attempt-ledger-shards.js";
import { acquireExtractionCacheWriteLease } from "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import { listProviderRawAttempts, providerRawAttemptPath, writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { cacheFilePath, inspectCachedRawExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import { computeSystemPromptSha256, extractionAdmissionGenerationSha256,
  type ExtractionCacheManifest } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { computeExtractionRawJsonSha256 } from "../../../runs/extraction/content-closure.js";
import { createHash } from "node:crypto";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, prepareSourceSemanticRequestLine,
  SOURCE_SEMANTIC_BATCH_PRODUCER_ID } from "../../../runs/extraction/request-artifact.js";
import type { LongMemEvalExpansionCapability } from "../../../datasets/longmemeval/promotion/expansion/expansion-capability.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { assertNativeSemanticChain } from "./semantic-chain.test-support.js";
import { assertNativeLongMemEvalArm } from "./native-semantic-arm.test-support.js";
import { tableCompletedResponse } from "./source-semantic-table-response.test-support.js";

const MODEL = "gemini-2.5-flash-lite";
const REQUEST_PROFILE = "gemini-2.5-nonthinking-v1" as const;
const VARIANT = "longmemeval_s" as const;
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), VARIANT);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function authoredResponse(userPrompt: string, mode: "semantic" | "unknown_alias" = "semantic") {
  const request: { source_request: Pick<SourceSemanticRequest["source_request"], "source_assertions"> } = JSON.parse(userPrompt);
  const assertion = request.source_request.source_assertions.find((row) => row.text.includes("completed"))!;
  const theme = assertion.text.includes("alpha") ? "alpha" : "decoy";
  const envelope = tableCompletedResponse(assertion.assertion_id, theme);
  if (mode === "unknown_alias") envelope.content.nodes[0]!.arguments[0]!.target = {
    kind: "entity_ref", key: "missing"
  };
  return JSON.stringify(envelope);
}

async function setupInteractive(mode: "semantic" | "unknown_alias" = "semantic", questions = 1,
  providerUrl = "https://fixture-provider.invalid", projected = false) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", providerUrl);
  await writeDataset(Array.from({ length: questions }, (_, index) => ({ ...buildExtractionFillQuestion(`q${index}`,
    "I completed alpha. The room was quiet. The desk was clear. The lamp was on. The window was open. " +
    `The door was closed. The shelf was full. The clock was ticking. The floor was clean. It is ready. Record ${index}.`,
    `I completed decoy. Record ${index}.`), question: index === 3 ? "What was repaired?" : "What was completed?" })));
  const openSemantics = { ...EXTRACTION_OPEN_SEMANTICS_GENERATION,
    ...(projected ? { generation_view_contract: SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT } : {}) };
  const inspection = await inspectExtractionAuthority({
    variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot, sourcePacking: "complete-source",
    openSemantics, revision: readCurrentExtractionAuthorityRevision(),
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
  return { fetchMock, receiptPath, keys: inspection.missingKeys, openSemantics };
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
      const cachedInterpretation = inspectCachedSourceSemantic(cacheRoot, candidate, MODEL, REQUEST_PROFILE);
      return cachedInterpretation.status === "hit" && sourceSemanticRequestCatalog(cachedInterpretation.admitted.request).source_digest === source.corpus_digest;
    })!;
    const cachedInterpretation = inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE);
    if (cachedInterpretation.status !== "hit") throw new Error("fixture source interpretation missing");
    return { source_id: source.source_id, source_version: source.source_version,
      generation_key: key, request_digest: cachedInterpretation.requestDigest };
  });
  const secondCache = join(dirname(cacheRoot), "second-generation");
  mkdirSync(secondCache);
  const copied = fixture.keys[1]!;
  mkdirSync(dirname(cacheFilePath(secondCache, copied)), { recursive: true });
  copyFileSync(cacheFilePath(cacheRoot, copied), cacheFilePath(secondCache, copied));
  copyFileSync(join(cacheRoot, "manifest.json"), join(secondCache, "manifest.json"));
  expect(inspectCachedSourceSemantic(secondCache, fixture.keys[1]!, MODEL, REQUEST_PROFILE)).toMatchObject({
    status: "invalid", reason: "typed source semantic raw attempt witness is absent"
  });
  const report = await publishSourceSemanticSnapshot({
    snapshotPath: join(cacheRoot, "published.sqlite"), dataDirRoot: join(cacheRoot, "publication"),
    recordedAt: "2026-09-21T00:00:00.000Z", producerCommit: "a".repeat(40),
    populations: [{ name: "fixture", dataDir, pinnedMetaRoot, cacheRoots: [cacheRoot], model: MODEL, requestProfile: REQUEST_PROFILE, publicationAssociations }]
  });
  expect(report.published_count).toBe(census.records.length);
  expect(report.source_interpretation_binding_complete).toBe(true);
  expect(report.sources.every((source) => source.source_interpretation_binding?.kind === "host_publication_association")).toBe(true);
  const providerCalls = fixture.fetchMock.mock.calls.length;
  const sourceOnly = await publishSourceSemanticSnapshot({
    snapshotPath: join(cacheRoot, "source-only.sqlite"), dataDirRoot: join(cacheRoot, "source-only-publication"),
    recordedAt: "2026-09-21T00:00:00.000Z", producerCommit: "a".repeat(40),
    populations: [{ name: "fixture", dataDir, pinnedMetaRoot, model: MODEL, requestProfile: REQUEST_PROFILE }]
  });
  await assertNativeSemanticChain(cacheRoot, sourceOnly);
  await assertNativeLongMemEvalArm(dataDir, pinnedMetaRoot, [cacheRoot]);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(providerCalls);
  // Nine complete-source questions, two publications, and the native arm take about ninety seconds; a loaded Windows runner crosses four minutes and leaves a daemon that blocks the next test.
}, 480_000);

it("withholds a source after its settled usage witness is removed", async () => {
  const fixture = await setupInteractive();
  const args = ["extraction-fill", "--variant", "s", "--data-dir", dataDir,
    "--pinned-meta-root", pinnedMetaRoot, "--extraction-cache-root", cacheRoot,
    "--extraction-open-semantics", "--extraction-source-packing", "complete-source",
    "--extraction-authority", fixture.receiptPath];
  expect(await runCli(args)).toBe(0);
  const census = await censusCompleteSourceRecords({ population: "fixture", dataDir, pinnedMetaRoot });
  const publicationAssociations = census.records.map(source => {
    const key = fixture.keys.find(candidate => {
      const inspected = inspectCachedSourceSemantic(cacheRoot, candidate, MODEL, REQUEST_PROFILE);
      return inspected.status === "hit" &&
        sourceSemanticRequestCatalog(inspected.admitted.request).source_digest === source.corpus_digest;
    })!;
    const inspected = inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE);
    if (inspected.status !== "hit") throw new Error("fixture source interpretation missing");
    return { source_id: source.source_id, source_version: source.source_version,
      generation_key: key, request_digest: inspected.requestDigest };
  });
  expect(census.records).toHaveLength(2);
  const raw = listProviderRawAttempts(cacheRoot, fixture.keys[0]!)[0]!;
  const ledgerPath = join(cacheRoot, readdirSync(cacheRoot).find(name => name.startsWith("extraction-attempt-ledger"))!);
  const record = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const settled = record.settled_attempts.find((item: { attempt_ordinal: number }) =>
    item.attempt_ordinal === raw.attempt_ordinal);
  expect(settled.usage_sha256).toMatch(/^[0-9a-f]{64}$/u);
  delete settled.usage_sha256;
  writeFileSync(ledgerPath, JSON.stringify(record));
  const ledgerBefore = readFileSync(ledgerPath, "utf8");
  fixture.fetchMock.mockClear();
  expect(inspectCachedRawExtraction(cacheRoot, raw.cache_key, MODEL, REQUEST_PROFILE))
    .toMatchObject({ status: "invalid" });
  expect(inspectCachedSourceSemantic(cacheRoot, raw.cache_key, MODEL, REQUEST_PROFILE))
    .toMatchObject({ status: "invalid" });
  expect(() => readSettledExtractionAttemptLedger({ cacheRoot,
    lineageDigest: raw.kind === "source_semantic" ? raw.authority_lineage_digest! : "",
    cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE } }))
    .toThrow(/successful shard closure drifted/u);
  const report = await publishSourceSemanticSnapshot({
    snapshotPath: join(cacheRoot, "missing-settlement.sqlite"),
    dataDirRoot: join(cacheRoot, "missing-settlement-publication"),
    recordedAt: "2026-09-25T00:00:00.000Z", producerCommit: "a".repeat(40),
    populations: [{ name: "fixture", dataDir, pinnedMetaRoot, cacheRoots: [cacheRoot],
      model: MODEL, requestProfile: REQUEST_PROFILE, publicationAssociations }]
  });
  expect(report.published_count).toBe(1);
  expect(report.sources.filter(source => source.publication === "published")).toHaveLength(1);
  expect(fixture.fetchMock).not.toHaveBeenCalled();
  expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);
}, 60000);

it.each([false, true])("persists exact JSON and SSE bodies through loopback source publication with projected view %s", async (projected) => {
  const bodies = new Map<string, Buffer>();
  const requests = new Map<string, string>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const requestBody = Buffer.concat(chunks).toString("utf8");
      const userPrompt = JSON.parse(requestBody).contents[0].parts[0].text as string;
      requests.set(userPrompt, requestBody);
      const rawJson = authoredResponse(userPrompt);
      const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 };
      const sse = bodies.size % 2 === 1;
      const physical = sse ? [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: rawJson.slice(0, 20) }] } }],
          fixtureNote: "café" })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP",
          content: { parts: [{ text: rawJson.slice(20) }] } }], usageMetadata })}\n\n`
      ].join("") : JSON.stringify({ candidates: [{ finishReason: "STOP",
        content: { parts: [{ text: rawJson }] } }], usageMetadata, fixtureNote: "café" });
      const bytes = Buffer.from(physical, "utf8");
      bodies.set(userPrompt, bytes);
      response.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" });
      response.end(bytes);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fixture = await setupInteractive("semantic", 1, origin, projected);
    vi.unstubAllGlobals();
    const filled = await runExtractionFill({ variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
      sourcePacking: "complete-source", openSemantics: fixture.openSemantics,
      authorityReceiptPath: fixture.receiptPath });
    expect(filled.coverage).toBe(1);
    expect(bodies.size).toBe(fixture.keys.length);
    for (const key of fixture.keys) {
      const shard = JSON.parse(readFileSync(cacheFilePath(cacheRoot, key), "utf8"));
      const line = shard.source_semantic.result.line;
      const modelInput = sourceSemanticGenerationInput(parseSourceSemanticRequest(JSON.parse(line.userPrompt)));
      const physical = bodies.get(modelInput);
      const wire = prepareSourceSemanticRequestWire({ model: MODEL, providerUrl: origin, apiKey: null,
        requestProfile: REQUEST_PROFILE, openSemantics: fixture.openSemantics }, line, 4096);
      expect(requests.get(modelInput)).toBe(wire.body);
      const raw = listProviderRawAttempts(cacheRoot, key)[0];
      expect(physical).toBeDefined();
      expect(Buffer.from(raw!.response_body!.text, "utf8").equals(physical!)).toBe(true);
      expect(raw!.response_body).toMatchObject({ truncated: false, original_byte_length: physical!.byteLength });
      expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("hit");
    }
    const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8"));
    const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest: receipt.lineage_digest,
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: receipt.limits.starting_missing, maximumAttempts: receipt.limits.maximum_attempts,
      successfulShardCeiling: receipt.limits.successful_shard_ceiling }).snapshot();
    expect(ledger.successfulShards).toBe(fixture.keys.length);
    expect(ledger.unresolvedAttempts).toEqual([]);
    const census = await censusCompleteSourceRecords({ population: "fixture", dataDir, pinnedMetaRoot });
    const publicationAssociations = census.records.map(source => {
      const match = fixture.keys.map(key => ({ key, inspected: inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE) }))
        .find(item => item.inspected.status === "hit" &&
          sourceSemanticRequestCatalog(item.inspected.admitted.request).source_digest === source.corpus_digest);
      if (match?.inspected.status !== "hit") throw new Error("source interpretation association missing");
      return { source_id: source.source_id, source_version: source.source_version,
        generation_key: match.key, request_digest: match.inspected.requestDigest };
    });
    const snapshotPath = join(cacheRoot, "physical-http-publication.sqlite");
    const published = await publishSourceSemanticSnapshot({ snapshotPath,
      dataDirRoot: join(cacheRoot, "physical-http-publication"), recordedAt: "2026-09-25T00:00:00.000Z",
      producerCommit: "a".repeat(40), populations: [{ name: "fixture", dataDir, pinnedMetaRoot,
        cacheRoots: [cacheRoot], model: MODEL, requestProfile: REQUEST_PROFILE, publicationAssociations }] });
    expect(published.published_count).toBe(census.records.length);
    const database = openReadOnlyDatabase(snapshotPath);
    try {
      const rows = database.connection.prepare("SELECT gist FROM evidence_capsules").all() as { gist: string }[];
      expect(rows.some(row => row.gist.includes("complete"))).toBe(true);
    } finally { database.close(); }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 120000);

it("withholds a staged baseline source until its original attempts recover without new calls", async () => {
  const fixture = await setupInteractive();
  const options = { variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    authorityReceiptPath: fixture.receiptPath };
  await runExtractionFill(options);
  const initialCalls = fixture.fetchMock.mock.calls.length;
  expect(initialCalls).toBe(fixture.keys.length);
  const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8"));
  const rawAttempts = fixture.keys.map(key => ({ key, raw: listProviderRawAttempts(cacheRoot, key)[0]! }))
    .sort((left, right) => left.raw.attempt_ordinal - right.raw.attempt_ordinal);
  const rawBytes = new Map(rawAttempts.map(({ key, raw }) => [key,
    readFileSync(providerRawAttemptPath(cacheRoot, key, raw.attempt_ordinal))]));
  const census = await censusCompleteSourceRecords({ population: "fixture", dataDir, pinnedMetaRoot });
  const publicationAssociations = census.records.map(source => {
    const match = fixture.keys.map(key => ({ key,
      result: inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE) }))
      .find(item => item.result.status === "hit" &&
        sourceSemanticRequestCatalog(item.result.admitted.request).source_digest === source.corpus_digest)!;
    if (match.result.status !== "hit") throw new Error("fixture source interpretation missing");
    return { source_id: source.source_id, source_version: source.source_version,
      generation_key: match.key, request_digest: match.result.requestDigest };
  });
  const publish = async (name: string) => publishSourceSemanticSnapshot({
    snapshotPath: join(cacheRoot, `${name}.sqlite`), dataDirRoot: join(cacheRoot, name),
    recordedAt: "2026-09-25T00:00:00.000Z", producerCommit: "a".repeat(40),
    populations: [{ name: "fixture", dataDir, pinnedMetaRoot, cacheRoots: [cacheRoot],
      model: MODEL, requestProfile: REQUEST_PROFILE, publicationAssociations }]
  });

  // The raw and typed files survived, but the ledger stopped after the exact reservations.
  const ledgerPath = join(cacheRoot, readdirSync(cacheRoot)
    .find(name => name.startsWith("extraction-attempt-ledger."))!);
  unlinkSync(ledgerPath);
  const ledgerOptions = { cacheRoot, lineageDigest: receipt.lineage_digest,
    cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
    startingMissing: receipt.limits.starting_missing, maximumAttempts: receipt.limits.maximum_attempts,
    successfulShardCeiling: receipt.limits.successful_shard_ceiling };
  const ledger = openExtractionAttemptLedger(ledgerOptions);
  for (const { key, raw } of rawAttempts) {
    expect(ledger.reserveAttemptOrdinal(key)).toBe(raw.attempt_ordinal);
    expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("pending");
    expect(inspectCachedRawExtraction(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("pending");
  }
  const withheld = await publish("pending-publication");
  expect(withheld.published_count).toBe(0);
  expect(withheld.source_interpretation_binding_complete).toBe(false);

  const resumed = await runExtractionFill(options);
  expect(resumed.coverage).toBe(1);
  expect(resumed.authorityTelemetry?.successfulShards).toBe(fixture.keys.length);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(initialCalls);
  expect(openExtractionAttemptLedger(ledgerOptions).snapshot()).toMatchObject({
    attempts: initialCalls, successfulShards: fixture.keys.length, unresolvedAttempts: []
  });
  for (const { key, raw } of rawAttempts) {
    expect(readFileSync(providerRawAttemptPath(cacheRoot, key, raw.attempt_ordinal))
      .equals(rawBytes.get(key)!)).toBe(true);
    expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("hit");
  }
  const admitted = await publish("admitted-publication");
  expect(admitted.published_count).toBe(census.records.length);
  expect(admitted.source_interpretation_binding_complete).toBe(true);
}, 60000);

it.each([true, false])("keeps a settled source rejection spent after raw loss with known usage=%s", async usageKnown => {
  const fixture = await setupInteractive();
  const options = { variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    authorityReceiptPath: fixture.receiptPath };
  const fetchMock = vi.fn(async () => Response.json({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{" }] } }],
    ...(usageKnown ? { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } } : {})
  }));
  vi.stubGlobal("fetch", fetchMock);
  await runExtractionFill(options);
  expect(fetchMock).toHaveBeenCalledTimes(fixture.keys.length);
  const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8"));
  const ledgerInput = { cacheRoot, lineageDigest: receipt.lineage_digest,
    cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
    startingMissing: receipt.limits.starting_missing, maximumAttempts: receipt.limits.maximum_attempts,
    successfulShardCeiling: receipt.limits.successful_shard_ceiling };
  const before = openExtractionAttemptLedger(ledgerInput).snapshot();
  expect(before).toMatchObject({ attempts: fixture.keys.length, successfulShards: 0,
    telemetry: { totalTokens: usageKnown ? fixture.keys.length * 5 : 0,
      usageUnknownAttempts: usageKnown ? 0 : fixture.keys.length } });
  expect(before.transportFailures).toHaveLength(fixture.keys.length);
  expect(before.transportFailures.every(failure => failure.kind === "response_schema_error")).toBe(true);
  const missingKey = fixture.keys[0]!;
  const raw = listProviderRawAttempts(cacheRoot, missingKey)[0]!;
  const requestDigests = new Map(fixture.keys.map(key => {
    const attempt = listProviderRawAttempts(cacheRoot, key)[0]!;
    if (attempt.kind !== "source_semantic") throw new Error("fixture raw is not a source attempt");
    return [key, attempt.source_request_sha256!] as const;
  }));
  unlinkSync(providerRawAttemptPath(cacheRoot, missingKey, raw.attempt_ordinal));

  await runExtractionFill(options);
  expect(fetchMock).toHaveBeenCalledTimes(fixture.keys.length);
  expect(openExtractionAttemptLedger(ledgerInput).snapshot()).toEqual(before);
  expect(inspectCachedSourceSemantic(cacheRoot, missingKey, MODEL, REQUEST_PROFILE).status).not.toBe("hit");
  const census = await censusCompleteSourceRecords({ population: "fixture", dataDir, pinnedMetaRoot });
  const report = await publishSourceSemanticSnapshot({
    snapshotPath: join(cacheRoot, "lost-rejection.sqlite"),
    dataDirRoot: join(cacheRoot, "lost-rejection"), recordedAt: "2026-09-25T00:00:00.000Z",
    producerCommit: "a".repeat(40), populations: [{ name: "fixture", dataDir, pinnedMetaRoot,
      cacheRoots: [cacheRoot], model: MODEL, requestProfile: REQUEST_PROFILE,
      publicationAssociations: census.records.map((source, index) => ({ source_id: source.source_id,
        source_version: source.source_version, generation_key: fixture.keys[index]!,
        request_digest: requestDigests.get(fixture.keys[index]!)! })) }] });
  expect(report.published_count).toBe(0);
  expect(report.source_interpretation_binding_complete).toBe(false);
}, 60000);

it("does not redispatch a settled success after its pre-shard write and raw are lost", async () => {
  const fixture = await setupInteractive();
  const options = { variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    authorityReceiptPath: fixture.receiptPath };
  const originalImport = sourceArtifacts.importSourceSemanticArtifact;
  let interruptedKey: string | undefined;
  const interrupt = vi.spyOn(sourceArtifacts, "importSourceSemanticArtifact").mockImplementation(input => {
    const result = originalImport(input);
    if (interruptedKey === undefined) {
      interruptedKey = input.result.line.key;
      unlinkSync(cacheFilePath(input.cacheRoot, interruptedKey));
    }
    return result;
  });
  await runExtractionFill(options);
  interrupt.mockRestore();
  expect(interruptedKey).toBeDefined();
  const initialCalls = fixture.fetchMock.mock.calls.length;
  expect(initialCalls).toBe(fixture.keys.length);
  const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8"));
  const ledgerInput = { cacheRoot, lineageDigest: receipt.lineage_digest,
    cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
    startingMissing: receipt.limits.starting_missing, maximumAttempts: receipt.limits.maximum_attempts,
    successfulShardCeiling: receipt.limits.successful_shard_ceiling };
  const before = openExtractionAttemptLedger(ledgerInput).snapshot();
  expect(before).toMatchObject({ attempts: initialCalls, successfulShards: initialCalls - 1,
    telemetry: { totalTokens: initialCalls * 30 } });
  expect(before.settledAttempts).toHaveLength(initialCalls);
  const raw = listProviderRawAttempts(cacheRoot, interruptedKey!)[0]!;
  unlinkSync(providerRawAttemptPath(cacheRoot, interruptedKey!, raw.attempt_ordinal));

  await runExtractionFill(options);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(initialCalls);
  expect(openExtractionAttemptLedger(ledgerInput).snapshot()).toEqual(before);
  expect(inspectCachedSourceSemantic(cacheRoot, interruptedKey!, MODEL, REQUEST_PROFILE).status).not.toBe("hit");
}, 60000);

it("rejects invalid interactive evidence before current reuse and retained quarantine", async () => {
  const fixture = await setupInteractive();
  const args = ["extraction-fill", "--variant", "s", "--data-dir", dataDir,
    "--pinned-meta-root", pinnedMetaRoot, "--extraction-cache-root", cacheRoot,
    "--extraction-open-semantics", "--extraction-source-packing", "complete-source",
    "--extraction-authority", fixture.receiptPath];
  expect(await runCli(args)).toBe(0);
  const calls = fixture.fetchMock.mock.calls.length;
  const currentKey = fixture.keys[0]!;
  const shardPath = cacheFilePath(cacheRoot, currentKey);
  const shard = JSON.parse(readFileSync(shardPath, "utf8"));
  const identity = { model: MODEL, requestProfile: REQUEST_PROFILE };
  const config = { model: MODEL, requestProfile: REQUEST_PROFILE,
    providerUrl: "https://fixture-provider.invalid", apiKey: "", sourcePacking: "complete-source" as const,
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  expect(readValidLedgerShard(cacheRoot, currentKey, identity)).toMatchObject({ successKind: "provider" });
  const inspectChangedCurrent = (changed: object, reason: string) => {
    writeFileSync(shardPath, `${JSON.stringify(changed, null, 2)}\n`);
    expect(inspectCachedSourceSemantic(cacheRoot, currentKey, MODEL, REQUEST_PROFILE))
      .toMatchObject({ status: "invalid", reason: expect.stringContaining(reason) });
    expect(inspectCachedRawExtraction(cacheRoot, currentKey, MODEL, REQUEST_PROFILE))
      .toMatchObject({ status: "invalid" });
    expect(readValidLedgerShard(cacheRoot, currentKey, identity)).toBeUndefined();
  };
  const wrongKind = structuredClone(shard);
  wrongKind.source_semantic.kind = "step_chat_completion";
  inspectChangedCurrent(wrongKind, "kind/profile mismatch");
  const missingOrdinal = structuredClone(shard);
  delete missingOrdinal.source_semantic.result.provenance.attemptOrdinal;
  inspectChangedCurrent(missingOrdinal, "interactive transport binding mismatch");
  const invalidOrdinal = structuredClone(shard);
  invalidOrdinal.source_semantic.result.provenance.attemptOrdinal = 0;
  inspectChangedCurrent(invalidOrdinal, "interactive transport binding mismatch");
  writeFileSync(shardPath, `${JSON.stringify(shard, null, 2)}\n`);
  expect(inspectCachedSourceSemantic(cacheRoot, currentKey, MODEL, REQUEST_PROFILE))
    .toMatchObject({ status: "hit" });
  expect(readValidLedgerShard(cacheRoot, currentKey, identity)).toMatchObject({ successKind: "provider" });
  const importLease = acquireExtractionCacheWriteLease(cacheRoot);
  try {
    const sourceCorpus = shard.source_semantic.source_corpus as string;
    const result = shard.source_semantic.result;
    expect(() => importSourceSemanticArtifact({ config, cacheRoot, writeLease: importLease, sourceCorpus,
      result: { ...result, provenance: { ...result.provenance, attemptOrdinal: 0 } } }))
      .toThrow("interactive transport binding mismatch");
    expect(() => importSourceSemanticArtifact({ config, cacheRoot, writeLease: importLease, sourceCorpus,
      result: { ...result, provenance: { ...result.provenance,
        usage: { inputTokens: -10, outputTokens: 20, totalTokens: 10 } } } }))
      .toThrow("response_metadata usage is invalid");
  } finally { importLease.release(); }
  expect(readValidLedgerShard(cacheRoot, currentKey, identity)).toMatchObject({ successKind: "provider" });

  const emptyInput = { sourceCorpus: "", assertionIds: [], sourceScope: "complete-source" as const,
    source_id: "unbound" as const, source_version: "unbound" as const,
    producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID, producer_version: "1" as const };
  const emptyRequest = buildSourceSemanticRequest(emptyInput);
  const emptyLine = prepareSourceSemanticRequestLine(emptyRequest, [], config);
  const emptyLease = acquireExtractionCacheWriteLease(cacheRoot);
  try {
    writeDeterministicSourceSemanticArtifact({ config, cacheRoot, writeLease: emptyLease,
      line: emptyLine, sourceCorpus: "" });
  } finally { emptyLease.release(); }
  expect(inspectCachedSourceSemantic(cacheRoot, emptyLine.key, MODEL, REQUEST_PROFILE))
    .toMatchObject({ status: "hit", deterministicEmpty: true });
  expect(inspectCachedRawExtraction(cacheRoot, emptyLine.key, MODEL, REQUEST_PROFILE))
    .toMatchObject({ status: "hit", deterministicEmpty: true });
  expect(readValidDeterministicLedgerShard(cacheRoot, emptyLine.key, identity))
    .toMatchObject({ successKind: "deterministic" });

  const current = parseSourceSemanticRequest(JSON.parse(shard.source_semantic.result.line.userPrompt));
  const { source_digest: _currentDigest, ...catalogRequest } = current;
  const retainedRequest = { ...catalogRequest, source_catalog: sourceSemanticRequestCatalog(current), source_request: {
    ...current.source_request, proposal_contract: "source-semantic-proposal-v2"
  } };
  const userPrompt = JSON.stringify(retainedRequest);
  const systemPrompt = "Recorded retired source-semantic prompt bytes";
  const retiredKey = createHash("sha256").update("recorded retired source shard").digest("hex");
  const rawJson = JSON.stringify({ contract: "source-semantic-proposal-v2", outcome: { status: "abstained" } });
  const manifestPath = join(cacheRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtractionCacheManifest;
  const retiredManifest = { ...manifest, system_prompt_sha256: computeSystemPromptSha256(systemPrompt), source_semantic_generation: {
    ...manifest.source_semantic_generation!, normalizer_version: "source-semantic-normalizer-v3"
  } } as unknown as ExtractionCacheManifest;
  writeFileSync(manifestPath, `${JSON.stringify(retiredManifest, null, 2)}\n`);
  shard.cache_key = retiredKey;
  shard.raw_json = rawJson;
  shard.source_semantic.completion = "abstained";
  shard.source_semantic.result.line = { ...shard.source_semantic.result.line, key: retiredKey,
    userPrompt, systemPrompt, requestSha256: createHash("sha256").update(userPrompt).digest("hex") };
  shard.source_semantic.result.rawJson = rawJson;
  shard.source_semantic.result.provenance.responseSha256 = computeExtractionRawJsonSha256(rawJson);
  shard.admission_identity = { ...shard.admission_identity, request_key: retiredKey,
    raw_json_sha256: computeExtractionRawJsonSha256(rawJson),
    generation_sha256: extractionAdmissionGenerationSha256(retiredManifest) };
  const retiredPath = cacheFilePath(cacheRoot, retiredKey);
  mkdirSync(dirname(retiredPath), { recursive: true });
  writeFileSync(retiredPath, `${JSON.stringify(shard, null, 2)}\n`);
  unlinkSync(shardPath);

  const retiredInspection = inspectCachedSourceSemantic(cacheRoot, retiredKey, MODEL, REQUEST_PROFILE);
  expect(retiredInspection, JSON.stringify(retiredInspection))
    .toMatchObject({ status: "invalid", reason: "typed source semantic raw attempt witness is absent" });
  expect(inspectCachedRawExtraction(cacheRoot, retiredKey, MODEL, REQUEST_PROFILE))
    .toMatchObject({ status: "invalid" });
  expect(readValidLedgerShard(cacheRoot, retiredKey, identity)).toBeUndefined();
  expect(readValidDeterministicLedgerShard(cacheRoot, retiredKey, identity)).toBeUndefined();
  assertRetiredByteBindings(retiredPath, retiredKey, current);
  expect(await runCli(args)).not.toBe(0);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(calls);
}, 60000);

function assertRetiredByteBindings(retiredPath: string, retiredKey: string,
  current: ReturnType<typeof parseSourceSemanticRequest>): void {
  const shard = JSON.parse(readFileSync(retiredPath, "utf8"));
  const retainedRequest = JSON.parse(shard.source_semantic.result.line.userPrompt);
  const inspectChanged = (changed: object, reason: string) => {
    writeFileSync(retiredPath, `${JSON.stringify(changed, null, 2)}\n`);
    expect(inspectCachedSourceSemantic(cacheRoot, retiredKey, MODEL, REQUEST_PROFILE))
      .toMatchObject({ status: "invalid", reason: expect.stringContaining(reason) });
    expect(inspectCachedRawExtraction(cacheRoot, retiredKey, MODEL, REQUEST_PROFILE))
      .toMatchObject({ status: "invalid" });
    expect(readValidLedgerShard(cacheRoot, retiredKey, { model: MODEL, requestProfile: REQUEST_PROFILE }))
      .toBeUndefined();
  };
  const changedSource = structuredClone(shard);
  changedSource.source_semantic.source_corpus += " CORRUPTED";
  inspectChanged(changedSource, "source bytes differ");
  const changedPrompt = structuredClone(shard);
  changedPrompt.source_semantic.result.line.systemPrompt += " CORRUPTED";
  inspectChanged(changedPrompt, "prompt bytes differ");
  const missingDigest = structuredClone(shard);
  const unboundRequest = structuredClone(retainedRequest) as Record<string, unknown>;
  delete unboundRequest.source_catalog;
  missingDigest.source_semantic.result.line.userPrompt = JSON.stringify(unboundRequest);
  missingDigest.source_semantic.result.line.requestSha256 =
    computeExtractionRawJsonSha256(missingDigest.source_semantic.result.line.userPrompt);
  inspectChanged(missingDigest, "digest witness is absent");
  const wrongKind = structuredClone(shard);
  wrongKind.source_semantic.kind = "step_chat_completion";
  inspectChanged(wrongKind, "kind/profile mismatch");
  const invalidUsage = structuredClone(shard);
  invalidUsage.source_semantic.result.provenance.usage =
    { inputTokens: -10, outputTokens: 20, totalTokens: 10 };
  invalidUsage.response_metadata.usage =
    { input_tokens: -10, output_tokens: 20, total_tokens: 10 };
  inspectChanged(invalidUsage, "response_metadata usage is invalid");
  const missingOrdinal = structuredClone(shard);
  delete missingOrdinal.source_semantic.result.provenance.attemptOrdinal;
  inspectChanged(missingOrdinal, "interactive transport binding mismatch");
  const invalidOrdinal = structuredClone(shard);
  invalidOrdinal.source_semantic.result.provenance.attemptOrdinal = 0;
  inspectChanged(invalidOrdinal, "interactive transport binding mismatch");

  const emptyCurrent = buildSourceSemanticRequest({ sourceCorpus: "", assertionIds: [], sourceScope: "complete-source",
    source_id: "unbound", source_version: "unbound", producer_id: "official-api-source-semantic", producer_version: "1" });
  const emptyRequest = { ...retainedRequest, source_catalog: sourceSemanticRequestCatalog(emptyCurrent),
    source_request: { ...retainedRequest.source_request, source_assertions: [], assertion_locations: [] } };
  const emptyUserPrompt = JSON.stringify(emptyRequest);
  const empty = { ...shard, raw_json: "", response_metadata: undefined, transport_provenance: undefined,
    admission_identity: { ...shard.admission_identity, raw_json_sha256: computeExtractionRawJsonSha256("") },
    source_semantic: { ...shard.source_semantic, kind: "deterministic_empty", source_corpus: "",
      completion: "no_eligible_source", result: undefined,
      line: { ...shard.source_semantic.result.line, unitKeys: [], userPrompt: emptyUserPrompt,
        requestSha256: computeExtractionRawJsonSha256(emptyUserPrompt) } } };
  writeFileSync(retiredPath, `${JSON.stringify(empty, null, 2)}\n`);
  expect(inspectCachedSourceSemantic(cacheRoot, retiredKey, MODEL, REQUEST_PROFILE))
    .toMatchObject({ status: "retired", eligibility: "retained_only" });
  expect(readValidDeterministicLedgerShard(cacheRoot, retiredKey,
    { model: MODEL, requestProfile: REQUEST_PROFILE })).toBeUndefined();
  inspectChanged({ ...empty, source_semantic: { ...empty.source_semantic,
    line: { ...empty.source_semantic.line, unitKeys: ["unexpected"] } } }, "retained empty source binding mismatch");
  const assertedRequest = { ...emptyRequest, source_request: { ...emptyRequest.source_request,
    source_assertions: retainedRequest.source_request.source_assertions } };
  const assertedUserPrompt = JSON.stringify(assertedRequest);
  inspectChanged({ ...empty, source_semantic: { ...empty.source_semantic,
    line: { ...empty.source_semantic.line, userPrompt: assertedUserPrompt,
      requestSha256: computeExtractionRawJsonSha256(assertedUserPrompt) } } }, "retained empty source binding mismatch");
  const catalogRequest = { ...emptyRequest, source_catalog: { ...emptyRequest.source_catalog,
    assertions: retainedRequest.source_catalog.assertions } };
  const catalogUserPrompt = JSON.stringify(catalogRequest);
  inspectChanged({ ...empty, source_semantic: { ...empty.source_semantic,
    line: { ...empty.source_semantic.line, userPrompt: catalogUserPrompt,
      requestSha256: computeExtractionRawJsonSha256(catalogUserPrompt) } } }, "retained empty source binding mismatch");
  const selectionRequest = { ...current, source_request: { ...current.source_request,
    proposal_contract: "source-semantic-proposal-v7" } };
  const selectionUserPrompt = JSON.stringify(selectionRequest);
  const selection = structuredClone(shard);
  selection.source_semantic.result.line.userPrompt = selectionUserPrompt;
  selection.source_semantic.result.line.requestSha256 = computeExtractionRawJsonSha256(selectionUserPrompt);
  writeFileSync(retiredPath, `${JSON.stringify(selection, null, 2)}\n`);
  expect(inspectCachedSourceSemantic(cacheRoot, retiredKey, MODEL, REQUEST_PROFILE))
    .toMatchObject({ status: "invalid", reason: "typed source semantic raw attempt witness is absent" });
  const changedSelectionPrompt = structuredClone(selection);
  changedSelectionPrompt.source_semantic.result.line.systemPrompt += " CORRUPTED";
  inspectChanged(changedSelectionPrompt, "prompt bytes differ");
  selection.source_semantic.source_corpus += " CORRUPTED";
  inspectChanged(selection, "source bytes differ");
  writeFileSync(retiredPath, `${JSON.stringify(shard, null, 2)}\n`);
}

it("quarantines an interactive generateContent line through the same source-semantic receiver as Batch", async () => {
  const fixture = await setupInteractive("unknown_alias");
  const args = [
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath
  ];
  expect(await runCli(args)).toBe(0);
  const calls = fixture.fetchMock.mock.calls.length;
  const retained = fixture.keys.flatMap(key => listProviderRawAttempts(cacheRoot, key));
  expect(await runCli(args)).toBe(0);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(calls);
  expect(fixture.keys.flatMap(key => listProviderRawAttempts(cacheRoot, key))).toEqual(retained);
  for (const key of fixture.keys) {
    const inspected = inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE);
    expect(inspected.status).not.toBe("hit");
    expect(listProviderRawAttempts(cacheRoot, key)[0]).toMatchObject({
      kind: "source_semantic", full_replay_possible: true
    });
  }
  expect(existsSync(join(cacheRoot, "gemini-batch-plan.json"))).toBe(false);
}, 60000);

it.each(["transport", "admission", "completion"] as const)("keeps settled %s failure non-executable after raw replacement", async failure => {
  const fixture = await setupInteractive(failure === "completion" ? "semantic" : "unknown_alias");
  if (failure === "transport") fixture.fetchMock.mockImplementation(async () =>
    Response.json({ error: { message: "fixture server failure" } }, { status: 500 }));
  if (failure === "completion") fixture.fetchMock.mockImplementation(async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    return Response.json({ candidates: [{ content: { parts: [{ text: authoredResponse(prompt) }] } }] });
  });
  const args = [
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics", "--concurrency", "1",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath
  ];
  expect(await runCli(args)).toBe(0);
  const raw = fixture.keys.flatMap(key => listProviderRawAttempts(cacheRoot, key))
    .sort((left, right) => left.attempt_ordinal - right.attempt_ordinal)[0]!;
  const ledgerPath = join(cacheRoot, readdirSync(cacheRoot).find(name => name.startsWith("extraction-attempt-ledger"))!);
  const ledgerBefore = readFileSync(ledgerPath, "utf8");
  if (failure === "completion") {
    expect(raw).toMatchObject({ finish_reason: null, completion_witness: null });
    expect(raw.transport_failure).toBeUndefined();
    expect(JSON.parse(ledgerBefore)).toMatchObject({ transport_failures: [], unresolved_attempts: [],
      successful_shards: [], settled_attempts: expect.arrayContaining([expect.objectContaining({
        cache_key: raw.cache_key, attempt_ordinal: raw.attempt_ordinal
      })]) });
  } else {
    expect(JSON.parse(ledgerBefore).transport_failures).toContainEqual(expect.objectContaining({
      attempt_ordinal: raw.attempt_ordinal, kind: failure === "transport" ? "http_error" : "response_schema_error"
    }));
  }
  const prompt = JSON.parse(String(fixture.fetchMock.mock.calls[0]![1]!.body)).contents[0].parts[0].text as string;
  const rawPath = providerRawAttemptPath(cacheRoot, raw.cache_key, raw.attempt_ordinal);
  unlinkSync(rawPath);
  writeProviderRawAttempt({ root: cacheRoot, cacheKey: raw.cache_key, attemptOrdinal: raw.attempt_ordinal,
    kind: "source_semantic", model: MODEL, requestProfile: REQUEST_PROFILE, requestDigest: raw.request_digest,
    decodedText: authoredResponse(prompt), finishReason: "STOP" });
  const replacement = readFileSync(rawPath, "utf8");
  fixture.fetchMock.mockClear();
  expect(await runCli(args)).toBe(2);
  expect(fixture.fetchMock).not.toHaveBeenCalled();
  expect(inspectCachedSourceSemantic(cacheRoot, raw.cache_key, MODEL, REQUEST_PROFILE).status).not.toBe("hit");
  expect(existsSync(cacheFilePath(cacheRoot, raw.cache_key))).toBe(false);
  expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);
  expect(readFileSync(rawPath, "utf8")).toBe(replacement);
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

it.each(["network", "http", "authentication", "historical authentication"])("retains each interactive %s failure and never repeats terminal attempts", async (kind) => {
  const fixture = await setupInteractive();
  const authentication = kind.endsWith("authentication");
  const fetchMock = vi.fn(async () => {
    if (kind === "http") return Response.json({ error: { code: 500, message: "fixture server failure" } }, { status: 500 });
    if (authentication) return Response.json({ error: { code: 401, message: "fixture authentication failure" } }, { status: 401 });
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
  const attemptsPerKey = authentication ? 1 : 2;
  expect(ledger.attempts).toBe(fixture.keys.length * attemptsPerKey);
  for (const key of fixture.keys) {
    const raws = listProviderRawAttempts(cacheRoot, key);
    expect(raws).toHaveLength(attemptsPerKey);
    expect(raws.every((raw) => raw.failure_retryable === !authentication && raw.usage_known === false)).toBe(true);
    if (kind === "http") expect(raws[0]).toMatchObject({
      transport_failure: { kind: "http_error", httpStatus: 500 }, response_body: { text: expect.stringContaining("fixture server failure") }
    });
    if (kind === "historical authentication") {
      // Model the historical contradictory flag in this synthetic fixture before reopening it.
      writeFileSync(providerRawAttemptPath(cacheRoot, key, raws[0]!.attempt_ordinal),
        JSON.stringify({ ...raws[0], failure_retryable: true }));
    }
  }
  const rawBytes = fixture.keys.flatMap(key => listProviderRawAttempts(cacheRoot, key).map(raw => {
    const path = providerRawAttemptPath(cacheRoot, key, raw.attempt_ordinal);
    return { path, bytes: readFileSync(path) };
  }));
  const ledgerPath = join(cacheRoot, ledgerName!), ledgerBytes = readFileSync(ledgerPath);
  expect(await runCli(args)).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(fixture.keys.length * attemptsPerKey);
  for (const { path, bytes } of rawBytes) expect(readFileSync(path)).toEqual(bytes);
  expect(readFileSync(ledgerPath)).toEqual(ledgerBytes);
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

it.each(["intact", "changed"] as const)("rechecks %s persisted raw after a shard write failure without a second provider call", async integrity => {
  const fixture = await setupInteractive();
  const buckets = [...new Set(fixture.keys.map((key) => join(cacheRoot, key.slice(0, 2))))];
  for (const bucket of buckets) mkdirSync(bucket, { recursive: true });
  if (process.platform === "win32") {
    const respond = fixture.fetchMock.getMockImplementation();
    fixture.fetchMock.mockImplementation(async (url, init) => {
      const result = await respond!(url, init);
      for (const bucket of buckets) {
        rmSync(bucket, { recursive: true, force: true });
        writeFileSync(bucket, "not a directory");
      }
      return result;
    });
  } else {
    for (const bucket of buckets) chmodSync(bucket, 0o500);
  }
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath,
    "--concurrency", String(Math.max(fixture.keys.length, 1))
  ])).toBe(2);
  expect(fixture.fetchMock).toHaveBeenCalled();
  expect(fixture.keys.some((key) => listProviderRawAttempts(cacheRoot, key).length > 0)).toBe(true);
  for (const bucket of buckets) {
    if (process.platform === "win32") {
      rmSync(bucket, { force: true });
      mkdirSync(bucket, { recursive: true });
    } else chmodSync(bucket, 0o700);
  }
  fixture.fetchMock.mockClear();
  if (integrity === "changed") {
    const retained = fixture.keys.flatMap(key => listProviderRawAttempts(cacheRoot, key))[0]!;
    const rawPath = providerRawAttemptPath(cacheRoot, retained.cache_key, retained.attempt_ordinal);
    const corrupted = JSON.stringify({ ...retained, decoded_text: `${retained.decoded_text} ` });
    writeFileSync(rawPath, corrupted);
    expect(await runCli([
      "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
      "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
      "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath,
      "--concurrency", "1"
    ])).toBe(2);
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(rawPath, "utf8")).toBe(corrupted);
    expect(inspectCachedSourceSemantic(cacheRoot, retained.cache_key, MODEL, REQUEST_PROFILE).status).not.toBe("hit");
    return;
  }
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

it("does not redispatch after raw loss exposes an anonymous spent attempt", async () => {
  const fixture = await setupInteractive();
  await runExtractionFill({ variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
    sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    concurrency: 1, authorityReceiptPath: fixture.receiptPath, log: () => undefined });
  const originalCalls = fixture.fetchMock.mock.calls.length;
  expect(originalCalls).toBeGreaterThan(0);
  const ledgerPath = join(cacheRoot, readdirSync(cacheRoot).find(name => name.startsWith("extraction-attempt-ledger."))!);
  const record = JSON.parse(readFileSync(ledgerPath, "utf8"));
  record.successful_shards = [];
  record.pending_keys = fixture.keys;
  delete record.settled_attempts;
  writeFileSync(ledgerPath, JSON.stringify(record));
  for (const key of fixture.keys) {
    const raw = listProviderRawAttempts(cacheRoot, key)[0]!;
    unlinkSync(cacheFilePath(cacheRoot, key));
    unlinkSync(providerRawAttemptPath(cacheRoot, key, raw.attempt_ordinal));
  }
  const before = readFileSync(ledgerPath, "utf8");
  await expect(runExtractionFill({ variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
    sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    concurrency: 1, authorityReceiptPath: fixture.receiptPath, log: () => undefined }))
    .rejects.toThrow(/history is incomplete/u);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(originalCalls);
  expect(readFileSync(ledgerPath, "utf8")).toBe(before);
});
