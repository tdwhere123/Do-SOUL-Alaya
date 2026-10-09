import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT, SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT, sourceSemanticGenerationInput } from "@do-soul/alaya-soul";
import { openReadOnlyDatabase } from "@do-soul/alaya-storage";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { listProviderRawAttempts } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { prepareSourceSemanticRequestWire } from "../../../runs/extraction/fill/source-semantic-interactive-request.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, type ExtractionOpenSemanticsGeneration } from "../../../runs/extraction/request-artifact.js";
import { prepareNativeSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { prepareSourcePublicationAssociations } from "../../../runs/snapshot/source-records/prepare-associations.js";
import { publishSourceSemanticSnapshot, type SourcePublicationPopulation } from "../../../runs/snapshot/source-records/publish.js";
import { setExtractionCredentialFixture } from "../extraction-fill/fixture.js";

vi.hoisted(() => {
  for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
});
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model = "gemini-3.1-flash-lite", requestProfile = "gemini-3.1-low-v1" as const;
const providerUrl = "https://generativelanguage.googleapis.com";
const task = { contract: "source-semantic-generation-task-v1" as const, context: "complete_original_source" as const,
  original_query: " Did Mira arrive? \n", responsibility: { kind: "original_query_task" as const, other_meaning: "unassessed" as const } };
const generation = { ...EXTRACTION_OPEN_SEMANTICS_GENERATION,
  generation_view_contract: SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT,
  generation_schema_contract: SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT, generation_task: task };
const sources = ["Mira arrived.\nMira departed.\n", "Resort welcomes dogs.\n"];
const arrival = { contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT, outcome: { status: "interpreted" }, content: {
  nodes: [{ kind: "statement", key: "arrival", predicate: { kind: "explicit", reading: "arrived",
    support: { assertion_id: 1, text: "arrived" } }, arguments: [{ role: "subject", target: {
      kind: "entity", mentions: [{ assertion_id: 1, text: "Mira" }] } }], qualifications: [] }],
  roots: [{ act: "assertion", expression: { kind: "content_ref", key: "arrival" } }], gaps: [] } };

async function withNativeFixture(run: (fixture: Awaited<ReturnType<typeof createNativeFixture>>) => Promise<void>) {
  const captured = new Map<string, { request: string; response: string; method: string | undefined; contentType: string | undefined }>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const physical = Buffer.concat(chunks).toString("utf8");
      const userPrompt = JSON.parse(physical).contents[0].parts[0].text as string;
      const input = JSON.parse(userPrompt).source_request;
      const raw = input.source_assertions[0].text.includes("Mira") ? arrival :
        { contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT, outcome: { status: "abstained" } };
      const body = JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(raw) }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
      captured.set(userPrompt, { request: physical, response: body, method: request.method,
        contentType: request.headers["content-type"] });
      response.writeHead(200, { "content-type": "application/json" }); response.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", model);
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", requestProfile);
    vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", providerUrl);
    const nativeFetch = globalThis.fetch;
    // Quote/preflight authority keeps its supported route; only the test transport
    // endpoint changes. The physical socket receives the unchanged owned wire.
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== providerUrl || init?.redirect !== "error") throw new Error("only fixture-routed native transport allowed");
      return nativeFetch(`${origin}${url.pathname}${url.search}`, init);
    });
    setExtractionCredentialFixture();
    await run(await createNativeFixture(origin, captured));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function createNativeFixture(origin: string, captured: Map<string, { request: string; response: string;
  method: string | undefined; contentType: string | undefined }>) {
  const root = mkdtempSync(join(tmpdir(), "source-task-publication-")); roots.push(root);
  const snapshotPath = join(root, "sources.sqlite");
  await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "install"), workspaceId: "source-task",
    runId: "source-task", producerCommit: "0".repeat(40), sources: sources.map((content_bytes, index) => ({
      source_id: `source-${index}`, source_version: "1", title: `Source ${index}`, content_bytes,
      source_observed_at: "2026-09-20T12:00:00.000Z", recorded_at: "2026-09-21T09:00:00.000Z" })) });
  const population = { name: "source-task", nativeSnapshotPath: snapshotPath, model, requestProfile };
  const options = (openSemantics: ExtractionOpenSemanticsGeneration, cacheRoot: string) => ({
    variant: "native_source_snapshot" as const, nativeSourcePopulation: { name: population.name, snapshotPath },
    sourcePacking: "complete-source" as const, openSemantics, cacheRoot });
  const fill = async (openSemantics: ExtractionOpenSemanticsGeneration, cacheName: string) => {
    const cacheRoot = join(root, cacheName); mkdirSync(cacheRoot);
    const selected = options(openSemantics, cacheRoot);
    const inspection = await inspectExtractionAuthority({ ...selected, action: "sample", revision: readCurrentExtractionAuthorityRevision() });
    const preflight = await preflightSourceSemanticInteractive({ ...selected, preflightKeys: inspection.missingKeys,
      preflightOutputTokenCap: 16_384, geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
    const receipt = createExtractionAuthorityReceipt({ action: "sample", sampleScope: createExtractionSampleScope(inspection.missingKeys, inspection),
      sourcePreflight: preflight, observation: inspection.observation, inspection, maxConcurrency: 1,
      outputTokenCap: { field: "maxOutputTokens", value: 16_384 }, diskFloorBytes: 0,
      priceEstimate: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5, maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
    const receiptPath = join(root, `${cacheName}-receipt.json`); writeExtractionAuthorityReceipt(receiptPath, receipt);
    await runExtractionFill({ ...selected, authorityReceiptPath: receiptPath, concurrency: 1 });
    const preparationPath = join(root, `${cacheName}-preflight.json`); writeFileSync(preparationPath, JSON.stringify(preflight));
    const associations = await prepareSourcePublicationAssociations({ ...population, openSemantics },
      [{ cacheRoot, retainedPreparationPath: preparationPath }], join(root, `${cacheName}-associations.json`));
    return { cacheRoot, selected, preflight, inspection, preparationPath, associations };
  };
  const publish = (population: SourcePublicationPopulation, name: string) => publishSourceSemanticSnapshot({
    snapshotPath: join(root, `${name}.sqlite`), dataDirRoot: join(root, `${name}-publish`), recordedAt: "2026-09-25T00:00:00.000Z",
    workspaceId: "source-task", runId: "source-task", producerCommit: "0".repeat(40), populations: [population] });
  return { root, origin, captured, population, options, fill, publish };
}

it("retains scoped task and abstention through physical HTTP, native cache reopen and SQLite publication", async () => {
  await withNativeFixture(async fixture => {
    const filled = await fixture.fill(generation, "scoped");
    expect(filled.preflight.ready_requests).toHaveLength(2);
    for (const line of filled.preflight.ready_requests) {
      const cached = inspectCachedSourceSemantic(filled.cacheRoot, line.key, model, requestProfile);
      expect(cached.status).toBe("hit"); if (cached.status !== "hit") throw new Error("missing native cache hit");
      expect(cached.admitted.request.source_request.generation_task).toEqual(task);
      const input = sourceSemanticGenerationInput(cached.admitted.request), physical = fixture.captured.get(input)!;
      expect(physical).toBeDefined();
      expect(physical.method).toBe("POST"); expect(physical.contentType).toBe("application/json");
      expect(physical.request).toBe(prepareSourceSemanticRequestWire({ model, requestProfile, providerUrl,
        apiKey: null, openSemantics: generation }, line, 16_384).body);
      const body = JSON.parse(input).source_request;
      expect(sources).toContain(body.original_source);
      expect(body.generation_task).toEqual(task);
      expect(body.source_assertions.map((unit: { text: string }) => unit.text).join("\n") + "\n").toBe(body.original_source);
      const raw = listProviderRawAttempts(filled.cacheRoot, line.key)[0]!;
      expect(raw.response_body).toMatchObject({ text: physical.response, truncated: false,
        original_byte_length: Buffer.byteLength(physical.response) });
      if (body.original_source === sources[0]) {
        expect(cached.admitted.interpretation?.generation_task).toEqual(task);
        expect(cached.admitted.interpretation?.gaps).toContainEqual(expect.objectContaining({ kind: "uninterpreted_clause" }));
      } else {
        expect(cached.admitted.outcome.status).toBe("abstained"); expect(cached.admitted.interpretation).toBeUndefined();
      }
    }
    const reopened = await inspectExtractionAuthority({ ...filled.selected, action: "sample", revision: readCurrentExtractionAuthorityRevision() });
    expect(reopened.missingKeys).toEqual([]); expect(fixture.captured.size).toBe(2);
    const report = await fixture.publish({ ...fixture.population, openSemantics: generation, cacheRoots: [filled.cacheRoot],
      publicationAssociations: filled.associations.publicationAssociations }, "scoped");
    expect(report.published_count).toBe(1);
    const db = openReadOnlyDatabase(join(fixture.root, "scoped.sqlite"));
    try {
      const rows = db.connection.prepare("SELECT gist FROM evidence_capsules").all() as { gist: string }[];
      expect(rows.some(row => row.gist.includes(JSON.stringify(task)))).toBe(true);
    } finally { db.close(); }
  });
}, 120_000);

it("rejects task-mutated native keys, manifest reuse and retained publication owner", async () => {
  await withNativeFixture(async fixture => {
    const filled = await fixture.fill(generation, "scoped");
    const changed = { ...generation, generation_task: { ...task, original_query: task.original_query + "?" } };
    const emptyRoot = join(fixture.root, "empty"); mkdirSync(emptyRoot);
    await expect(preflightSourceSemanticInteractive({ ...fixture.options(changed, emptyRoot), preflightKeys: filled.inspection.missingKeys,
      preflightOutputTokenCap: 16_384, geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } })).rejects.toThrow(/outside/u);
    await expect(inspectExtractionAuthority({ ...fixture.options(changed, filled.cacheRoot), action: "sample",
      revision: readCurrentExtractionAuthorityRevision() })).rejects.toThrow(/generation|manifest/u);
    await expect(prepareSourcePublicationAssociations({ ...fixture.population, openSemantics: changed },
      [{ cacheRoot: filled.cacheRoot, retainedPreparationPath: filled.preparationPath }], join(fixture.root, "foreign-associations.json")))
      .rejects.toThrow(/foreign|generation/u);
    expect(existsSync(join(fixture.root, "foreign-associations.json"))).toBe(false);
  });
}, 120_000);

it("rejects cached cue, duty or absent task under a declared generation before snapshot effects", async () => {
  await withNativeFixture(async fixture => {
    const scoped = await fixture.fill(generation, "scoped");
    const taskFree = await fixture.fill({ ...generation, generation_task: undefined }, "task-free");
    const mismatches = [
      { retained: scoped, declared: { ...generation, generation_task: { ...task, original_query: task.original_query + "?" } } },
      { retained: scoped, declared: { ...generation, generation_task: { ...task, responsibility: { kind: "all_supplied_meaning" as const } } } },
      { retained: taskFree, declared: generation }, { retained: scoped, declared: undefined }
    ];
    for (const [index, { retained, declared }] of mismatches.entries()) {
      const name = `mismatch-${index}`;
      await expect(fixture.publish({ ...fixture.population, ...(declared === undefined ? {} : { openSemantics: declared }),
        cacheRoots: [retained.cacheRoot], publicationAssociations: retained.associations.publicationAssociations }, name))
        .rejects.toThrow(/declared generation/u);
      expect(existsSync(join(fixture.root, `${name}.sqlite`))).toBe(false);
      expect(existsSync(join(fixture.root, `${name}.sqlite.publication.json`))).toBe(false);
      expect(existsSync(join(fixture.root, `${name}-publish`))).toBe(false);
    }
  });
}, 120_000);
