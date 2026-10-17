import { afterAll, afterEach, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  // Same preimport effect boundary as the existing real source-import lifecycle
  // fixture: no ambient credentials, network, model modules or unpinned workers.
  const guard = "../../support/source-import-boundary.mjs";
  return import(guard);
});

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { admitSourceSemanticQuery, deriveAddressableSpanViews, fieldContractSha256 } from "@do-soul/alaya-core";
import { encodeSourceSemanticQueryCarrier, hashContentDigest, sourceSemanticInterpretationIdentity,
  UNKNOWN_UTTERANCE_ATTRIBUTION, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema } from
  "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest, receiveSourceSemantics, proposeQuerySemantics,
  type SourceSemanticQueryRequest, type SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { openReadOnlyDatabase } from "@do-soul/alaya-storage";
import * as datasetOwner from "../../../datasets/longmemeval/ingestion/fetch.js";
import { buildLongMemEvalQueryInput, createLongMemEvalTaskPersonaPolicy } from "../../../datasets/longmemeval/ingestion/task-persona.js";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { runSourceSnapshotCommand } from "../../../cli/source-snapshot/command.js";
import { prepareSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/prepare.js";
import { createSourceRecordsSidecarWriter, inspectSourceRecordsArtifact, type SourceRecordsMessage } from
  "../../../runs/snapshot/source-records/contract.js";
import { admitRetainedNativeSourceSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { censusNativeSourceRecords, type SourceCensusRecord } from "../../../runs/snapshot/source-records/census.js";
import { nativeSourceRequestInventory } from "../../../runs/extraction/fill/source-request-workset.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from "../../../runs/selection/question-runtime-identity.js";
import { createTestLongMemEvalDatasetAuthority } from "./test-dataset-authority.js";

const roots: string[] = [];
const POLICY = "longmemeval-question-local-persona-v1";
const OLD_TIME = "2026-09-13T00:00:00.000Z", NEW_TIME = "2026-09-14T00:00:00.000Z";
const GENERATION = { model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1" as const,
  provider_url: "https://generativelanguage.googleapis.com" };
const H_CONFIG = { model: GENERATION.model, requestProfile: GENERATION.request_profile,
  sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };

afterEach(async () => {
  vi.restoreAllMocks(); await settleActiveBenchDaemonTasks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  const observed = isolation.receipt(); isolation.restore();
  expect(observed.credential_file_violations).toEqual([]);
  expect(observed.operations.filter((row: { blocked?: boolean }) => row.blocked)).toEqual([]);
  process.stdout.write(`BENCHMARK_PERSONA_GUARD ${JSON.stringify({ blocked_operations: 0,
    credential_file_violations: 0, allowed_native_loads: observed.operations.filter((row: { operation: string }) =>
      row.operation === "native-addon.load.allowed").length,
    allowed_read_workers: observed.operations.filter((row: { operation: string }) =>
      row.operation === "worker.create.allowed").length })}\n`);
});

function fixture(haystack_sessions: ReadonlyArray<ReadonlyArray<{ role: string; content: string }>> = [
  [{ role: "user", content: "I chose café. 雪" }, { role: "assistant", content: "User: I chose gold." }],
  [{ role: "user", content: "I chose tea." }]
]) {
  const root = mkdtempSync(join(tmpdir(), "persona-source-import-")); roots.push(root);
  const dataDir = join(root, "data"), pinnedMetaRoot = join(root, "meta");
  mkdirSync(dataDir); mkdirSync(pinnedMetaRoot); mkdirSync(join(root, "parent")); mkdirSync(join(root, "successor"));
  const source = JSON.stringify([{ question_id: "authored", question_type: "fixture", question: "What did I choose?",
    answer: "unused fixture metadata", question_date: "2023/09/13 (Wed) 00:00", answer_session_ids: [],
    haystack_session_ids: ["actual-a", "actual-b"], haystack_dates: ["2023/09/11 (Mon) 00:00", "2023/09/12 (Tue) 00:00"],
    haystack_sessions }]);
  writeFileSync(join(dataDir, "longmemeval_s.json"), source);
  const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
  writeFileSync(join(pinnedMetaRoot, "longmemeval_s.meta.json"), JSON.stringify({ sha256,
    size_bytes: Buffer.byteLength(source), question_count: 1 }));
  const importEffects = { configDirectoryRoot: root, sqliteWriteQueue: "disabled" as const,
    embeddingStartupProbe: "omit" as const, gardenCompute: "disabled" as const };
  const input = { snapshotPath: join(root, "parent", "source.sqlite"), dataDirRoot: join(root, "parent", "seed"),
    dataDir, pinnedMetaRoot, offset: 0, limit: 1, recordedAt: OLD_TIME, producerCommit: "a".repeat(40), importEffects };
  const successor = { ...input, snapshotPath: join(root, "successor", "source.sqlite"),
    dataDirRoot: join(root, "successor", "seed"), recordedAt: NEW_TIME,
    personaSuccessor: { policy: POLICY, parentSnapshotPath: input.snapshotPath } };
  return { root, sha256, input, successor };
}

/** Only the dataset's existing test capability is substituted. File parsing,
 * checksum validation, source admission/audit, SQLite, census and request owners are real. */
function authorizeFixtureDataset() {
  const load = datasetOwner.loadDatasetWindowWithIdentity;
  vi.spyOn(datasetOwner, "loadDatasetWindowWithIdentity").mockImplementation(async (...args) => {
    const loaded = await load(...args);
    return { ...loaded, promotionAuthority: createTestLongMemEvalDatasetAuthority({ datasetSha256: loaded.sha256, questionInputs: loaded.questions,
      assignments: loaded.questions.map(q => ({ question_id: q.question_id, dataset_cohort: "answerable" })) }) };
  });
}

function messages(path: string) {
  const rows: SourceRecordsMessage[] = [];
  const artifact = inspectSourceRecordsArtifact(path, row => rows.push(row));
  return { ...artifact, rows };
}

it("imports a complete fresh successor, retains parent mapping and carries bounded context through native H/Q requests to C endpoints", async () => {
  const f = fixture(), parent = await prepareSourceRecordsSnapshot(f.input);
  const original = messages(f.input.snapshotPath);
  expect(original.rows).toHaveLength(3);
  expect(original.rows.every(row => row.record.attribution_context?.status === "unknown")).toBe(true);
  await expect(prepareSourceRecordsSnapshot(f.successor)).rejects.toThrow(/official dataset pin/);
  expect(existsSync(f.successor.dataDirRoot)).toBe(false);
  authorizeFixtureDataset();
  const next = await prepareSourceRecordsSnapshot(f.successor), corrected = messages(f.successor.snapshotPath);
  expect(await prepareSourceRecordsSnapshot(f.successor)).toEqual(next);
  expect(next.persona_successor).toMatchObject({ policy: POLICY, parent_manifest_sha256: parent.manifest_sha256 });
  expect(corrected.rows).toHaveLength(original.rows.length);
  expect(corrected.sidecar.questions).toEqual(original.sidecar.questions);
  expect(corrected.sidecar.questions[0]!.interpretation_clock).toBe("2023-09-13T00:00:00.000Z");
  for (const [index, row] of corrected.rows.entries()) {
    const old = original.rows[index]!;
    expect(row.predecessor).toEqual(old.record);
    expect(row.record.content_digest).toBe(old.record.content_digest);
    expect(row.record.identity).not.toBe(old.record.identity);
    expect(row.record.source_version).not.toBe(f.sha256);
    expect(row.record.recorded_at).toBe(NEW_TIME);
    expect(row.record.event_time).toBeNull();
    expect(row.record.valid_from).toBeNull(); expect(row.record.valid_to).toBeNull();
    expect(row).toMatchObject({ session_id: old.session_id, session_index: old.session_index,
      message_index: old.message_index, source_observed_at: old.source_observed_at });
  }
  const identity = buildLongMemEvalQuestionRuntimeIdentity("authored"), nativePath = join(f.root, "native.sqlite");
  await admitRetainedNativeSourceSnapshot({ retainedPath: f.successor.snapshotPath, expectedSha256: next.db_sha256,
    snapshotPath: nativePath, ...{ workspaceId: identity.workspaceId, runId: identity.runId }, producerCommit: f.input.producerCommit });
  const census = censusNativeSourceRecords({ population: "authored-persona", snapshotPath: nativePath });
  expect(census.records).toHaveLength(3); // Seal and census the whole DB, not a selected-source fiction.
  expect(census.records.map(row => row.content_bytes).sort()).toEqual(["I chose café. 雪", "I chose tea.", "User: I chose gold."].sort());
  const inventory = nativeSourceRequestInventory(census.records, census.dataset_sha256, H_CONFIG);
  expect(inventory.unsupportedSources).toEqual([]); expect(inventory.requests).toHaveLength(3);
  const source = census.records.find(row => row.content_bytes === "I chose café. 雪")!;
  assertCorrespondenceProjection(source, inventory.requests.find(row => row.sourceCorpus === source.content_bytes)!.line.userPrompt,
    buildLongMemEvalQueryInput((await datasetOwner.loadDatasetWindowWithIdentity("longmemeval_s", {
      dataDir: f.input.dataDir, pinnedMetaRoot: f.input.pinnedMetaRoot, offset: 0, limit: 1 })).questions[0]!, {
      persona: createLongMemEvalTaskPersonaPolicy(await datasetOwner.loadDatasetWindowWithIdentity("longmemeval_s", {
        dataDir: f.input.dataDir, pinnedMetaRoot: f.input.pinnedMetaRoot, offset: 0, limit: 1 })) }));
  const unknownInventory = nativeSourceRequestInventory(census.records.map(row => ({ ...row,
    attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION })), census.dataset_sha256, H_CONFIG);
  expect(new Set(inventory.requests.map(row => row.line.key)))
    .not.toEqual(new Set(unknownInventory.requests.map(row => row.line.key)));
  const db = openReadOnlyDatabase(f.successor.snapshotPath);
  try {
    expect(db.connection.prepare("SELECT count(*) AS n FROM source_records").get()).toEqual({ n: 3 });
    expect(db.connection.prepare("SELECT count(*) AS n FROM event_log WHERE entity_type='source_record'").get()).toEqual({ n: 3 });
    for (const table of ["memory_entries", "evidence_capsules", "garden_tasks"]) {
      expect(db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  } finally { db.close(); }
  expect(hashRegularFileNoFollow(f.input.snapshotPath)).toBe(parent.db_sha256);
  expect(messages(f.input.snapshotPath)).toEqual(original);
  await assertCurrentDiscoveryAtOriginalClock(f, corrected.rows);
}, 120000);

it("seals empty user and assistant originals as unknown while capturing nonempty users", async () => {
  const f = fixture([[{ role: "user", content: "" }, { role: "assistant", content: "" }],
    [{ role: "user", content: "I chose café. 雪" }]]);
  const parent = await prepareSourceRecordsSnapshot(f.input);
  const original = messages(f.input.snapshotPath);
  expect(original.rows).toHaveLength(3);
  expect(original.rows.map(row => row.content_state)).toEqual(["empty", "empty", "retained"]);
  expect(original.rows.every(row => row.record.attribution_context?.status === "unknown")).toBe(true);
  authorizeFixtureDataset();
  const next = await prepareSourceRecordsSnapshot(f.successor), corrected = messages(f.successor.snapshotPath);
  expect(corrected.rows).toHaveLength(original.rows.length);
  expect(next.message_count).toBe(3);
  const emptyDigest = hashContentDigest("", fieldContractSha256);
  const parentBodies = sourceBodies(f.input.snapshotPath);
  const successorBodies = sourceBodies(f.successor.snapshotPath);
  expect(parentBodies).toEqual(["", "", "I chose café. 雪"]);
  expect(successorBodies).toEqual(parentBodies);
  for (const [index, row] of corrected.rows.entries()) {
    const old = original.rows[index]!;
    expect(row.predecessor).toEqual(old.record);
    expect(row.record.content_digest).toBe(old.record.content_digest);
    expect(row.record.identity).not.toBe(old.record.identity);
    expect(row.record.source_version).not.toBe(f.sha256);
    expect(row.record.recorded_at).toBe(NEW_TIME);
    expect(row).toMatchObject({ session_id: old.session_id, session_index: old.session_index,
      message_index: old.message_index, source_observed_at: old.source_observed_at, role: old.role,
      content_state: old.content_state });
  }
  const [emptyUser, emptyAssistant, capturedUser] = corrected.rows;
  expect(emptyUser).toMatchObject({ role: "user", content_state: "empty", spans: [] });
  expect(emptyAssistant).toMatchObject({ role: "assistant", content_state: "empty", spans: [] });
  expect(emptyUser!.record.attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
  expect(emptyAssistant!.record.attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
  expect(emptyUser!.record.content_digest).toBe(emptyDigest);
  expect(emptyAssistant!.record.content_digest).toBe(emptyDigest);
  expect(capturedUser).toMatchObject({ role: "user", content_state: "retained" });
  expect(capturedUser!.record.attribution_context).toMatchObject({ status: "captured",
    utterances: [{ author_ref: "task-presented-user", utf8_span: [0, 18] }] });
  expect(capturedUser!.record.content_digest).not.toBe(emptyDigest);
  expect(hashRegularFileNoFollow(f.input.snapshotPath)).toBe(parent.db_sha256);
  expect(messages(f.input.snapshotPath)).toEqual(original);
  const { shards: _shards, message_count: _count, ...header } = corrected.sidecar;
  const writer = createSourceRecordsSidecarWriter(f.successor.snapshotPath, header);
  expect(() => writer.append({ ...capturedUser!,
    record: { ...capturedUser!.record, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION } }))
    .toThrow(/predecessor binding mismatch/);
  expect(() => writer.append({ ...capturedUser!, content_state: "empty", spans: [],
    record: { ...capturedUser!.record, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION } }))
    .toThrow(/binding mismatch/);
}, 120000);

function sourceBodies(path: string): string[] {
  const db = openReadOnlyDatabase(path);
  try {
    const byId = new Map((db.connection.prepare("SELECT record_id, source_body FROM source_records").all() as
      { record_id: string; source_body: string }[]).map(row => [row.record_id, row.source_body]));
    return messages(path).rows.map(row => {
      if (!byId.has(row.record.identity)) throw new Error("source body missing for sealed identity");
      return byId.get(row.record.identity)!;
    });
  } finally { db.close(); }
}

async function assertCurrentDiscoveryAtOriginalClock(f: ReturnType<typeof fixture>, rows: readonly SourceRecordsMessage[]) {
  const interpretationClock = "2023-09-13T00:00:00.000Z";
  const daemon = await startBenchDaemon({ ...f.input.importEffects, dataDirRoot: f.successor.dataDirRoot,
    ...buildLongMemEvalQuestionRuntimeIdentity("authored"), embeddingMode: "disabled",
    sourceSemanticInterpretationClock: interpretationClock, fieldProjectionAdmissionMode: "explicit_checkpoint" });
  try {
    const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse({ operation: "prepare_query", original_query: "What did I choose?",
        budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 200_000_000, page_budget: 100_000,
          finalization_reserve: 10_000, min_envelope: 10 }, authorized_scopes: { mode: "unrestricted" }, access_policy: "canonical-v1" })));
    if (response.operation !== "prepare_query") throw new Error("unexpected discovery operation");
    expect(response.access?.observed_source_count).toBe(3);
    expect(new Set(response.access?.source_candidates.map(row => row.record_id)))
      .toEqual(new Set(rows.map(row => row.record.identity)));
    // This is current-snapshot access under the unchanged interpretation clock,
    // not a claim that newly captured metadata existed on that historical date.
  } finally { await daemon.shutdown(); }
}

function assertCorrespondenceProjection(source: SourceCensusRecord, userPrompt: string,
  item: ReturnType<typeof buildLongMemEvalQueryInput>) {
  const hRequest = parseSourceSemanticRequest(JSON.parse(userPrompt));
  expect(hRequest.source_request.attribution_context).toEqual(source.attribution_context);
  expect(hRequest.source_request.attribution_context).toMatchObject({ status: "captured",
    utterances: [{ conversation_ref: "session:0:actual-a", author_ref: "task-presented-user", utf8_span: [0, 18] }] });
  const h = receiveSourceSemantics(JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" },
    content: { roots: [{ act: "assertion", expression: { kind: "content_ref", key: "choice" } }],
      entities: [{ form: "entity", key: "speaker", semantic_key: "speaker", mentions: [{ assertion_id: 1, text: "I" }] },
        { form: "selection", key: "chosen", selection: { assertion_id: 1, text: "café" } }],
      nodes: [{ kind: "statement", key: "choice", predicate: { kind: "explicit", reading: "choose", support: { assertion_id: 1, text: "chose" } },
        arguments: [{ role: "agent", target: { kind: "entity_ref", key: "speaker" } },
          { role: "theme", target: { kind: "entity_ref", key: "chosen" } }], qualifications: [] }], gaps: [] } }), hRequest, {
    sourceCorpus: source.content_bytes, source_id: source.source_id, source_version: source.source_version,
    sourceRole: source.source_role, sourceScope: "complete-source", attribution_context: source.attribution_context,
    assertionIds: hRequest.source_request.source_assertions.map(row => row.assertion_id),
    ...hRequest.source_request.producer_capability
  });
  expect(h.outcome.status).toBe("interpreted");
  if (h.interpretation === undefined) throw new Error(JSON.stringify(h.outcome));
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query", ...GENERATION, items: [item] });
  const qLine = materializeSemanticProposalLines(workset, 4096)[0]!, qRequest = qLine.request as SourceSemanticQueryRequest;
  const unknown = materializeSemanticProposalLines({ ...workset, items: [{ original_query: item.original_query }] }, 4096)[0]!;
  expect(qLine.key).not.toBe(unknown.key); expect(qLine.requestDigest).not.toBe(unknown.requestDigest);
  for (const changed of [{ ...item, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    { original_query: item.original_query, attribution_context: item.attribution_context },
    { ...item, approved_fixed_context: { ...item.approved_fixed_context!, context_id: "different-approved-context" } }]) {
    const line = materializeSemanticProposalLines({ ...workset, items: [changed] }, 4096)[0]!;
    expect(line.key).not.toBe(qLine.key); expect(line.requestDigest).not.toBe(qLine.requestDigest);
  }
  const proposed = proposeQuerySemantics({ ...item, ...qRequest.producer_capability }, { rawJson: JSON.stringify({
    contract: "source-semantic-query-response-v8", outcome: { status: "interpreted", gaps: [] },
    query: encodeSourceSemanticQueryCarrier({ contract: "source-semantic-query-meaning-v5", gaps: [], alternatives: [{ conditions: [{
      kind: "statement", key: "choice", predicate: "choose", arguments: [
        { role: "agent", target: { kind: "named", key: "speaker", excerpt: "I" }, excerpt: "I" },
        { role: "theme", target: { kind: "free", key: "chosen", return: true }, excerpt: "What" }
      ] }] }] }) }) });
  const admitted = admitSourceSemanticQuery(proposed.query, item.original_query);
  expect(admitted.kind).toBe("admitted");
  if (admitted.kind !== "admitted") throw new Error("authored query was not admitted");
  const c = materializeSemanticProposalLines(parseSemanticProposalWorkset({ ...workset, kind: "semantic_correspondence", items: [{
    original_query: item.original_query, admitted_query_semantics: admitted.query,
    source_interpretation_descriptors: [{ source_interpretation_id: sourceSemanticInterpretationIdentity(h.interpretation, fieldContractSha256),
      interpretation: h.interpretation }] }] }), 4096)[0]!.request as SourceSemanticCorrespondenceRequest;
  expect(c.admitted_query_semantics.approved_fixed_context).toEqual(item.approved_fixed_context);
  expect(c.admitted_query_semantics.approved_fixed_context?.notes).toContain("including distinct sessions");
  expect(c.admitted_query_semantics.approved_fixed_context?.notes).toContain("not authenticated common authorship");
  expect(c.admitted_query_semantics.approved_fixed_context?.notes).toContain("Each C correspondence still needs independent source-grounded justification");
  expect(c.endpoint_evidence.query_endpoints.find(row => row.kind === "referent")).toMatchObject({
    attribution_context: item.attribution_context, reference: { excerpt: "I" } });
  expect(c.endpoint_evidence.source_endpoints.find(row => row.kind === "referent")).toMatchObject({
    source_context: { attribution_context: source.attribution_context } });
  // This checks actual receive/admission and C input projection, not a fabricated
  // C acceptance, model fidelity, world identity or conditional proof result.
}

it("rejects nonlater successors and same-version metadata rebinding through the source admission owner", async () => {
  const f = fixture(); await prepareSourceRecordsSnapshot(f.input); authorizeFixtureDataset();
  for (const recordedAt of [OLD_TIME, "2026-09-12T00:00:00.000Z"]) {
    await expect(prepareSourceRecordsSnapshot({ ...f.successor, recordedAt })).rejects.toThrow(/later recorded_at/);
  }
  await expect(prepareSourceRecordsSnapshot({ ...f.successor, snapshotPath: join(f.root, "parent", "changed.sqlite") })).rejects.toThrow(/outside/);
  const dataset = await datasetOwner.loadDatasetWindowWithIdentity("longmemeval_s", { dataDir: f.input.dataDir,
    pinnedMetaRoot: f.input.pinnedMetaRoot, offset: 0, limit: 1 });
  const persona = createLongMemEvalTaskPersonaPolicy(dataset), old = messages(f.input.snapshotPath).rows[0]!;
  const identity = buildLongMemEvalQuestionRuntimeIdentity("authored");
  const daemon = await startBenchDaemon({ ...f.input.importEffects, dataDirRoot: f.input.dataDirRoot,
    ...identity, embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  try {
    await expect(daemon.importSourceRecord({ source_id: old.message_id, source_version: old.record.source_version,
      content_bytes: "I chose café. 雪", recorded_at: OLD_TIME, event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews("I chose café. 雪"),
      attribution_context: persona.source({ questionId: "authored", sessionIndex: 0, messageIndex: 0,
        role: "user", content: "I chose café. 雪" }) })).rejects.toThrow("source record identity collision.");
  } finally { await daemon.shutdown(); }
}, 120000);

it("prepares query items through the CLI and rejects unsupported or missing explicit policy inputs", async () => {
  const f = fixture(); authorizeFixtureDataset();
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const base = ["query-input", "--data-dir", f.input.dataDir, "--pinned-meta-root", f.input.pinnedMetaRoot,
    "--question-id", "authored"];
  expect(await runSourceSnapshotCommand(base)).toBe(0);
  expect(JSON.parse(String(stdout.mock.calls.at(-1)![0]))).toMatchObject({ attribution_context: { status: "unknown" } });
  expect(await runSourceSnapshotCommand([...base, "--attribution-policy", POLICY])).toBe(0);
  expect(JSON.parse(String(stdout.mock.calls.at(-1)![0]))).toMatchObject({ attribution_context: { status: "captured" },
    approved_fixed_context: { notes: expect.stringContaining("not authenticated common authorship") } });
  expect(await runSourceSnapshotCommand([...base, "--attribution-policy", "unsupported"])).toBe(2);
  expect(await runSourceSnapshotCommand(["prepare", "--parent-snapshot", "absent"])).toBe(2);
  expect(stderr).toHaveBeenCalled();
});
