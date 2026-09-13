import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteEventLogRepo } from "@do-soul/alaya-storage";
import * as daemonHarness from "../../../harness/daemon.js";
import * as materialize from "../../../runs/snapshot/materialize.js";
import Database from "better-sqlite3";
import { inspectSourceRecordsArtifact, sourceRecordsManifestPath, sourceRecordsSidecarPath,
  createSourceRecordsSidecarWriter, sealSourceRecordsManifest,
  sourceRecordsShardPath, type SourceRecordsMessage, type SourceRecordsSidecar } from "../../../runs/snapshot/source-records/contract.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { inspectSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/inspect.js";
import { prepareSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/prepare.js";
import { BENCH_DAEMON_DB_FILENAME } from "../../../runs/snapshot/materialize.js";

const roots = new Set<string>();
const CLOCK = "2026-09-13T00:00:00.000Z";
const QUESTION_CLOCK = "2023-09-13T00:00:00.000Z";
function readArtifact(path: string) {
  const messages: SourceRecordsMessage[] = [];
  const artifact = inspectSourceRecordsArtifact(path, (message) => messages.push(message));
  return { ...artifact, sidecar: { ...artifact.sidecar, messages } };
}
function replaceSidecar(path: string, sidecar: SourceRecordsSidecar): void {
  const { manifest_sha256: _digest, ...body } = inspectSourceRecordsArtifact(path).manifest;
  materialize.atomicWriteJson(sourceRecordsSidecarPath(path), sidecar);
  materialize.atomicWriteJson(sourceRecordsManifestPath(path), sealSourceRecordsManifest({ ...body,
    sidecar_sha256: hashRegularFileNoFollow(sourceRecordsSidecarPath(path)) }));
}
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots) await rm(root, { recursive: true, force: true }); roots.clear(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-records-snapshot-"));
  roots.add(root);
  const dataDir = join(root, "data");
  const pinnedMetaRoot = join(root, "meta");
  await mkdir(dataDir); await mkdir(pinnedMetaRoot);
  const source = JSON.stringify([{
    question_id: "source-question", question_type: "fixture", question: "What was recorded?", answer: "excluded gold",
    question_date: "2023/09/13 (Wed) 00:00", haystack_session_ids: ["original-session"],
    haystack_dates: ["2023/09/12 (Tue) 00:00"], answer_session_ids: ["original-session"],
    haystack_sessions: [[{ role: "user", content: "A café source record.", has_answer: true },
      { role: "assistant", content: "A café source record." }, { role: "user", content: "" }]]
  }]);
  await writeFile(join(dataDir, "longmemeval_s.json"), source);
  await writeFile(join(pinnedMetaRoot, "longmemeval_s.meta.json"), JSON.stringify({
    sha256: createHash("sha256").update(source).digest("hex"), size_bytes: Buffer.byteLength(source), question_count: 1
  }));
  return { root, input: { snapshotPath: join(root, "source.db"), dataDirRoot: join(root, "seed"),
    dataDir, pinnedMetaRoot, offset: 0, limit: 1, recordedAt: CLOCK, producerCommit: "a".repeat(40) } };
}

