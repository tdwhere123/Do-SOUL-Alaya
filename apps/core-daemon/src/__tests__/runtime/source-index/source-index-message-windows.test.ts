import { afterAll, expect, it, vi } from "vitest";
const guard = await vi.hoisted(async () => {
  const url = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/authored-source-embedding-guard.mjs", import.meta.url);
  const { isolation } = await import(/* @vite-ignore */ url.href);
  return { isolation, preload: url.href };
});
afterAll(() => { expect(guard.isolation.violations).toEqual([]); guard.isolation.restore(); });
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceIndexBackfill, SourceIndexLifecycle, createSourceAdmissionPort } from "@do-soul/alaya-core";
import { initDatabase, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import type { HostOccurrence, SourceAdmissionContext, SourceIndexConfiguration } from "@do-soul/alaya-protocol";
import { LocalOnnxEmbeddingClient } from "../../../../../../packages/core/src/embedding-recall/local-onnx-embedding-client.js";
import { fixture, configuration, fieldSha256, BUDGET, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { SourceIndexProducer } from "../../../runtime/source-index/source-index-producer.js";

const body = "a\nbcDEFGHI";
const occurrences: HostOccurrence[] = [[0, 4], [4, 10], [10, 10]].map(([start, end], index) => ({
  occurrence_id: `message-${index}`, utf8_span: [start!, end!], completeness: "complete", fidelity: "original_bytes",
  role: null, channel: null, author_ref: null, container_ref: null, upstream_message_ref: null, upstream_position: null
}));
it("keeps unknown, captured-empty, empty-message and excerpt facts distinct through native preparation", () => {
  const environment = fixture(), { database, index } = environment;
  try {
    const admission = createSourceAdmissionPort({ sha256: fieldSha256,
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }) });
    const variants = [undefined, [], [{ ...occurrences[0]!, utf8_span: [0, 0] as const }],
      [{ ...occurrences[0]!, utf8_span: [0, 9] as const, completeness: "excerpt" as const }]];
    for (const [i, facts] of variants.entries()) admission.admit({ workspace_id: WORKSPACE, source_id: `state-${i}`,
      source_version: "1", content_bytes: "abcdefghi", recorded_at: "2026-09-13T00:00:00Z", event_time: null,
      valid_from: null, valid_to: null, evidence_object_id: null, source_representation: { kind: "original_body" },
      spans: [], ...(facts === undefined ? {} : { host_occurrences: facts }) }, context);
    const lifecycle = new SourceIndexLifecycle(index, fieldSha256);
    const generation = lifecycle.begin(lifecycle.select(WORKSPACE, configuration({ windowing: "recorded-message-windows.v1" })));
    expect(lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET).generation.target_count).toBe(4);
    for (const target of index.listTargets(WORKSPACE, generation.generation_id, null, 8)) {
      const result = lifecycle.prepare(WORKSPACE, generation.generation_id, target.root_key, BUDGET);
      if (result.status !== "ready") throw new Error(result.reason);
      const facts = variants[Number(target.source_id!.slice(-1))];
      expect(result.document.message_structure).toEqual(facts === undefined ? { status: "unknown" }
        : { status: "captured", occurrences: facts.map(row => ({ utf8_span: row.utf8_span, completeness: row.completeness })) });
      expect(result.document.windows.map(row => [row.start_byte, row.end_byte])).toEqual([[0, 4], [4, 9]]);
    }
  } finally { database.close({ optimize: false }); }
});

const context: SourceAdmissionContext = { workspaceId: WORKSPACE, hostCapture: () => ({
  namespace: "authored", workspace_id: WORKSPACE, producer: "local-test", basis: "pinned_dataset" }) };

