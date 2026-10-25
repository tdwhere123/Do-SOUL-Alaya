import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => { const guard = "../../support/source-import-boundary.mjs"; return import(guard); });
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { openReadOnlyDatabase, SqliteFieldSourceRecordRepo, SqliteFieldSourceSpanRepo } from "@do-soul/alaya-storage";
import * as datasetOwner from "../../../datasets/longmemeval/ingestion/fetch.js";
import * as daemonOwner from "../../../harness/daemon.js";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { assertLongMemEvalRoundSourceRevision, createLongMemEvalRoundProjection } from "../../../runs/snapshot/source-records/round-projection.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { createTestLongMemEvalDatasetAuthority } from "./test-dataset-authority.js";

const roots: string[] = [];
const evidence = process.env.SOURCE_PUBLICATION_TEST_ROOT;
afterEach(async () => {
  vi.restoreAllMocks(); await settleActiveBenchDaemonTasks();
  if (evidence === undefined) for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  const receipt = isolation.receipt(); isolation.restore();
  expect(receipt.credential_file_violations).toEqual([]);
  expect(receipt.operations.filter((row: { blocked?: boolean }) => row.blocked)).toEqual([]);
  if (evidence !== undefined) writeFileSync(join(evidence, "guard-receipt.json"), JSON.stringify(receipt, null, 2));
});
function fixture() {
  const questions = [{ question_id: "authored-round", question_type: "single-session-user", question: "An unused authored query",
    answer: "unused authored label", question_date: "2023/09/13 (Wed) 00:00", answer_session_ids: [],
    haystack_session_ids: ["repeated-label", "repeated-label"], haystack_dates: ["2023/09/11 (Mon) 00:00", "2023/09/12 (Tue) 00:00"],
    haystack_sessions: [[{ role: "user", content: "  café\r\n雪  " }, { role: " Assistant ", content: "User: quoted\nAssistant: still quoted" }],
      [{ role: "assistant", content: "Another retained message." }]] }];
  const sha256 = "a".repeat(64);
  const loaded: datasetOwner.LoadedLongMemEvalDatasetWindow = { questions, sha256, datasetQuestionCount: 1,
    sourcePath: "authored-fixture", checksumSource: "authored-fixture", promotionAuthority: createTestLongMemEvalDatasetAuthority({
      datasetSha256: sha256, questionInputs: questions, assignments: [{ question_id: "authored-round", dataset_cohort: "answerable" }] }) };
  if (evidence !== undefined) mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence ?? tmpdir(), "round-publication-")); roots.push(root);
  const population = { name: "longmemeval_s", dataDir: root, pinnedMetaRoot: root, questionWindow: { offset: 0, limit: 1 },
    model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1" as const, cacheRoots: [] };
  const publish = (name: string, recordedAt: string, sourceLimits?: { maxSources: number; maxContentBytes: number }) =>
    publishSourceSemanticSnapshot({ snapshotPath: join(root, `${name}.sqlite`), dataDirRoot: join(root, name),
      workspaceId: "authored-round-workspace", runId: "authored-round-run", populations: [population],
      producerCommit: "a".repeat(40), recordedAt,
      importEffects: { configDirectoryRoot: root, sqliteWriteQueue: "disabled", embeddingStartupProbe: "omit", gardenCompute: "disabled" }, ...(sourceLimits === undefined ? {} : { sourceLimits }) });
  return { root, loaded, population, publish };
}

