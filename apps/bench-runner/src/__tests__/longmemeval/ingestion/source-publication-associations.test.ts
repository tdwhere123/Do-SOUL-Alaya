import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { parseSourceSemanticRequest, prepareSourceSemanticRevision } from "@do-soul/alaya-soul";
import { registerExtractionFillHooks, setExtractionCredentialFixture } from "../extraction-fill/fixture.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { preflightExtractionBatch } from "../../../runs/extraction/fill/batch-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { prepareSourcePublicationAssociations } from "../../../runs/snapshot/source-records/prepare-associations.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { runSemanticChainLauncher } from "../../../runs/semantic-chain/launch.js";

const MODEL = "gemini-2.5-flash-lite";
const REQUEST_PROFILE = "gemini-2.5-nonthinking-v1" as const;
const CLOCK = "2026-09-23T00:00:00.000Z";
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), "longmemeval_s");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function question(id: string, themes: string[]) {
  return { question_id: id, question_type: "fixture", question: "Fixture query", answer: "unused fixture field",
    question_date: "2026-09-23", haystack_session_ids: themes.map(() => "shared-session"),
    haystack_dates: themes.map((_, index) => index === 0 ? "2023-09-10" : "2023-09-12"),
    haystack_sessions: themes.map(theme => [{ role: "user" as const, content: `I completed ${theme}.` }]),
    answer_session_ids: [] };
}

function response(userPrompt: string) {
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions[0]!;
  const theme = assertion.text.includes("alpha") ? "alpha" : "beta";
  return JSON.stringify({ contract: "source-semantic-proposal-v6", outcome: { status: "interpreted" }, content: {
    roots: [{ act: "assertion", expression: { kind: "statement",
      predicate: { kind: "explicit", reading: "complete", support: { assertion_id: assertion.assertion_id, text: "completed" } },
      arguments: [{ role: "theme", target: { kind: "entity", key: "r0", mentions: [{ assertion_id: assertion.assertion_id, text: theme }] } }] } }]
  } });
}

async function fixture(revised = false) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  await writeDataset([question("outside", ["alpha"]), question("repeated", ["alpha", "alpha"]), question("unique", ["beta"])]);
  const options = { variant: "longmemeval_s" as const, cacheRoot, dataDir, pinnedMetaRoot,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const batch = { operation: "prepare" as const, limits: { maxJobs: 1, maxRequestsPerJob: 100, maxFileBytes: 1000000,
    maxInputTokensPerJob: 1000000, maxEnqueuedTokens: 1000000, maxOutputTokens: 4096, maxUsd: 1,
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10 } };
  const base = await preflightExtractionBatch({ ...options, batch });
  const generation = revised ? { ...EXTRACTION_OPEN_SEMANTICS_GENERATION, revisions: base.planned_requests.map(line =>
    prepareSourceSemanticRevision(parseSourceSemanticRequest(JSON.parse(line.userPrompt)), "invalid JSON", [], { responseCompletion: "complete" })) }
    : EXTRACTION_OPEN_SEMANTICS_GENERATION;
  const preflight = revised ? await preflightExtractionBatch({ ...options, openSemantics: generation, batch }) : base;
  const preflightPath = join(cacheRoot, "preflight.json");
  writeFileSync(preflightPath, JSON.stringify(preflight));
  const inspection = await inspectExtractionAuthority({ ...options, openSemantics: generation,
    revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 }, inspection });
  const authorityReceiptPath = join(cacheRoot, "authority.json");
  writeExtractionAuthorityReceipt(authorityReceiptPath, receipt);
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (!new URL(String(url)).pathname.endsWith(":streamGenerateContent")) throw new Error("unexpected fixture transport");
    const userPrompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: response(userPrompt) }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await runExtractionFill({ ...options, openSemantics: generation, authorityReceiptPath });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const line of preflight.planned_requests) expect(inspectCachedSourceSemantic(cacheRoot, line.key, MODEL, REQUEST_PROFILE).status).toBe("hit");
  const population = { name: "fixture", dataDir, pinnedMetaRoot, cacheRoot, model: MODEL, requestProfile: REQUEST_PROFILE };
  return { population, preflight, preflightPath, generation, fetchMock };
}