it("prepares admitted message windows through real SQLite and guarded child IPC, replays, and fences old generations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "message-index-")), filename = join(directory, "source.sqlite");
  const environment = fixture(filename);
  let database = environment.database, index = environment.index;
  const children: ReturnType<typeof fork>[] = [];
  const script = fileURLToPath(new URL("../../../../../../packages/core/src/__tests__/embedding-recall/local-onnx-embedding-ipc-stub-child.mjs", import.meta.url));
  const client = new LocalOnnxEmbeddingClient({ ipcHost: { spawn() {
    const child = fork(script, [], { execArgv: ["--import", guard.preload], serialization: "advanced", stdio: ["ignore", "ignore", "inherit", "ipc"] });
    children.push(child); return child;
  } } });
  try {
    const port = createSourceAdmissionPort({ sha256: fieldSha256,
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }) });
    const source = port.admit({ workspace_id: WORKSPACE, source_id: "messages", source_version: "1", content_bytes: body,
      recorded_at: "2026-09-13T00:00:00Z", event_time: null, valid_from: null, valid_to: null,
      evidence_object_id: null, source_representation: { kind: "original_body" }, spans: [], host_occurrences: occurrences }, context);
    expect(source.spans.map(row => [row.start_offset, row.end_offset, row.purpose]))
      .toEqual([[0, 4, "message"], [4, 10, "message"]]);
    let lifecycle = new SourceIndexLifecycle(index, fieldSha256);
    const rawBinding = await client.bindSourceEmbedding({ window_bytes: 8, max_input_tokens: 16 });
    if (rawBinding.status !== "ready") throw new Error(rawBinding.reason);
    const config: SourceIndexConfiguration = { revision: "authored-window-comparison", profile: rawBinding.profile };
    const old = lifecycle.begin(lifecycle.select(WORKSPACE, config));
    lifecycle.capture(WORKSPACE, old.generation_id, 8, BUDGET);
    const target = index.listTargets(WORKSPACE, old.generation_id, null, 8)[0]!;
    const oldPrepared = lifecycle.prepare(WORKSPACE, old.generation_id, target.root_key, BUDGET);
    if (oldPrepared.status !== "ready") throw new Error(oldPrepared.reason);
    expect(oldPrepared.document.windows.map(row => [row.start_byte, row.end_byte])).toEqual([[0, 8], [8, 10]]);
    const rawStep = await new SourceIndexBackfill(lifecycle).step({ selection: old.selection,
      generation_id: old.generation_id, root_key: target.root_key, binding: rawBinding,
      budget: { ...BUDGET, model_inputs: 2, input_bytes: 10, max_body_bytes: 10 },
      signal: new AbortController().signal, deadline_ms: Date.now() + 10_000 });
    expect(rawStep).toMatchObject({ status: "root_complete", accepted_vectors: 2, resources: { model_inputs_submitted: 2 } });
    expect(lifecycle.publish(WORKSPACE, old.generation_id)).toEqual({ status: "accepted" });
    const binding = await client.bindSourceEmbedding({ window_bytes: 8, max_input_tokens: 16, windowing: "recorded-message-windows.v1" });
    if (binding.status !== "ready") throw new Error(binding.reason);
    const selection = lifecycle.select(WORKSPACE, { ...config, profile: binding.profile });
    const generation = lifecycle.begin(selection);
    expect(selection.profile_id).not.toBe(old.selection.profile_id);
    expect(generation.generation_id).not.toBe(old.generation_id);
    lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
    const prepared = lifecycle.prepare(WORKSPACE, generation.generation_id, target.root_key, BUDGET);
    if (prepared.status !== "ready") throw new Error(prepared.reason);
    expect(prepared.document.windows.map(row => [row.start_byte, row.end_byte, row.text]))
      .toEqual([[0, 4, "a\nbc"], [4, 10, "DEFGHI"]]);
    expect(prepared.document.message_structure).toEqual({ status: "captured", occurrences: occurrences.map(row => ({
      utf8_span: row.utf8_span, completeness: row.completeness })) });
    expect(prepared.resources.work).toBeGreaterThan(oldPrepared.resources.work);
    expect(prepared.resources.native_bytes).toBeGreaterThan(oldPrepared.resources.native_bytes);
    database.connection.exec("SAVEPOINT missing_inventory");
    database.connection.prepare("DELETE FROM source_host_inventories WHERE record_id=?").run(source.record.identity);
    expect(lifecycle.prepare(WORKSPACE, generation.generation_id, target.root_key, BUDGET))
      .toMatchObject({ status: "partial", reason: "message_structure_unavailable" });
    database.connection.exec("ROLLBACK TO missing_inventory");
    database.connection.prepare("UPDATE source_host_inventories SET canonical_inventory='{}' WHERE record_id=?").run(source.record.identity);
    expect(lifecycle.prepare(WORKSPACE, generation.generation_id, target.root_key, BUDGET))
      .toMatchObject({ status: "partial", reason: "message_structure_invalid" });
    database.connection.exec("ROLLBACK TO missing_inventory; RELEASE missing_inventory");
    expect(() => index.writeDocument(WORKSPACE, generation.generation_id,
      { ...prepared.document, message_structure: { status: "unknown" } }, BUDGET)).toThrow(/manifest mismatch/);
    expect(lifecycle.prepare(WORKSPACE, generation.generation_id, target.root_key, { ...BUDGET, work: 100 }))
      .toMatchObject({ status: "partial", reason: "read_budget" });
    expect(lifecycle.prepare(WORKSPACE, old.generation_id, target.root_key, BUDGET)).toMatchObject({ status: "superseded" });
    const input = { selection, generation_id: generation.generation_id, root_key: target.root_key, binding,
      budget: { ...BUDGET, model_inputs: 1, input_bytes: 10, max_body_bytes: 10 }, signal: new AbortController().signal };
    const first = await new SourceIndexBackfill(lifecycle).step({ ...input, deadline_ms: Date.now() + 10_000 });
    expect(first).toMatchObject({ status: "resource_exhausted", accepted_vectors: 1,
      resources: { model_inputs_submitted: 1, model_input_bytes_submitted: 4, token_count_observed: 3 } });
    database.close({ optimize: false }); database = initDatabase({ filename });
    index = new SqliteSourceIndexRepository(database, fieldSha256); lifecycle = new SourceIndexLifecycle(index, fieldSha256);
    const resumed = await new SourceIndexBackfill(lifecycle).step({ ...input, deadline_ms: Date.now() + 10_000 });
    expect(resumed).toMatchObject({ status: "root_complete", accepted_vectors: 1,
      resources: { model_inputs_submitted: 1, model_input_bytes_submitted: 6, token_count_observed: 3 } });
    expect(lifecycle.publish(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
    const query = index.readVectorCandidates(WORKSPACE, null, 8, {
      work_units: 100_000, memory_bytes: 1_000_000
    });
    expect(query.state.status).toBe("ready");
    expect(query.candidates.map(row => [row.window.start_byte, row.window.end_byte]).sort((a, b) => a[0]! - b[0]!))
      .toEqual([[0, 4], [4, 10]]);
    expect(index.generation(WORKSPACE, old.generation_id)).toMatchObject({ status: "retired", selection: old.selection });
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_vectors WHERE generation_id=?")
      .get(old.generation_id)).toEqual({ n: 2 });
    expect(database.connection.prepare("SELECT start_byte,end_byte FROM source_index_windows WHERE generation_id=? ORDER BY ordinal")
      .all(old.generation_id)).toEqual([{ start_byte: 0, end_byte: 8 }, { start_byte: 8, end_byte: 10 }]);
    lifecycle.unbind(WORKSPACE);
    expect(index.writeDocument(WORKSPACE, generation.generation_id, prepared.document, BUDGET)).toMatchObject({ status: "rejected", reason: "superseded" });
    expect(() => lifecycle.begin(selection)).toThrow(/superseded/);
    const producer = new SourceIndexProducer({ database, bindSourceEmbedding: options => client.bindSourceEmbedding(options),
      warn: message => { throw new Error(message); } });
    try {
      const pass = await producer.runPass(undefined, undefined, "recorded-message-windows.v1");
      expect(pass).toMatchObject({ status: "settled", binding: { status: "ready", profile: { windowing: "recorded-message-windows.v1" } } });
      expect(pass.resources.model_inputs).toBe(1);
      expect(index.generation(WORKSPACE, generation.generation_id)?.status).toBe("retired");
    } finally { await producer.stop(); }
  } finally {
    await client.close(); database.close({ optimize: false }); rmSync(directory, { recursive: true, force: true });
    expect(children).toHaveLength(1);
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
  }
});
