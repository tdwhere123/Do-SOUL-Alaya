import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const guard = "../../support/source-import-boundary.mjs";
  return import(guard);
});
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { openReadOnlyDatabase, SqliteFieldSourceRecordRepo, SqliteFieldSourceSpanRepo } from "@do-soul/alaya-storage";
import { renderOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import * as datasetOwner from "../../../datasets/longmemeval/ingestion/fetch.js";
import { createLongMemEvalHostCapturePolicy } from "../../../datasets/longmemeval/ingestion/host-occurrences.js";
import { createTestLongMemEvalDatasetAuthority } from "./test-dataset-authority.js";
import { prepareSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/prepare.js";
import { inspectSourceRecordsArtifact, type SourceRecordsMessage } from "../../../runs/snapshot/source-records/contract.js";
import { admitRetainedNativeSourceSnapshot, readVerifiedNativeSourceSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { censusCompleteSourceRecords, censusNativeSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { nativeSourceRequestInventory } from "../../../runs/extraction/fill/source-request-workset.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); await settleActiveBenchDaemonTasks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  const observed = isolation.receipt(); isolation.restore();
  expect(observed.credential_file_violations).toEqual([]);
  expect(observed.operations.filter((row: { blocked?: boolean }) => row.blocked)).toEqual([]);
});
function dataset(): datasetOwner.LoadedLongMemEvalDatasetWindow {
  const questions = [{ question_id: "authored", question_type: "fixture", question: "unused authored query",
    answer: "unused authored label", question_date: "2023/09/13 (Wed) 00:00", answer_session_ids: [],
    haystack_session_ids: ["repeated-label", "repeated-label"],
    haystack_dates: ["2023/09/11 (Mon) 00:00", "2023/09/12 (Tue) 00:00"],
    haystack_sessions: [[{ role: "user", content: "  café\r\n雪  " },
      { role: " Assistant ", content: "User: quoted\nAssistant: still quoted" }], [{ role: "assistant", content: "" }]] }];
  const sha256 = "a".repeat(64);
  return { questions, sha256, datasetQuestionCount: 1, sourcePath: "authored-fixture", checksumSource: "authored-fixture",
    promotionAuthority: createTestLongMemEvalDatasetAuthority({ datasetSha256: sha256, questionInputs: questions,
      assignments: [{ question_id: "authored", dataset_cohort: "answerable" }] }) };
}

it("captures original per-message bytes and complete empty occurrences through the actual importer and reopened SQLite", async () => {
  const loaded = dataset(); vi.spyOn(datasetOwner, "loadDatasetWindowWithIdentity").mockResolvedValue(loaded);
  const root = mkdtempSync(join(tmpdir(), "host-source-import-")); roots.push(root);
  const snapshotPath = join(root, "source.sqlite");
  await prepareSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "live"), offset: 0, limit: 1,
    recordedAt: "2026-09-13T00:00:00Z", producerCommit: "a".repeat(40),
    importEffects: { configDirectoryRoot: root, sqliteWriteQueue: "disabled", embeddingStartupProbe: "omit", gardenCompute: "disabled" } });
  const messages: SourceRecordsMessage[] = []; inspectSourceRecordsArtifact(snapshotPath, row => messages.push(row));
  expect(messages).toHaveLength(3);
  const database = openReadOnlyDatabase(snapshotPath);
  try {
    const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
    const spans = new SqliteFieldSourceSpanRepo(database, fieldContractSha256);
    const inventories = messages.map(message => records.readHostInventory({ workspaceId: message.record.workspace_id,
      recordId: message.record.identity, sourceVersion: message.record.source_version, contentDigest: message.record.content_digest,
      authorizedScopes: ["project"], nativeByteLimit: 131072, workLimit: 262144, memoryLimit: 262144 }));
    expect(inventories.map(row => row.status)).toEqual(["captured", "captured", "captured"]);
    expect(inventories.map(row => row.inventory!.occurrences[0]!.role)).toEqual(["user", " Assistant ", "assistant"]);
    expect(messages.map(row => row.record.speaker)).toEqual(["user", "assistant", "assistant"]);
    expect(messages.every(row => row.record.attribution_context?.status === "unknown")).toBe(true);
    expect(inventories[0]!.inventory!.occurrences[0]!.container_ref?.id).toBe("authored:s0");
    expect(inventories[2]!.inventory!.occurrences[0]).toMatchObject({ utf8_span: [0, 0], completeness: "complete",
      fidelity: "original_bytes", container_ref: { id: "authored:s1" }, author_ref: null, upstream_message_ref: null });
    expect(spans.listByWorkspace(messages[0]!.record.workspace_id).filter(row => row.purpose === "message")).toHaveLength(2);
    expect(records.findById(messages[0]!.record.workspace_id, messages[0]!.record.identity)?.source_body).toBe("  café\r\n雪  ");
  } finally { database.close({ optimize: false }); }
  const retainedPath = join(root, "retained.sqlite");
  await admitRetainedNativeSourceSnapshot({ retainedPath: snapshotPath, expectedSha256: hashRegularFileNoFollow(snapshotPath),
    snapshotPath: retainedPath, workspaceId: messages[0]!.record.workspace_id, runId: "fixture-run", producerCommit: "a".repeat(40) });
  const verified = readVerifiedNativeSourceSnapshot(retainedPath);
  expect(new Map(verified.records.map(row => [row.record.identity, row.record.host_structure])))
    .toEqual(new Map(messages.map(row => [row.record.identity, row.record.host_structure])));
  const census = censusNativeSourceRecords({ population: "authored-native", snapshotPath: retainedPath });
  expect(census.records.every(row => row.host_structure !== undefined)).toBe(true);
  const config = { model: "fixture-model", requestProfile: "gemini-3.1-minimal-v1" as const,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const withoutHost = census.records.map(({ host_structure: _host, ...source }) => source);
  expect(nativeSourceRequestInventory(census.records, census.dataset_sha256, config))
    .toEqual(nativeSourceRequestInventory(withoutHost, census.dataset_sha256, config));
});