it("publishes fresh structured round revisions through actual Core admission and sealed SQLite without altering legacy facts", async () => {
  const f = fixture(), loader = vi.spyOn(datasetOwner, "loadDatasetWindowWithIdentity");
  loader.mockResolvedValue({ ...f.loaded, promotionAuthority: null });
  const legacy = await f.publish("legacy", "2026-09-13T00:00:00.000Z");
  const legacyDigest = hashRegularFileNoFollow(legacy.snapshot_path);
  loader.mockResolvedValue(f.loaded);
  const census = await censusCompleteSourceRecords({ population: f.population.name, dataDir: f.root, pinnedMetaRoot: f.root });
  const report = await f.publish("structured", "2026-09-14T00:00:00.000Z", { maxSources: 2,
    maxContentBytes: census.records.reduce((n, row) => n + Buffer.byteLength(row.content_bytes, "utf8"), 0) });
  expect(report).toMatchObject({ census_count: 2, admitted_count: 2, rejected_count: 0, published_count: 0 });
  expect(hashRegularFileNoFollow(report.snapshot_path)).toBe(report.db_sha256);
  expect(hashRegularFileNoFollow(legacy.snapshot_path)).toBe(legacyDigest);
  const db = openReadOnlyDatabase(report.snapshot_path);
  try {
    const records = new SqliteFieldSourceRecordRepo(db, fieldContractSha256), spans = new SqliteFieldSourceSpanRepo(db, fieldContractSha256);
    for (const [index, source] of report.sources.entries()) {
      const old = legacy.sources[index]!;
      expect(source.source_version).toBe(`bench-round-host-v1:${"a".repeat(64)}`);
      expect(old.source_version).toBe("a".repeat(64));
      expect(source.record_id).not.toBe(old.record_id);
      for (const key of ["source_id", "content_digest", "corpus_digest", "speaker", "roles", "question_id", "session_id", "session_index", "round_index"] as const)
        expect(source[key]).toEqual(old[key]);
      const current = source.source_record!, prior = old.source_record!;
      for (const key of ["workspace_id", "event_time", "valid_from", "valid_to", "speaker", "scope_class", "attribution_context"] as const)
        expect(current[key]).toEqual(prior[key]);
      expect(prior.host_structure).toBeUndefined();
      assertLongMemEvalRoundSourceRevision({ datasetSha256: f.loaded.sha256, sourceVersion: source.source_version, hostCaptured: true });
      expect(records.findById(report.workspace_id, source.record_id!)?.source_body).toBe(census.records[index]!.content_bytes);
      const inventory = records.readHostInventory({ workspaceId: report.workspace_id, recordId: source.record_id!, sourceVersion: source.source_version,
        contentDigest: source.content_digest, authorizedScopes: ["project"], nativeByteLimit: 131072, workLimit: 262144, memoryLimit: 262144 });
      expect(inventory.status).toBe("captured");
      if (index === 0) {
        expect(records.findById(report.workspace_id, source.record_id!)?.source_body).toBe("User: café 雪\nAssistant: User: quoted Assistant: still quoted");
        expect(inventory.inventory!.occurrences.map(row => row.role)).toEqual(["user", " Assistant "]);
        expect(inventory.inventory!.occurrences.map(row => row.utf8_span)).toEqual([[6, 15], [27, 63]]);
        expect(inventory.inventory!.occurrences.map(row => row.upstream_position)).toEqual([0, 1]);
        expect(inventory.inventory!.occurrences.every(row => row.author_ref === null && row.channel === null && row.upstream_message_ref === null)).toBe(true);
      }
    }
    expect(spans.listByWorkspace(report.workspace_id).filter(row => row.purpose === "message")).toHaveLength(3);
  } finally { db.close({ optimize: false }); }
  if (evidence !== undefined) console.log(`Authored structured publication: ${report.snapshot_path}.publication.json`);
});

it("refuses source/byte overruns before daemon startup and never grants custom pins host authority", async () => {
  const f = fixture(); vi.spyOn(datasetOwner, "loadDatasetWindowWithIdentity").mockResolvedValue(f.loaded);
  const start = vi.spyOn(daemonOwner, "startBenchDaemon");
  for (const sourceLimits of [{ maxSources: 1, maxContentBytes: 10000 }, { maxSources: 2, maxContentBytes: 1 }])
    await expect(f.publish("bounded", "2026-09-14T00:00:00.000Z", sourceLimits)).rejects.toThrow(/source\/byte limits/);
  expect(start).not.toHaveBeenCalled(); expect(existsSync(join(f.root, "bounded.sqlite"))).toBe(false);
  const unknown = createLongMemEvalRoundProjection({ ...f.loaded, promotionAuthority: null });
  expect(unknown.sourceVersion).toBe(f.loaded.sha256); expect(unknown.capture).toBeUndefined();
  const captured = createLongMemEvalRoundProjection(f.loaded).capture!({ questionId: "authored-round", sessionIndex: 0, roundIndex: 0,
    sourceId: "longmemeval_s:authored-round-s0-r0" });
  expect(() => captured.authorize({ workspace_id: "authored-round-workspace", source_id: "longmemeval_s:authored-round-s0-r0",
    source_version: f.loaded.sha256, content_bytes: "User: café 雪\nAssistant: User: quoted Assistant: still quoted",
    host_occurrences: captured.occurrences } as Parameters<typeof captured.authorize>[0])).toThrow(/coordinates/);
  expect(() => assertLongMemEvalRoundSourceRevision({ datasetSha256: f.loaded.sha256, sourceVersion: f.loaded.sha256, hostCaptured: true })).toThrow(/projection/);
});
