import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => isolation.restore());
import { type SoulMemorySearchResponse, type SourceEvidenceTarget } from "@do-soul/alaya-protocol";
import { EventPublisher, RecallService, fieldContractSha256, snapshotIdFromPin } from "@do-soul/alaya-core";
import { SqliteEvidenceCapsuleRepo, SqliteFieldSourceRecordRepo, SqliteSourceRootRecallReader, SqliteTrustStateRepo,
  SqliteEventLogRepo, SqliteIndexedRecallProjection, initDatabase, type StorageDatabase } from "@do-soul/alaya-storage";
import { nominateNativeSources } from "../../../../runtime/recall-read-worker/observer-operations.js";
import { createRecallReadWorkerClient } from "../../../../runtime/recall/recall-read-worker-client.js";
import { createMcpMemoryToolHandler } from "../../../../mcp-memory/tool/tool-handler.js";
import { TrustStateRecorder } from "../../../../trust/state.js";
import { createDeps } from "../../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createDependencies } from "../../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { openSourceSlice, WS, RUN } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { prepareSourceIndex, recallReadWorkerUrl } from "./planted-handler.js";

const NOW = "2026-09-07T00:00:00.000Z";
const context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: RUN };
const databases = new Set<StorageDatabase>(), directories: string[] = [];
const workers: NonNullable<ReturnType<typeof createRecallReadWorkerClient>>[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const db of databases) db.close(); databases.clear();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
  expect(isolation.violations).toEqual([]);
});
async function handlerFor(database: StorageDatabase, filename: string) {
  const worker = createRecallReadWorkerClient({ databaseFilename: filename, workerCount: 1, workerUrl: recallReadWorkerUrl() });
  if (worker === null) throw new Error("real worker required");
  workers.push(worker); await worker.ready();
  const { dependencies } = createDependencies();
  const service = new RecallService({ ...dependencies, now: () => NOW, readSnapshot: worker.readSnapshot,
    conditionalFieldPort: worker.conditionalFieldPort, activeConstraintsPort: worker.activeConstraintsPort });
  const capsules = new SqliteEvidenceCapsuleRepo(database);
  const roots = new SqliteSourceRootRecallReader(new SqliteFieldSourceRecordRepo(database, fieldContractSha256), capsules);
  const recorder = new TrustStateRecorder({ ready: true, clock: () => NOW,
    currentSnapshotId: workspace => snapshotIdFromPin(workspace, new SqliteIndexedRecallProjection(database.connection).observablePin(workspace)),
    repo: new SqliteTrustStateRepo(database), eventPublisher: new EventPublisher({ eventLogRepo: new SqliteEventLogRepo(database),
      runHotStateService: { apply: () => {} }, runtimeNotifier: { notify: async () => {}, notifyEntry: async () => {} } }) });
  return { worker, handler: createMcpMemoryToolHandler({ ...createDeps(), generateId: randomUUID, now: () => NOW,
    recallService: service, trustStateRecorder: recorder, fieldSource: roots,
    evidenceService: { findByIdScoped: async (id, workspace) => {
      const root = await capsules.getById(id); return root?.workspace_id === workspace ? root : null;
    } } }) };
}
async function recall(handler: Awaited<ReturnType<typeof handlerFor>>["handler"], scopes: null | "project" = null) {
  const response = await handler.call({ toolName: "soul.recall", arguments: {
    protocol_version: 1, supported_result_kinds: ["memory_entry", "source_evidence"], supports_source_evidence: true,
    supports_product_updates: true, query: "needle", max_results: 4, result_kind_view: "source_only",
    scope_class: scopes, dimension: null, domain_tags: null }, context });
  if (!response.ok) throw new Error(response.error.message);
  return response.output as SoulMemorySearchResponse;
}
function usage(handler: Awaited<ReturnType<typeof handlerFor>>["handler"], delivery: string, target: SourceEvidenceTarget) {
  return handler.call({ toolName: "soul.report_context_usage", arguments: { delivery_id: delivery, usage_state: "used",
    delivered_objects: [{ object_kind: "source_evidence", target, usage_status: "used" }] }, context });
}