it("prepares the fixed CLI window and publishes one admitted interpretation at both original positions and dates", async () => {
  const f = await fixture();
  const population = { ...f.population, questionWindow: { offset: 1, limit: 1 } };
  const config = join(cacheRoot, "association-config.json"), out = join(cacheRoot, "prepared.json");
  writeFileSync(config, JSON.stringify(population));
  const retained = [f.preflightPath, join(cacheRoot, "manifest.json"), ...f.preflight.planned_requests.map(line => cacheFilePath(cacheRoot, line.key))];
  const before = retained.map(path => readFileSync(path, "utf8"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await runSemanticChainLauncher(["associate", "--config", config, "--preflight", f.preflightPath, "--out", out])).toBe(0);
  const associations = JSON.parse(readFileSync(`${out}.associations.json`, "utf8"));
  expect(associations.map((row: { source_id: string }) => row.source_id)).toEqual(["fixture:repeated-s0-r0", "fixture:repeated-s1-r0"]);
  expect(new Set(associations.map((row: { generation_key: string }) => row.generation_key)).size).toBe(1);
  expect(new Set(associations.map((row: { request_digest: string }) => row.request_digest)).size).toBe(1);
  const report = await publishSourceSemanticSnapshot({ snapshotPath: join(cacheRoot, "published.sqlite"),
    dataDirRoot: join(cacheRoot, "publication"), recordedAt: CLOCK, producerCommit: "a".repeat(40),
    populations: [{ ...population, cacheRoots: [cacheRoot], publicationAssociations: associations }] });
  expect(report).toMatchObject({ census_count: 2, published_count: 2, source_interpretation_binding_complete: false });
  expect(report.unbound_source_interpretation_artifacts).toHaveLength(1);
  expect(report.unbound_source_interpretation_artifacts[0]!.status).toBe("unbound");
  expect(report.sources.every(row => row.source_interpretation_binding?.kind === "host_publication_association")).toBe(true);
  for (const field of ["record_id", "interpretation_id", "evidence_object_id"] as const) {
    expect(report.sources.every(row => row[field] !== undefined)).toBe(true);
    expect(new Set(report.sources.map(row => row[field])).size).toBe(2);
  }
  for (let reopen = 0; reopen < 2; reopen++) {
    const db = new Database(report.snapshot_path, { readonly: true });
    try {
      expect(db.prepare("SELECT source_id, source_version, source_body, event_time, recorded_at FROM source_records ORDER BY source_id").all())
        .toEqual(["2023-09-10T00:00:00.000Z", "2023-09-12T00:00:00.000Z"].map((event_time, index) => ({
          source_id: `fixture:repeated-s${index}-r0`, source_version: associations[index].source_version,
          source_body: "User: I completed alpha.", event_time, recorded_at: CLOCK })));
      for (const [index, source] of report.sources.entries()) {
        const evidence = db.prepare("SELECT gist FROM evidence_capsules WHERE object_id = ?").get(source.evidence_object_id) as { gist: string };
        expect(JSON.parse(evidence.gist)).toMatchObject({
          interpretation_id: source.interpretation_id, source_target: { root_id: source.record_id },
          interpretation: { source: { source_id: `fixture:repeated-s${index}-r0`, source_version: associations[index].source_version } }
        });
      }
    } finally { db.close(); }
  }
  expect(retained.map(path => readFileSync(path, "utf8"))).toEqual(before);
  expect(f.fetchMock).toHaveBeenCalledTimes(2);
}, 60000);

it("associates unique and repeated occurrences with only the independently configured request generation", async () => {
  const f = await fixture(true);
  const unmatched = await prepareSourcePublicationAssociations(f.population, f.preflightPath, join(cacheRoot, "unmatched.json"));
  expect(unmatched.publicationAssociations).toEqual([]);
  expect(unmatched.artifacts.every(row => row.status === "unbound")).toBe(true);
  expect(unmatched.sources).toHaveLength(4);
  expect(unmatched.sources.every(row => row.reason === "missing_current_artifact")).toBe(true);
  const matched = await prepareSourcePublicationAssociations({ ...f.population, openSemantics: f.generation }, f.preflightPath, join(cacheRoot, "matched.json"));
  expect(matched.publicationAssociations.map(row => row.source_id).sort()).toEqual([
    "fixture:outside-s0-r0", "fixture:repeated-s0-r0", "fixture:repeated-s1-r0", "fixture:unique-s0-r0"
  ]);
  expect(matched.artifacts).toHaveLength(2);
  expect(matched.artifacts.every(row => row.status === "associated")).toBe(true);
  expect(f.fetchMock).toHaveBeenCalledTimes(2);
}, 60000);

it("keeps invalid artifacts, missing artifacts, and missing retained request proof explicitly unassociated", async () => {
  const f = await fixture();
  writeFileSync(f.preflightPath, JSON.stringify({ planned_requests: [] }));
  const unproven = await prepareSourcePublicationAssociations(f.population, f.preflightPath, join(cacheRoot, "unproven.json"));
  expect(unproven.publicationAssociations).toEqual([]);
  expect(unproven.sources.every(row => row.reason === "unproven_retained_request")).toBe(true);
  writeFileSync(f.preflightPath, JSON.stringify(f.preflight));
  const [invalid, missing] = f.preflight.planned_requests;
  writeFileSync(cacheFilePath(cacheRoot, invalid!.key), "{}");
  unlinkSync(cacheFilePath(cacheRoot, missing!.key));
  const unavailable = await prepareSourcePublicationAssociations(f.population, f.preflightPath, join(cacheRoot, "unavailable.json"));
  expect(unavailable.publicationAssociations).toEqual([]);
  expect(unavailable.sources).toHaveLength(4);
  expect(new Set(unavailable.sources.map(row => row.reason))).toEqual(new Set(["invalid_current_artifact", "missing_current_artifact"]));
  expect(unavailable.artifacts).toEqual([{ key: invalid!.key, status: "invalid", sources: [] }]);
  expect(f.fetchMock).toHaveBeenCalledTimes(2);
}, 60000);

it("rejects duplicate or foreign retained request identity before writing associations", async () => {
  const f = await fixture();
  const line = f.preflight.planned_requests[0]!;
  for (const planned_requests of [[line, line], [{ ...line, requestSha256: "a".repeat(64) }]]) {
    writeFileSync(f.preflightPath, JSON.stringify({ planned_requests }));
    const out = join(cacheRoot, "rejected.json");
    await expect(prepareSourcePublicationAssociations(f.population, f.preflightPath, out)).rejects.toThrow("foreign or duplicate request identity");
    expect(existsSync(out)).toBe(false);
  }
  const config = join(cacheRoot, "invalid-window.json");
  writeFileSync(config, JSON.stringify({ ...f.population, questionWindow: { offset: -1, limit: 1 } }));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await runSemanticChainLauncher(["associate", "--config", config, "--preflight", f.preflightPath, "--out", join(cacheRoot, "bad.json")])).toBe(2);
  expect(existsSync(join(cacheRoot, "bad.json"))).toBe(false);
  writeFileSync(f.preflightPath, JSON.stringify(f.preflight));
  const duplicateBucket = join(cacheRoot, line.key.startsWith("ff") ? "ee" : "ff");
  mkdirSync(duplicateBucket, { recursive: true });
  writeFileSync(join(duplicateBucket, `${line.key}.json`), readFileSync(cacheFilePath(cacheRoot, line.key)));
  await expect(prepareSourcePublicationAssociations(f.population, f.preflightPath, join(cacheRoot, "duplicate-owner.json")))
    .rejects.toThrow("repeats an owning request key");
  expect(existsSync(join(cacheRoot, "duplicate-owner.json"))).toBe(false);
}, 60000);
