import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => { const guard = "../../support/source-import-boundary.mjs"; return import(guard); });
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { HOST_SESSION_CONTRACT, hostSessionContainerKey, hostSessionRoundSourceId } from "@do-soul/alaya-protocol";
import { renderOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import { openReadOnlyDatabase, SqliteFieldSourceRecordRepo, SqliteFieldSourceSpanRepo } from "@do-soul/alaya-storage";
import * as datasetOwner from "../../../datasets/longmemeval/ingestion/fetch.js";
import { longMemEvalSessionContainer } from "../../../datasets/longmemeval/ingestion/host-session-import.js";
import * as daemonOwner from "../../../harness/daemon.js";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
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

function readRoots(snapshotPath: string, workspaceId: string, sources: readonly { record_id?: string; source_version: string; content_digest: string }[]) {
  const db = openReadOnlyDatabase(snapshotPath);
  try {
    const records = new SqliteFieldSourceRecordRepo(db, fieldContractSha256), spans = new SqliteFieldSourceSpanRepo(db, fieldContractSha256);
    return { messageSpans: spans.listByWorkspace(workspaceId).filter(row => row.purpose === "message").length,
      roots: sources.map(source => ({ row: records.findById(workspaceId, source.record_id!)!,
        inventory: records.readHostInventory({ workspaceId, recordId: source.record_id!, sourceVersion: source.source_version,
          contentDigest: source.content_digest, authorizedScopes: ["project"], nativeByteLimit: 131072, workLimit: 262144,
          memoryLimit: 262144 }) })) };
  } finally { db.close({ optimize: false }); }
}

it("publishes each session's rounds through the host-session capture owner into sealed SQLite", async () => {
  const f = fixture(); vi.spyOn(datasetOwner, "loadDatasetWindowWithIdentity").mockResolvedValue(f.loaded);
  const census = await censusCompleteSourceRecords({ population: f.population.name, dataDir: f.root, pinnedMetaRoot: f.root });
  const keys = [0, 1].map(session => hostSessionContainerKey(longMemEvalSessionContainer("authored-round", session), fieldContractSha256));
  expect(census.records.map(row => [row.source_id, row.source_version, row.session_index, row.round_index])).toEqual([
    [hostSessionRoundSourceId(keys[0]!, 0), HOST_SESSION_CONTRACT, 0, 0], [hostSessionRoundSourceId(keys[1]!, 0), HOST_SESSION_CONTRACT, 1, 0]]);
  // The owner's canonical body is the renderer's, byte for byte.
  expect(census.records[0]!.content_bytes).toBe(renderOfficialApiSourceCorpus("", f.loaded.questions[0]!.haystack_sessions[0]!).content);
  expect(census.host_sessions.requests.map(request => [request.container.id, request.messages.length, request.closes_tail]))
    .toEqual([["authored-round:s0", 2, true], ["authored-round:s1", 1, true]]);
  const report = await f.publish("structured", "2026-09-14T00:00:00.000Z", { maxSources: 2,
    maxContentBytes: census.records.reduce((n, row) => n + Buffer.byteLength(row.content_bytes, "utf8"), 0) });
  expect(report).toMatchObject({ census_count: 2, admitted_count: 2, rejected_count: 0, published_count: 0 });
  expect(hashRegularFileNoFollow(report.snapshot_path)).toBe(report.db_sha256);
  expect(report.sources.map(row => row.source_id)).toEqual(census.records.map(row => row.source_id));
  const sealed = readRoots(report.snapshot_path, report.workspace_id, report.sources);
  expect(sealed.messageSpans).toBe(3);
  for (const [index, { row, inventory }] of sealed.roots.entries()) {
    const source = census.records[index]!;
    expect(row).toMatchObject({ source_id: source.source_id, source_version: HOST_SESSION_CONTRACT, source_body: source.content_bytes,
      event_time: source.source_observed_at, recorded_at: "2026-09-14T00:00:00.000Z" });
    expect(inventory.status).toBe("captured");
    expect(inventory.inventory!.issuer).toMatchObject({ producer: "longmemeval-structured-source", basis: "pinned_dataset",
      namespace: `longmemeval:${"a".repeat(64)}` });
  }
  const first = sealed.roots[0]!.inventory.inventory!;
  expect(sealed.roots[0]!.row.source_body).toBe("User: café 雪\nAssistant: User: quoted Assistant: still quoted");
  expect(first.occurrences.map(row => [row.occurrence_id, row.role, row.upstream_position])).toEqual([
    ["authored-round:s0:m0", "user", 0], ["authored-round:s0:m1", "assistant", 1]]);
  expect(first.occurrences.map(row => row.utf8_span)).toEqual([[6, 15], [27, 63]]);
  expect(first.occurrences.every(row => row.container_ref?.id === "authored-round:s0" && row.completeness === "complete" &&
    row.host_reported_at === "2023-09-11T00:00:00.000Z")).toBe(true);
  const operations = isolation.receipt().operations;
  const created = operations.filter((row: { operation: string }) => row.operation === "worker.create.allowed");
  const closed = operations.filter((row: { operation: string }) => row.operation === "worker.exit");
  expect(closed.map((row: { worker_id: number }) => row.worker_id)).toEqual(created.map((row: { worker_id: number }) => row.worker_id));
  if (evidence !== undefined) console.log(`Authored structured publication: ${report.snapshot_path}.publication.json`);
});

it("captures an unverified dataset copy as an ordinary host session, never with dataset authority", async () => {
  const f = fixture();
  vi.spyOn(datasetOwner, "loadDatasetWindowWithIdentity").mockResolvedValue({ ...f.loaded, promotionAuthority: null });
  const report = await f.publish("unverified", "2026-09-14T00:00:00.000Z");
  expect(report).toMatchObject({ census_count: 2, admitted_count: 2, rejected_count: 0 });
  for (const { inventory } of readRoots(report.snapshot_path, report.workspace_id, report.sources).roots) {
    expect(inventory.inventory!.issuer).toMatchObject({ producer: "longmemeval-unverified-source", basis: "host_session",
      namespace: `longmemeval-unverified:${"a".repeat(64)}` });
  }
});

it("refuses source/byte overruns before daemon startup", async () => {
  const f = fixture(); vi.spyOn(datasetOwner, "loadDatasetWindowWithIdentity").mockResolvedValue(f.loaded);
  const start = vi.spyOn(daemonOwner, "startBenchDaemon");
  for (const sourceLimits of [{ maxSources: 1, maxContentBytes: 10000 }, { maxSources: 2, maxContentBytes: 1 }])
    await expect(f.publish("bounded", "2026-09-14T00:00:00.000Z", sourceLimits)).rejects.toThrow(/source\/byte limits/);
  expect(start).not.toHaveBeenCalled(); expect(existsSync(join(f.root, "bounded.sqlite"))).toBe(false);
});