describe("standalone capsule delivery through built worker and MCP usage", () => {
  it.each(["excerpt", "gist"] as const)("delivers exact retained %s bytes and validates the issued delivery after restart", async extent => {
    const dir = await mkdtemp(join(tmpdir(), "alaya-capsule-delivery-")); directories.push(dir);
    const filename = join(dir, "capsules.sqlite");
    const slice = await openSourceSlice(db => databases.add(db), filename);
    const text = "needle 😀 original", id = randomUUID();
    await new SqliteEvidenceCapsuleRepo(slice.database).create({ object_id: id, object_kind: "evidence_capsule", schema_version: 1,
      lifecycle_state: "active", created_at: NOW, updated_at: NOW, created_by: "user_action", evidence_kind: "conversation_excerpt",
      semantic_anchor: { topic: "source", keywords: ["source"], summary: "retained source" }, event_anchor: null, physical_anchor: null,
      evidence_health_state: "verified", gist: extent === "excerpt" ? "gist" : text, excerpt: extent === "excerpt" ? text : null,
      source_hash: "original-turn-digest", run_id: RUN, workspace_id: WS, surface_id: null });
    let live = await handlerFor(slice.database, filename);
    expect((await recall(live.handler)).results).toEqual([]); // cold is not ready
    await live.worker.close(); workers.splice(workers.indexOf(live.worker), 1);
    expect(prepareSourceIndex(slice.database)).toHaveLength(1);
    const nominate = (authorizedScopes: readonly string[] | null, sourceId?: string, workspaceId = WS) =>
      nominateNativeSources(slice.database, { workspaceId, query: "needle", authorizedScopes, sourceId,
        budget: { work_units: 10000, memory_bytes: 1000000 } }, { status: "unavailable", reason: "provider_free" });
    const before = slice.database.connection.prepare("SELECT total_changes() AS n").get();
    expect(nominate(null).result?.nominations).toHaveLength(1);
    expect(nominate([]).result?.nominations).toHaveLength(0);
    expect(nominate(["project"]).result?.nominations).toHaveLength(0);
    expect(nominate(null, "invented-source").result?.nominations).toHaveLength(0);
    expect(nominate(null, undefined, "foreign").result?.nominations).toHaveLength(0);
    expect(slice.database.connection.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    live = await handlerFor(slice.database, filename);
    const delivered = await recall(live.handler);
    const target = delivered.index?.entries[0]?.target;
    if (target?.kind !== "source_evidence") throw new Error("expected an issued capsule target");
    expect(target).toMatchObject({ root_kind: "evidence_capsule", root_id: id, source_version: NOW, evidence_object_id: id,
      span: { content_start: 0, content_end: Buffer.byteLength(text), retained_extent: extent, original_complete: false } });
    expect(delivered.results[0]?.content_preview).toBe(text);
    expect(delivered.results[0]?.object_id).toBeUndefined();
    const persisted = await new SqliteTrustStateRepo(slice.database).findDeliveryById(delivered.delivery_id!);
    expect(persisted?.delivered_objects).toContainEqual({ object_kind: "source_evidence", target });
    expect((await recall(live.handler, "project")).results).toEqual([]);
    for (const forged of [{ ...target, source_version: "stale" }, { ...target, content_digest: `sha256:${"f".repeat(64)}` },
      { ...target, span: { ...target.span!, content_start: 8, content_end: 11 } },
      { ...target, span: { ...target.span!, content_end: 10000 } }]) {
      expect((await usage(live.handler, delivered.delivery_id!, forged)).ok).toBe(false);
    }
    expect(slice.database.connection.prepare("SELECT count(*) AS n FROM source_records").get()).toEqual({ n: 0 });
    expect(slice.database.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
    await live.worker.close(); workers.splice(workers.indexOf(live.worker), 1);
    slice.database.close(); databases.delete(slice.database);
    const reopened = initDatabase({ filename }); databases.add(reopened);
    live = await handlerFor(reopened, filename);
    const afterRestart = await recall(live.handler);
    expect(afterRestart.results[0]?.content_preview).toBe(text);
    expect((await usage(live.handler, delivered.delivery_id!, target)).ok).toBe(true);
    expect(await new SqliteTrustStateRepo(reopened).listUsageByDeliveryIds([delivered.delivery_id!])).toHaveLength(1);
    // Native erase scrub is a tombstone transition; no SourceRecord mirror is created for it.
    reopened.connection.prepare("UPDATE evidence_capsules SET lifecycle_state='tombstone',gist='erased',excerpt=NULL WHERE object_id=?").run(id);
    expect((await recall(live.handler)).results).toEqual([]);
    expect((await usage(live.handler, afterRestart.delivery_id!, target)).ok).toBe(false);
  });
});