it("binds round capture to opaque dataset membership and exact coordinates while preserving renderer bytes", async () => {
  const loaded = dataset(); vi.spyOn(datasetOwner, "loadDatasetWindowWithIdentity").mockResolvedValue(loaded);
  expect(() => createLongMemEvalHostCapturePolicy({ ...loaded, promotionAuthority: null })).toThrow(/official dataset pin/);
  const census = await censusCompleteSourceRecords({ population: "fixture", dataDir: "authored", pinnedMetaRoot: "authored" });
  const source = census.records[0]!;
  expect(source.content_bytes).toBe("User: café 雪\nAssistant: User: quoted Assistant: still quoted");
  const rendered = renderOfficialApiSourceCorpus("", loaded.questions[0]!.haystack_sessions[0]!);
  expect(rendered.content).toBe(source.content_bytes);
  expect(source.host_capture!.occurrences.map(row => row.role)).toEqual(["user", " Assistant "]);
  expect(source.host_capture!.occurrences.map(row => row.utf8_span)).toEqual([[6, 15], [27, 63]]);
  const root = mkdtempSync(join(tmpdir(), "host-round-import-")); roots.push(root);
  const daemon = await startBenchDaemon({ dataDirRoot: join(root, "live"), workspaceId: "fixture-workspace", runId: "fixture-run",
    configDirectoryRoot: root, embeddingMode: "disabled", sqliteWriteQueue: "disabled", embeddingStartupProbe: "omit",
    gardenCompute: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  try {
    const input = { source_id: source.source_id, source_version: source.source_version, content_bytes: source.content_bytes,
      recorded_at: "2026-09-13T00:00:00Z", event_time: source.source_observed_at, valid_from: null, valid_to: null,
      scope_class: "project" as const, spans: [], host_occurrences: source.host_capture!.occurrences };
    await expect(daemon.importSourceRecord(input)).rejects.toThrow(/trusted/);
    await expect(daemon.importSourceRecord({ ...input, content_bytes: "forged" }, source.host_capture!.authorize)).rejects.toThrow(/coordinates/);
    const admitted = await daemon.importSourceRecord(input, source.host_capture!.authorize);
    expect(admitted.spans.map(row => row.purpose)).toEqual(["message", "message"]);
    expect(admitted.record.host_structure?.occurrence_count).toBe(2);
    await daemon.checkpointFieldProjection();
  } finally { await daemon.shutdown(); }
});