describe("source record snapshot preparation and consumer", () => {
  it("prepares through the actual CLI and restores original messages through MCP", async () => {
    const f = await fixture();
    await promisify(execFile)(process.execPath, [resolve("apps/bench-runner/bin/alaya-bench-runner.mjs"),
      "source-snapshot", "prepare", "--snapshot", f.input.snapshotPath, "--data-dir-root", f.input.dataDirRoot,
      "--data-dir", f.input.dataDir, "--pinned-meta-root", f.input.pinnedMetaRoot,
      "--limit", "1", "--recorded-at", CLOCK], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    const first = readArtifact(f.input.snapshotPath);
    expect(first.sidecar.messages).toHaveLength(3);
    expect(new Set(first.sidecar.messages.map((m) => m.record.identity)).size).toBe(3);
    expect(first.sidecar.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(first.sidecar.messages[2]!).toMatchObject({ content_state: "empty", spans: [] });
    for (const message of first.sidecar.messages) {
      expect(message.record).toMatchObject({ evidence_object_id: null, event_time: null, valid_from: null, valid_to: null, recorded_at: CLOCK });
      expect(message.source_observed_at).toBe("2023-09-12T00:00:00.000Z");
    }
    const inspected = await inspectSourceRecordsSnapshot({ snapshotPath: f.input.snapshotPath,
      questionId: "source-question", query: "What was recorded?", maxResults: 1 });
    expect(inspected.pages.flatMap((p) => p.index?.entries ?? []).length).toBeGreaterThan(0);
    expect(inspected.pages.flatMap((p) => p.index?.entries ?? []).every((entry) => entry.target?.kind === "source_evidence")).toBe(true);
    expect(new Set(inspected.pages.flatMap((page) => page.results).flatMap((result) =>
      result.target.kind === "source_evidence" ? [result.target.root_id] : [])))
      .toEqual(new Set(first.sidecar.messages.map((message) => message.record.identity)));
    expect(new Set(inspected.pages.map((page) => page.index?.snapshot_id)).size).toBe(1);
    expect(inspected.response.index?.completeness.interpretation_coverage).toBe("open");
    expect(inspected.response.index?.completeness.logical_index).toBe("complete");
    expect(inspected.response.index?.as_of).toBe(QUESTION_CLOCK);
    expect(inspected.continuation_state).toBe("exhausted");
    expect(inspected.pages.length).toBeGreaterThan(1);
    const empty = inspected.pages.flatMap((page) => page.results).find((result) =>
      result.target.kind === "source_evidence" && result.target.root_id === first.sidecar.messages[2]!.record.identity);
    expect(empty?.content_preview).toBe("[empty source]");
    expect(empty?.target).toMatchObject({ span: { content_start: 0, content_end: 0,
      content_complete: true, original_complete: true, retained_extent: "body" } });
    const db = new Database(f.input.snapshotPath, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM memory_entries").get()).toMatchObject({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM evidence_capsules").get()).toMatchObject({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM garden_tasks").get()).toMatchObject({ n: 0 });
      expect(db.prepare("SELECT source_body FROM source_records WHERE record_id = ?")
        .get(first.sidecar.messages[2]!.record.identity)).toMatchObject({ source_body: "" });
    } finally { db.close(); }
    const cli = await promisify(execFile)(process.execPath, [resolve("apps/bench-runner/bin/alaya-bench-runner.mjs"),
      "source-snapshot", "inspect", "--snapshot", f.input.snapshotPath, "--question-id", "source-question",
      "--query", "What was recorded?", "--max-results", "1"], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    expect(cli.stdout).toContain('"continuation_state": "exhausted"');
  }, 120000);

  it("reuses a sealed identical preparation and rejects a conflicting recorded time", async () => {
    const f = await fixture();
    const first = await prepareSourceRecordsSnapshot(f.input);
    expect(await prepareSourceRecordsSnapshot(f.input)).toEqual(first);
    await expect(prepareSourceRecordsSnapshot({ ...f.input, recordedAt: "2026-09-14T00:00:00.000Z" })).rejects.toThrow(/identity conflict/);
    await expect(inspectSourceRecordsSnapshot({ snapshotPath: f.input.snapshotPath, questionId: "foreign", query: "source" })).rejects.toThrow(/outside/);
  }, 120000);

  it("rejects DB, sidecar, manifest and foreign-domain tampering before restore", async () => {
    const f = await fixture();
    await prepareSourceRecordsSnapshot(f.input);
    const shard = sourceRecordsShardPath(f.input.snapshotPath, inspectSourceRecordsArtifact(f.input.snapshotPath).sidecar.shards[0]!.sha256);
    for (const path of [f.input.snapshotPath, sourceRecordsSidecarPath(f.input.snapshotPath), sourceRecordsManifestPath(f.input.snapshotPath), shard]) {
      const original = await readFile(path);
      await writeFile(path, Buffer.concat([original, Buffer.from("tamper")]));
      expect(() => inspectSourceRecordsArtifact(f.input.snapshotPath)).toThrow();
      await writeFile(path, original);
    }
    if (process.platform !== "win32") {
      await rename(shard, `${shard}.retained`);
      await symlink(`${shard}.retained`, shard);
      expect(() => inspectSourceRecordsArtifact(f.input.snapshotPath)).toThrow();
      await rm(shard);
      await rename(`${shard}.retained`, shard);
    }
    await writeFile(sourceRecordsManifestPath(f.input.snapshotPath), JSON.stringify({ schema_version: 2, artifact_domain: "post_extraction" }));
    expect(() => inspectSourceRecordsArtifact(f.input.snapshotPath)).toThrow();
  }, 120000);

  it("rejects a valid foreign artifact substituted for an existing preparation", async () => {
    const a = await fixture();
    const b = await fixture();
    await prepareSourceRecordsSnapshot(a.input);
    await prepareSourceRecordsSnapshot({ ...b.input, recordedAt: "2026-09-14T00:00:00.000Z" });
    const foreign = inspectSourceRecordsArtifact(b.input.snapshotPath);
    for (const shard of foreign.sidecar.shards) await copyFile(sourceRecordsShardPath(b.input.snapshotPath, shard.sha256),
      sourceRecordsShardPath(a.input.snapshotPath, shard.sha256));
    replaceSidecar(a.input.snapshotPath, { ...inspectSourceRecordsArtifact(a.input.snapshotPath).sidecar,
      shards: foreign.sidecar.shards });
    expect(() => inspectSourceRecordsArtifact(a.input.snapshotPath)).toThrow(/message binding/);
    for (const suffix of ["", ".manifest.json", ".sources.json"]) await copyFile(b.input.snapshotPath + suffix, a.input.snapshotPath + suffix);
    expect(inspectSourceRecordsArtifact(a.input.snapshotPath).manifest.recorded_at).toBe("2026-09-14T00:00:00.000Z");
    await expect(prepareSourceRecordsSnapshot(a.input)).rejects.toThrow(/differs from preparation identity/);
  }, 120000);

  it("rolls over bounded sidecar shards and validates every original message without aggregating them", async () => {
    const f = await fixture();
    await prepareSourceRecordsSnapshot(f.input);
    const original = readArtifact(f.input.snapshotPath);
    const { shards: _shards, message_count: _count, messages, ...header } = original.sidecar;
    const writer = createSourceRecordsSidecarWriter(f.input.snapshotPath, header);
    // Multibyte metadata makes the total larger than one shard without changing native record or span identities.
    for (const message of messages) writer.append({ ...message, session_id: "é".repeat(2 * 1024 * 1024) });
    const sidecar = writer.finish();
    materialize.atomicWriteJson(sourceRecordsManifestPath(f.input.snapshotPath), sealSourceRecordsManifest({
      schema_version: 2, artifact_domain: "source_records", dataset: sidecar.dataset, recorded_at: sidecar.recorded_at,
      message_count: 3, producer_commit: f.input.producerCommit, db_sha256: original.manifest.db_sha256,
      sidecar_sha256: hashRegularFileNoFollow(sourceRecordsSidecarPath(f.input.snapshotPath)) }));
    expect(sidecar.shards.length).toBeGreaterThan(1);
    expect(sidecar.shards.reduce((sum, shard) => sum + shard.byte_length, 0)).toBeGreaterThan(8 * 1024 * 1024);
    expect(sidecar.shards.every((shard) => shard.byte_length <= 8 * 1024 * 1024)).toBe(true);
    const observed: string[] = [];
    const verified = inspectSourceRecordsArtifact(f.input.snapshotPath, (message) => observed.push(message.record.identity));
    expect(observed).toEqual(messages.map((message) => message.record.identity));
    expect(verified.sidecar).not.toHaveProperty("messages");
    const last = sourceRecordsShardPath(f.input.snapshotPath, sidecar.shards.at(-1)!.sha256);
    const bytes = await readFile(last);
    await rm(last);
    expect(() => inspectSourceRecordsArtifact(f.input.snapshotPath)).toThrow();
    await writeFile(last, Buffer.concat([bytes, Buffer.from("tamper")]));
    expect(() => inspectSourceRecordsArtifact(f.input.snapshotPath)).toThrow(/digest or length/);
    await writeFile(last, bytes);
    expect(inspectSourceRecordsArtifact(f.input.snapshotPath).manifest.message_count).toBe(3);
  }, 120000);

  it("rejects duplicate or omitted shard references and source artifact version one", async () => {
    const f = await fixture();
    await prepareSourceRecordsSnapshot(f.input);
    const original = inspectSourceRecordsArtifact(f.input.snapshotPath);
    const manifestBytes = await readFile(sourceRecordsManifestPath(f.input.snapshotPath));
    const sidecarBytes = await readFile(sourceRecordsSidecarPath(f.input.snapshotPath));
    for (const shards of [[...original.sidecar.shards, ...original.sidecar.shards], []]) {
      replaceSidecar(f.input.snapshotPath, { ...original.sidecar, shards });
      expect(() => inspectSourceRecordsArtifact(f.input.snapshotPath)).toThrow(/binding|count/);
      await writeFile(sourceRecordsManifestPath(f.input.snapshotPath), manifestBytes);
      await writeFile(sourceRecordsSidecarPath(f.input.snapshotPath), sidecarBytes);
    }
    await writeFile(sourceRecordsManifestPath(f.input.snapshotPath), JSON.stringify({ ...original.manifest, schema_version: 1 }));
    expect(() => inspectSourceRecordsArtifact(f.input.snapshotPath)).toThrow();
  }, 120000);

  it.each(["audit", "projection", "sidecar"] as const)("keeps preparation unsealed after %s failure and retries the same records", async (failure) => {
    const f = await fixture();
    if (failure === "audit") {
      const append = SqliteEventLogRepo.prototype.append;
      vi.spyOn(SqliteEventLogRepo.prototype, "append").mockImplementation(function (this: SqliteEventLogRepo, event) {
        if (event.entity_type === "source_record") throw new Error("source audit unavailable");
        return append.call(this, event);
      });
    } else if (failure === "projection") {
      const start = daemonHarness.startBenchDaemon;
      vi.spyOn(daemonHarness, "startBenchDaemon").mockImplementation(async (options) => {
        const daemon = await start(options);
        vi.spyOn(daemon.runtime.services.fieldProjectionCheckpoint, "refresh").mockRejectedValue(new Error("source projection unavailable"));
        return daemon;
      });
    } else {
      const write = materialize.atomicWriteJson;
      vi.spyOn(materialize, "atomicWriteJson").mockImplementation((path, value, indentation) => {
        write(path, value, indentation);
        if (/\.sources\.[a-f0-9]{64}\.json$/u.test(path)) throw new Error("source sidecar unavailable");
      });
    }
    await expect(prepareSourceRecordsSnapshot(f.input)).rejects.toThrow(/unavailable/);
    expect(existsSync(sourceRecordsManifestPath(f.input.snapshotPath))).toBe(false);
    const db = new Database(join(f.input.dataDirRoot, BENCH_DAEMON_DB_FILENAME), { readonly: true });
    let committed: { record_id: string }[];
    try { committed = db.prepare("SELECT record_id FROM source_records").all() as { record_id: string }[]; }
    finally { db.close(); }
    expect(committed.length).toBeGreaterThan(0);
    vi.restoreAllMocks();
    const recovered = await prepareSourceRecordsSnapshot(f.input);
    expect(recovered.message_count).toBe(3);
    const ids = new Set(readArtifact(f.input.snapshotPath).sidecar.messages.map((message) => message.record.identity));
    for (const record of committed) expect(ids.has(record.record_id)).toBe(true);
    const inspected = await inspectSourceRecordsSnapshot({ snapshotPath: f.input.snapshotPath, questionId: "source-question", query: "What was recorded?" });
    expect(inspected.response.index?.completeness.logical_index).toBe("complete");
  }, 120000);
});
