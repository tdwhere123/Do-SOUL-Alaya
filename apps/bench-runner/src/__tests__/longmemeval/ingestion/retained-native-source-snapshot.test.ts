import { copyFileSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { deriveAddressableSpanViews, fieldContractSha256 } from "@do-soul/alaya-core";
import { SoulInterpretationRequestSchema, SoulInterpretationResponseSchema, UNKNOWN_UTTERANCE_ATTRIBUTION } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest, sourceSemanticRequestCatalog } from "@do-soul/alaya-soul";
import { closeCachedDatabase, initDatabase, SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { admitRetainedNativeSourceSnapshot, nativeSourceSnapshotManifestPath, prepareNativeSourceRecordsSnapshot,
  readVerifiedNativeSourceSnapshot, sealNativeSourceRecordsSnapshotCopy } from "../../../runs/snapshot/source-records/native.js";
import { censusNativeSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { checkpointAndCopyBenchDb } from "../../../runs/snapshot/freeze/db-copy.js";
import { snapshotPublishLockPath } from "../../../runs/snapshot/freeze/publish-lock.js";
import { BENCH_DAEMON_DB_FILENAME, restoreSnapshotToDataDir } from "../../../runs/snapshot/materialize.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { prepareSourcePublicationAssociations } from "../../../runs/snapshot/source-records/prepare-associations.js";
import { publishSourceSemanticSnapshot, readNativeSourcePublicationReport } from "../../../runs/snapshot/source-records/publish.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, prepareSourceSemanticRequestLine,
  sourceSemanticArtifactPreparations } from "../../../runs/extraction/request-artifact.js";
import { setExtractionCredentialFixture } from "../extraction-fill/fixture.js";

const root = mkdtempSync(join(tmpdir(), "retained-native-source-"));
const retainedPath = join(root, "retained.sqlite"), workspaceId = "retained-source", runId = "publication-run";
const content = Array.from({ length: 95 }, (_, index) => `The assistant recorded source fact ${index + 1}.`).join("\n") + "\n";
const capturedContent = "User: The retained author chose a source format.\nAssistant: The author quoted another role label.\n";
const attribution = { contract: "utterance-attribution-v1" as const, status: "captured" as const,
  issuer_scope: "fixture-conversation", utterances: [{ occurrence_id: "retained-utterance",
    utf8_span: [0, Buffer.byteLength(capturedContent)] as const, conversation_ref: "fixture-conversation", author_ref: "fixture-author" }] };
const clock = "2026-09-25T00:00:00.000Z", candidate = "a".repeat(40);
const generation = { ...EXTRACTION_OPEN_SEMANTICS_GENERATION, generation_task: {
  contract: "source-semantic-generation-task-v1" as const, context: "complete_original_source" as const,
  original_query: "Which source format did the retained author choose?",
  responsibility: { kind: "original_query_task" as const, other_meaning: "unassessed" as const } } };
const budget = { schema_version: 1, work_units: 10_000_000, memory_bytes: 200_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 } as const;
let original: Buffer, expectedSha256: string;
let sequence = 0;
const path = (name: string) => join(root, `${++sequence}-${name}`);
const admission = (snapshotPath = path("admitted.sqlite"), sourcePath = retainedPath) =>
  admitRetainedNativeSourceSnapshot({ retainedPath: sourcePath, expectedSha256: hashRegularFileNoFollow(sourcePath),
    snapshotPath, workspaceId, runId, producerCommit: candidate });

beforeAll(async () => {
  const directory = join(root, "original-daemon");
  const daemon = await startBenchDaemon({ dataDirRoot: directory, workspaceId, runId: "original-run",
    embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  try {
    for (const [source_id, content_bytes, attribution_context] of [
      ["assistant-source", content, UNKNOWN_UTTERANCE_ATTRIBUTION],
      ["captured-source", capturedContent, attribution]
    ] as const) {
      await daemon.importSourceRecord({ source_id, source_version: "original", content_bytes,
        recorded_at: clock, event_time: null, valid_from: "2026-09-01T00:00:00.000Z", valid_to: null,
        speaker: "assistant", scope_class: "project", attribution_context,
        spans: deriveAddressableSpanViews(content_bytes) });
    }
    await daemon.checkpointFieldProjection();
  } finally { await daemon.shutdown(); }
  checkpointAndCopyBenchDb(join(directory, BENCH_DAEMON_DB_FILENAME), retainedPath);
  original = readFileSync(retainedPath); expectedSha256 = hashRegularFileNoFollow(retainedPath);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("copies and reopens exact retained records without inventing clocks, roles or attribution", async () => {
  const snapshotPath = path("sealed.sqlite");
  const sealed = await admission(snapshotPath);
  expect(sealed).toMatchObject({ contract: "native-source-records-snapshot-v2", producer_commit: candidate,
    workspace_id: workspaceId, run_id: runId, origin: { snapshot_path: retainedPath, db_sha256: expectedSha256 } });
  expect(sealed.sources.every(member => Object.keys(member).sort().join() === "content_sha256,record")).toBe(true);
  const reopened = readVerifiedNativeSourceSnapshot(snapshotPath);
  const source = reopened.records.find(row => row.source_id === "assistant-source")!;
  expect(source.content_bytes).toBe(content);
  expect(source).toMatchObject({ source_version: "original", source_observed_at: null, recorded_at: clock,
    record: { speaker: "assistant", event_time: null, valid_from: "2026-09-01T00:00:00.000Z", valid_to: null,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, scope_class: "project" } });
  const census = censusNativeSourceRecords({ population: "retained", snapshotPath });
  expect(census.records.find(row => row.source_id === "assistant-source")).toMatchObject({ speaker: "assistant",
    source_observed_at: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, units: expect.any(Array) });
  expect(census.records.find(row => row.source_id === "assistant-source")?.units).toHaveLength(95);
  expect(census.records.every(row => row.units.every(unit => unit.source_role === "assistant"))).toBe(true);
  expect(census.records.find(row => row.source_id === "captured-source")?.attribution_context).toEqual(attribution);
  const copied = path("published-copy.sqlite"); copyFileSync(snapshotPath, copied);
  expect(sealNativeSourceRecordsSnapshotCopy(snapshotPath, copied)).toMatchObject({
    contract: sealed.contract, sources: sealed.sources, origin: sealed.origin, producer_commit: candidate });
  expect(readFileSync(retainedPath)).toEqual(original);
  expect(["-wal", "-shm", "-journal"].some(suffix => existsSync(retainedPath + suffix))).toBe(false);
});

it("refuses a wrong original digest, workspace, overlap, existing output and original symlink", async () => {
  await expect(admitRetainedNativeSourceSnapshot({ retainedPath, expectedSha256: "0".repeat(64),
    snapshotPath: path("wrong-digest.sqlite"), workspaceId, runId, producerCommit: candidate })).rejects.toThrow(/SHA-256 mismatch/u);
  await expect(admitRetainedNativeSourceSnapshot({ retainedPath, expectedSha256,
    snapshotPath: path("wrong-workspace.sqlite"), workspaceId: "other", runId, producerCommit: candidate })).rejects.toThrow();
  await expect(admission(retainedPath)).rejects.toThrow(/overlaps/u);
  const existing = path("existing.sqlite"); writeFileSync(existing, "unsealed");
  await expect(admission(existing)).rejects.toThrow(/fresh unsealed/u);
  expect(readFileSync(existing, "utf8")).toBe("unsealed");
  const alias = path("original-alias.sqlite"); symlinkSync(retainedPath, alias);
  await expect(admitRetainedNativeSourceSnapshot({ retainedPath: alias, expectedSha256,
    snapshotPath: path("alias-copy.sqlite"), workspaceId, runId, producerCommit: candidate })).rejects.toThrow();
  expect(readFileSync(retainedPath)).toEqual(original);
});

it("checks the lock database path before creating any output", async () => {
  const output = path("lock-output.sqlite"), lock = snapshotPublishLockPath(output);
  copyFileSync(retainedPath, lock);
  const bytes = readFileSync(lock);
  await expect(admission(output, lock)).rejects.toThrow(/overlaps/u);
  expect(readFileSync(lock)).toEqual(bytes);
  expect(existsSync(output)).toBe(false);
  const aliasedOutput = path("hardlinked-lock-output.sqlite");
  linkSync(retainedPath, snapshotPublishLockPath(aliasedOutput));
  await expect(admission(aliasedOutput)).rejects.toThrow(/overlaps/u);
  expect(readFileSync(retainedPath)).toEqual(original);
  expect(["-wal", "-shm", "-journal"].some(suffix => existsSync(retainedPath + suffix))).toBe(false);
});

it.each(["-wal", "-journal"])("refuses an active %s without opening the original as SQLite", async suffix => {
  const source = path("active.sqlite"); copyFileSync(retainedPath, source);
  writeFileSync(source + suffix, "pending frames");
  const output = path("active-output.sqlite");
  await expect(admission(output, source)).rejects.toThrow();
  expect(readFileSync(source + suffix, "utf8")).toBe("pending frames");
  expect(existsSync(output)).toBe(false);
});

it.each(["database", "sidecar"])("refuses %s drift after copying without sealing the partial output", async kind => {
  const source = path("drifting.sqlite"); copyFileSync(retainedPath, source);
  const output = path("drifting-output.sqlite");
  const listPage = SqliteFieldSourceRecordRepo.prototype.listPageBounded;
  vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "listPageBounded").mockImplementationOnce(function (this: SqliteFieldSourceRecordRepo, options, cursor, bytes) {
    if (kind === "database") writeFileSync(source, "concurrent replacement");
    else writeFileSync(source + "-wal", "");
    return listPage.call(this, options, cursor, bytes);
  });
  await expect(admission(output, source)).rejects.toThrow(/changed during admission/u);
  expect(existsSync(output)).toBe(true);
  expect(existsSync(nativeSourceSnapshotManifestPath(output))).toBe(false);
});

it("preserves existing empty WAL and shared-memory sidecars without opening the original", async () => {
  const source = path("quiescent.sqlite"); copyFileSync(retainedPath, source);
  writeFileSync(source + "-wal", ""); writeFileSync(source + "-shm", Buffer.alloc(32768, 7));
  await admission(path("quiescent-output.sqlite"), source);
  expect(readFileSync(source)).toEqual(original);
  expect(readFileSync(source + "-wal")).toEqual(Buffer.alloc(0));
  expect(readFileSync(source + "-shm")).toEqual(Buffer.alloc(32768, 7));
});

it("refuses a population containing a retained noncurrent revision", async () => {
  const directory = path("revised-daemon");
  restoreSnapshotToDataDir({ snapshotDbPath: retainedPath, expectedSha256, dataDirRoot: directory });
  const daemon = await startBenchDaemon({ dataDirRoot: directory, workspaceId, runId,
    embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  try {
    await daemon.importSourceRecord({ source_id: "assistant-source", source_version: "later", content_bytes: "A later source revision.",
      recorded_at: "2026-09-26T00:00:00.000Z", event_time: null, valid_from: null, valid_to: null,
      speaker: "assistant", scope_class: "project", attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
      spans: deriveAddressableSpanViews("A later source revision.") });
    await daemon.checkpointFieldProjection();
  } finally { await daemon.shutdown(); }
  const source = path("revised.sqlite"), output = path("revised-output.sqlite");
  checkpointAndCopyBenchDb(join(directory, BENCH_DAEMON_DB_FILENAME), source);
  await expect(admission(output, source)).rejects.toThrow(/noncurrent record/u);
  expect(existsSync(nativeSourceSnapshotManifestPath(output))).toBe(false);
});

it.each([
  ["missing attribution", "UPDATE source_records SET attribution_context_json = NULL"],
  ["missing speaker", "UPDATE source_records SET speaker = NULL"],
  ["unsupported speaker", "UPDATE source_records SET speaker = 'system'"],
  ["unsupported scope", "UPDATE source_records SET scope_class = 'global_core'"],
  ["unavailable body", "UPDATE source_records SET source_body = NULL"],
  ["changed body", "UPDATE source_records SET source_body = 'changed'"],
  ["changed identity", "UPDATE source_records SET content_digest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"],
  ["oversized metadata", "UPDATE source_records SET source_id = replace(hex(zeroblob(10000)), '00', 'x')"]
])("leaves %s unsealed and preserves the retained database", async (_label, statement) => {
  const source = path("unavailable.sqlite"); copyFileSync(retainedPath, source);
  const db = initDatabase({ filename: source });
  try { db.connection.exec(statement); db.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
  finally { closeCachedDatabase(source); }
  const bytes = readFileSync(source), output = path("unsealed.sqlite");
  await expect(admission(output, source)).rejects.toThrow();
  expect(existsSync(nativeSourceSnapshotManifestPath(output))).toBe(false);
  expect(readFileSync(source)).toEqual(bytes);
  await expect(admission(output, source)).rejects.toThrow(/fresh unsealed/u);
});

it("rejects omitted, extra, duplicate or changed manifest members even with a recomputed seal", async () => {
  const output = path("tampered-seal.sqlite"), manifest = await admission(output);
  const file = nativeSourceSnapshotManifestPath(output);
  const cases = [manifest.sources.slice(0, 1), [...manifest.sources, manifest.sources[0]!],
    manifest.sources.map((member, index) => index === 0 ? { ...member, record: { ...member.record, speaker: "user" } } : member)];
  for (const sources of cases) {
    const { identity: _identity, ...originalBody } = manifest;
    const body = { ...originalBody, sources };
    writeFileSync(file, JSON.stringify({ ...body, identity: fieldContractSha256(JSON.stringify(body)) }));
    expect(() => readVerifiedNativeSourceSnapshot(output)).toThrow();
  }
});

it("preserves version 1 manifest bytes and default source request identities", async () => {
  const snapshotPath = path("v1.sqlite");
  const manifest = await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: path("v1-daemon"),
    workspaceId, runId, producerCommit: candidate, sources: [{ source_id: "v1", source_version: "1", title: "Legacy source",
      content_bytes: capturedContent, source_observed_at: clock, recorded_at: clock }] });
  const bytes = readFileSync(nativeSourceSnapshotManifestPath(snapshotPath));
  expect(manifest.contract).toBe("native-source-records-snapshot-v1");
  expect(Object.keys(manifest.sources[0]!)).toEqual(["source_id", "source_version", "title", "source_observed_at", "recorded_at", "record", "content_sha256"]);
  const [source] = censusNativeSourceRecords({ population: "legacy", snapshotPath }).records;
  const originalRequest = sourceSemanticArtifactPreparations(capturedContent, "complete-source", EXTRACTION_OPEN_SEMANTICS_GENERATION)[0]!;
  const currentRequest = sourceSemanticArtifactPreparations(source!.content_bytes, "complete-source", EXTRACTION_OPEN_SEMANTICS_GENERATION,
    source!.attribution_context, source!.source_role)[0]!;
  if (originalRequest.status !== "ready" || currentRequest.status !== "ready") throw new Error("ready legacy source required");
  const config = { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1" as const };
  expect(prepareSourceSemanticRequestLine(currentRequest.semantic, [], config))
    .toEqual(prepareSourceSemanticRequestLine(originalRequest.semantic, [], config));
  expect(currentRequest.semantic.source_request).not.toHaveProperty("source_role");
  expect(currentRequest.semantic.source_request.source_assertions.map(unit => unit.source_role)).toEqual(["user", "assistant"]);
  expect(readFileSync(nativeSourceSnapshotManifestPath(snapshotPath))).toEqual(bytes);
});

it("carries retained author and attribution through outgoing H, audited publication and public delivery", async () => {
  const snapshotPath = path("chain.sqlite"); await admission(snapshotPath);
  const sourceDirectory = path("source-preparation-daemon");
  restoreSnapshotToDataDir({ snapshotDbPath: snapshotPath, expectedSha256, dataDirRoot: sourceDirectory });
  const sourceDaemon = await startBenchDaemon({ dataDirRoot: sourceDirectory, workspaceId, runId,
    sourceSemanticInterpretationClock: clock, embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  let originalCatalog: ReturnType<typeof sourceSemanticRequestCatalog> | undefined;
  try {
    const source = SoulInterpretationResponseSchema.parse(await callMcpTool(sourceDaemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse({ operation: "prepare_source", source_id: "captured-source", budget,
        authorized_scopes: { mode: "named", scopes: ["project"] } })));
    if (source.operation !== "prepare_source") throw new Error("public source preparation required");
    originalCatalog = source.catalog;
    expect(source.catalog?.assertions.map(row => row.segments.map(segment => segment.text).join("")))
      .toEqual(["User: The retained author chose a source format.", "Assistant: The author quoted another role label."]);
  } finally { await sourceDaemon.shutdown(); }
  const cacheRoot = path("cache"); mkdirSync(cacheRoot);
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-3.1-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-3.1-low-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://generativelanguage.googleapis.com");
  const options = { variant: "native_source_snapshot" as const, nativeSourcePopulation: { name: "retained", snapshotPath },
    cacheRoot, sourcePacking: "complete-source" as const, openSemantics: generation };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample", revision: readCurrentExtractionAuthorityRevision() });
  const preflight = await preflightSourceSemanticInteractive({ ...options, preflightKeys: inspection.missingKeys,
    preflightOutputTokenCap: 16_384, geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
  expect(preflight.ready_requests).toHaveLength(2);
  const requests = preflight.ready_requests.map(row => parseSourceSemanticRequest(JSON.parse(row.userPrompt)));
  expect(requests.find(request => request.source_request.original_source === content)?.source_request.source_assertions).toHaveLength(95);
  expect(requests.find(request => request.source_request.original_source === capturedContent)?.source_request.attribution_context).toEqual(attribution);
  expect(requests.find(request => request.source_request.original_source === content)?.source_request.attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
  expect(requests.every(request => request.source_request.source_role === "assistant"
    && request.source_request.source_assertions.every(unit => unit.source_role === "assistant"))).toBe(true);
  expect(sourceSemanticRequestCatalog(requests.find(request => request.source_request.original_source === capturedContent)!)).toEqual(originalCatalog);
  const receipt = createExtractionAuthorityReceipt({ action: "sample", inspection, observation: inspection.observation,
    sampleScope: createExtractionSampleScope(inspection.missingKeys, inspection), sourcePreflight: preflight,
    maxConcurrency: 1, outputTokenCap: { field: "maxOutputTokens", value: 16_384 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5, maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const authorityReceiptPath = path("receipt.json"); writeExtractionAuthorityReceipt(authorityReceiptPath, receipt);
  setExtractionCredentialFixture();
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    const request = parseSourceSemanticRequest(JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text));
    expect(requests).toContainEqual(request);
    expect(request.source_request.source_assertions.every(unit => unit.source_role === "assistant")).toBe(true);
    const assertion = request.source_request.source_assertions[0]!;
    const response = JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" },
      content: { roots: [{ act: "assertion", expression: { kind: "content_ref", key: "statement" } }],
        entities: [{ form: "entity", key: "entity", semantic_key: "entity", mentions: [{ assertion_id: assertion.assertion_id, text: assertion.text }] }],
        nodes: [{ kind: "statement", key: "statement", predicate: { kind: "explicit", reading: "record",
          support: { assertion_id: assertion.assertion_id, text: assertion.text } },
          arguments: [{ role: "theme", target: { kind: "entity_ref", key: "entity" } }], qualifications: [] }], gaps: [] } });
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: response }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  expect((await runExtractionFill({ ...options, authorityReceiptPath, concurrency: 1 })).newlyExtracted).toBe(2);
  await runExtractionFill({ ...options, authorityReceiptPath, concurrency: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const retainedPreparationPath = path("preflight.json"); writeFileSync(retainedPreparationPath, JSON.stringify(preflight));
  const population = { name: "retained", nativeSnapshotPath: snapshotPath, model: "gemini-3.1-flash-lite",
    requestProfile: "gemini-3.1-low-v1" as const, openSemantics: generation };
  const associations = await prepareSourcePublicationAssociations(population, [{ cacheRoot, retainedPreparationPath }], path("associations.json"));
  expect(associations.sources.every(row => row.status === "associated")).toBe(true);
  const publishedPath = path("published.sqlite");
  const publication = await publishSourceSemanticSnapshot({ snapshotPath: publishedPath, dataDirRoot: path("publish-daemon"),
    recordedAt: clock, workspaceId, runId, producerCommit: candidate,
    descriptorExportSourceIds: ["assistant-source", "captured-source"],
    populations: [{ ...population, cacheRoots: [cacheRoot], publicationAssociations: associations.publicationAssociations }] });
  expect(publication.published_count).toBe(2);
  const report = readNativeSourcePublicationReport(publishedPath, snapshotPath);
  expect(report.sources.map(row => row.source_record)).toEqual(readVerifiedNativeSourceSnapshot(snapshotPath).records.map(row => row.record));
  expect(report.sources.every(row => row.correspondence_descriptor !== undefined)).toBe(true);
  for (const source of report.sources) {
    const expectedContent = source.source_id === "assistant-source" ? content : capturedContent;
    const line = preflight.ready_requests.find(row => parseSourceSemanticRequest(JSON.parse(row.userPrompt))
      .source_request.original_source === expectedContent)!;
    expect(source.source_interpretation_generation_key).toBe(line.key);
    expect(source.source_interpretation_binding).toEqual({ kind: "host_publication_association", request_digest: line.requestSha256 });
  }
  const directory = path("public-daemon");
  restoreSnapshotToDataDir({ snapshotDbPath: publishedPath, expectedSha256: publication.db_sha256, dataDirRoot: directory });
  const daemon = await startBenchDaemon({ dataDirRoot: directory, workspaceId, runId,
    sourceSemanticInterpretationClock: clock, embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  try {
    const delivered = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse({ operation: "prepare_source", source_id: "assistant-source", budget,
        authorized_scopes: { mode: "named", scopes: ["project"] } })));
    expect(delivered).toMatchObject({ operation: "prepare_source", source_id: "assistant-source",
      source_version: "original", attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, provider_attempts: 0 });
    if (delivered.operation !== "prepare_source") throw new Error("public source preparation required");
    expect(delivered.catalog?.assertions).toHaveLength(95);
    const quoted = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse({ operation: "prepare_source", source_id: "captured-source", budget,
        authorized_scopes: { mode: "named", scopes: ["project"] } })));
    if (quoted.operation !== "prepare_source") throw new Error("public source preparation required");
    expect(quoted.catalog).toEqual(originalCatalog);
    expect(quoted.attribution_context).toEqual(attribution);
    const prepared = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse({ operation: "prepare_query", original_query: generation.generation_task.original_query,
        source_handle: delivered.source_handle, budget, authorized_scopes: { mode: "named", scopes: ["project"] } })));
    expect(prepared).toMatchObject({ operation: "prepare_query", provider_attempts: 0 });
    if (prepared.operation !== "prepare_query") throw new Error("public query preparation required");
    expect(prepared.candidates.map(row => row.interpretation_id)).toContain(
      report.sources.find(row => row.source_id === "assistant-source")?.interpretation_id);
  } finally { await daemon.shutdown(); }
  const changed = { ...publication, sources: publication.sources.map((row, index) => index === 0
    ? { ...row, source_record: { ...row.source_record!, speaker: "user" } } : row) };
  writeFileSync(`${publishedPath}.publication.json`, JSON.stringify(changed));
  expect(() => readNativeSourcePublicationReport(publishedPath, snapshotPath)).toThrow(/retained metadata/u);
  expect(readFileSync(retainedPath)).toEqual(original);
});
