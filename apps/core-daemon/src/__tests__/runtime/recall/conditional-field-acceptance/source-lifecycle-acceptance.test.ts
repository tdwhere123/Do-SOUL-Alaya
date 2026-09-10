import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceHealthState,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  hashContentDigest,
  hashSourceRecordId
} from "@do-soul/alaya-protocol";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { assertTargetConsumer } from "./consumer-contract.js";
import {
  MEM,
  WS,
  defaultBudget,
  openBoundSlice,
  plantDeployment,
  plantNeedles,
  readersFor,
  recallThroughHandler,
  runRecall,
  toConsumer,
  tombstone
} from "./planted-handler.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field source and worker acceptance", () => {
  it("interrupted zero rows stay open and resumable, not known-empty", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const inner = readersFor(slice);
    const interrupted = {
      ...inner,
      lexical: (input: Parameters<NonNullable<typeof inner.lexical>>[0]) =>
        inner.lexical!({ ...input, limit: 0, nativeLimit: 0 })
    };
    const first = runRecall(slice, { readers: interrupted });
    const resumed = runRecall(slice, { readers: interrupted, continuation: first.continuation });
    expect(first.entries).toEqual([]);
    expect(first.completeness.logical_index).not.toBe("complete");
    expect(first.completeness.observed_coverage).not.toBe("exhausted_empty");
    expect(resumed.completeness.observed_coverage).not.toBe("exhausted_empty");
  });

  it("hides tombstones and keeps the current source after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conditional-field-accept-a18-"));
    const filename = join(directory, "source.sqlite");
    const first = await openBoundSlice((database) => databases.add(database), filename);
    await plantDeployment(first);
    tombstone(first, MEM.u);
    const hidden = await recallThroughHandler(first, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    expect(hidden.index.entries.map((entry) => entry.object_id)).not.toContain(MEM.u);
    expect(first.memoryReader.source(WS, MEM.r).unavailable).toBe(false);
    expect(first.indexProjection.freshness(WS, MEM.u).lexical).toBe("tombstoned");
    first.database.close();
    databases.delete(first.database);
    const reopened = await openBoundSlice((database) => databases.add(database), filename);
    const restarted = await recallThroughHandler(reopened, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    expect(restarted.index.entries.map((entry) => entry.object_id)).not.toContain(MEM.u);
    expect(reopened.memoryReader.source(WS, MEM.r).unavailable).toBe(false);
    reopened.database.close();
    databases.delete(reopened.database);
    rmSync(directory, { recursive: true, force: true });
  });

  it("mixed generations cannot resume an old complete page", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantNeedles(slice, 8, 911);
    const first = await recallThroughHandler(slice, {
      query: "needle",
      max_results: 1
    });
    expect(first.index.continuation).not.toBeNull();
    const mixed = runRecall(slice, {
      query_text: "needle",
      budget: defaultBudget({ page_budget: 1 }),
      continuation: first.index.continuation,
      snapshot_id: `sha256:${"e".repeat(64)}`
    });
    expect(mixed.completeness.logical_index).not.toBe("complete");
    expect(mixed.completeness.observed_coverage).toBe("invalidated");
    expect(mixed.continuation).toBeNull();
  });

  it("maps worker cancellation off the complete-empty path", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const index = runRecall(slice, { cancelled: true });
    expect(index.completeness.observed_coverage).toBe("cancelled");
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(assertTargetConsumer({
      schema_version: 1,
      surface: "mcp",
      bound: true,
      note: "real producer",
      query_id: index.query_id,
      snapshot_id: index.snapshot_id,
      result_version: index.result_version,
      provider_calls: 0,
      garden_enqueue: 0,
      index
    })).toEqual([]);
  });

  it("normal-entry provider and garden counters stay at zero", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const before = slice.pendingGarden().length;
    const mcp = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    expect(slice.pendingGarden()).toHaveLength(before);
    expect(assertTargetConsumer(toConsumer(mcp, "mcp"))).toEqual([]);
  });

  it("discovers a capsule-only root after optional formation is absent", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    const capsule = await new SqliteEvidenceCapsuleRepo(slice.database).create({
      object_id: "cccccccc-cccc-4ccc-8ccc-000000000201",
      object_kind: "evidence_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-09-05T12:00:00.000Z",
      updated_at: "2026-09-05T12:00:00.000Z",
      created_by: "user_action",
      evidence_kind: "conversation_excerpt",
      semantic_anchor: { topic: "source", keywords: ["capsule"], summary: "capsule only root" },
      event_anchor: {
        event_type: "engine.response.received",
        event_id: "evt-cap",
        occurred_at: "2026-09-05T12:00:00.000Z"
      },
      physical_anchor: null,
      evidence_health_state: EvidenceHealthState.VERIFIED,
      gist: "capsule only root gist",
      excerpt: "capsule only root excerpt",
      source_hash: null,
      run_id: "run-1",
      workspace_id: WS,
      surface_id: null
    });
    const mcp = await recallThroughHandler(slice, {
      query: "capsule only root excerpt",
      max_results: 32,
      result_kind_view: "source_only"
    });
    expect(assertTargetConsumer(toConsumer(mcp, "mcp"))).toEqual([]);
    const entry = mcp.index.entries.find((item) => item.target.kind === "source_evidence");
    expect(entry?.object_id).toBeUndefined();
    if (entry?.target.kind !== "source_evidence") throw new Error("expected source_evidence");
    expect(entry.target.root_kind).toBe("evidence_capsule");
    expect(entry.target.root_id).toBe(capsule.object_id);
    expect(entry.target.evidence_object_id).toBe(capsule.object_id);
  });

  it("exposes a source-record-only root on the public soul.recall body", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    const record = plantRecord(slice.database, "record only public root excerpt");
    const mcp = await recallThroughHandler(slice, {
      query: "record only public root excerpt",
      max_results: 32,
      result_kind_view: "source_only"
    });
    expect(assertTargetConsumer(toConsumer(mcp, "mcp"))).toEqual([]);
    const result = mcp.results.find((row) => row.object_kind === "source_evidence");
    expect(result?.object_id).toBeUndefined();
    expect(result?.target).toMatchObject({
      kind: "source_evidence",
      root_kind: "source_record",
      root_id: record.record_id,
      source_version: "v1",
      evidence_object_id: null
    });
    if (result?.target.kind !== "source_evidence") throw new Error("expected source_evidence");
    expect(result.target.span).toEqual(expect.objectContaining({
      content_start: 0,
      retained_extent: "body"
    }));
    expect("object_id" in result).toBe(false);
  });

  it("fails closed after source-body erasure and unauthorized scope", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    const record = plantRecord(slice.database, "scope-erased source");
    const found = await recallThroughHandler(slice, {
      query: "scope-erased source",
      max_results: 32,
      result_kind_view: "source_only"
    });
    expect(found.index.entries.some((entry) =>
      entry.target.kind === "source_evidence" && entry.target.root_id === record.record_id
    )).toBe(true);

    const scoped = runRecall(slice, {
      query_text: "scope-erased source",
      result_kind_view: "source_only",
      authorized_scopes: ["private"]
    });
    expect(scoped.entries).toEqual([]);

    slice.database.connection.prepare(
      "UPDATE source_records SET source_body = NULL WHERE workspace_id = ? AND record_id = ?"
    ).run(WS, record.record_id);
    const erased = await recallThroughHandler(slice, {
      query: "scope-erased source",
      max_results: 32,
      result_kind_view: "source_only"
    });
    expect(erased.index.entries.some((entry) =>
      entry.target.kind === "source_evidence" && entry.target.root_id === record.record_id
    )).toBe(false);
  });
});

function plantRecord(database: StorageDatabase, body: string) {
  const content_digest = hashContentDigest(body, fieldContractSha256);
  return new SqliteFieldSourceRecordRepo(database, fieldContractSha256).insert({
    record_id: hashSourceRecordId({
      source_id: "speaker-a",
      source_version: "v1",
      content_digest
    }, fieldContractSha256),
    workspace_id: WS,
    source_id: "speaker-a",
    source_version: "v1",
    content_digest,
    evidence_object_id: null,
    recorded_at: "2026-09-05T12:00:00.000Z",
    event_time: "2026-09-05T12:00:00.000Z",
    valid_from: null,
    valid_to: null,
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    speaker: null,
    scope_class: null,
    source_body: body
  });
}
