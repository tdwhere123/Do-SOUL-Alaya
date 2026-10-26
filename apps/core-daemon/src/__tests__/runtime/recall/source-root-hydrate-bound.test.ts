import { afterEach, describe, expect, it } from "vitest";
import { SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { sourceDisclosure, InformationIndexSchema, sourceIndexEntry } from "@do-soul/alaya-protocol";
import { sourceRootEligible } from "../../../../../../packages/core/src/recall/conditional-field/observers/observation-admission.js";
import { BoundedIndexPayload } from "../../../../../../packages/core/src/recall/runtime/index-payload.js";
import { encodeRecallResult } from "../../../../../../packages/core/src/recall/runtime/recall-result-encoding.js";
import type { ObserveConditionalFieldInput } from "../../../../../../packages/core/src/recall/conditional-field/observers/observe.js";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import {
  fieldSha256,
  hashedOriginalRecord,
  hashedRecord,
  openFieldDatabase
} from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";

const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("worker source-root hydrate", () => {
  it("carries checked SQL validity through ordinary source payload and candidate encoding", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const record = new SqliteFieldSourceRecordRepo(database, fieldSha256).insert({
      ...hashedOriginalRecord("workspace-1", "Historical original body", "src-history"),
      valid_from: "2026-09-01T00:00:00.000Z", valid_to: "2026-09-10T00:00:00.000Z"
    });
    const asOf = "2026-09-09T12:00:00.000Z";
    const entry = sourceIndexEntry({ workspace_id: "workspace-1", root_kind: "source_record",
      root_id: record.record_id, source_version: record.source_version,
      content_digest: record.content_digest, evidence_object_id: null,
      hypothesis_id: "h0", output_binding: "source-evidence", role: "requested",
      association_milligrades: 1000, claim: "unknown", explanation_ids: [] });
    const payload = new BoundedIndexPayload({ readers: createConditionalFieldObserverReaders(database),
      workspaceId: "workspace-1", asOf, remainingMemoryBytes: 30_000,
      manifestationFor: () => "excerpt" });
    expect(payload.finalize([entry], 500).complete).toBe(true);
    const index = payload.applyDeliveredSpans(InformationIndexSchema.parse({
      schema_version: 1, query_id: "history", snapshot_id: `sha256:${"a".repeat(64)}`,
      result_version: "v1", as_of: asOf, entries: [entry],
      completeness: { schema_version: 1, logical_index: "complete", observed_coverage: "complete",
        transport: "complete", payload: "complete", representation: "complete" }, continuation: null,
      representation: { schema_version: 1, policy: "construct_index_then_page_then_payload",
        page_budget: 5, identity_tie_break: "serialization" }
    }));
    const result = encodeRecallResult(index, payload.previews, undefined, payload.sourceMetadata);
    expect(result.candidates[0]).toMatchObject({ content_preview: "Historical original body" });
    expect(sourceDisclosure(result.candidates[0]!.source_disclosure!)).toMatchObject({ material_kind: "original_body", source_binding: "checked_record",
        evaluated_as_of: asOf, validity: { kind: "bounded", from: "2026-09-01T00:00:00.000Z",
          to_exclusive: "2026-09-10T00:00:00.000Z" }, temporal_state: "within_interval",
        proof_use: { kind: "source_only", qualification: "not_current_proof" } });
  });

  it("hydrates a native root through the request byte limit instead of loading the body", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const body = "汉".repeat(30_000);
    const row = records.insert(hashedRecord("workspace-1", body, "src-worker"));
    const readers = createConditionalFieldObserverReaders(database);
    const page = readers.sourceRoot!({
      workspaceId: "workspace-1",
      rootKind: "source_record",
      rootId: row.record_id,
      revision: row.source_version,
      digest: row.content_digest,
      evidenceObjectId: null,
      byteLimit: 64,
      offset: 0
    });
    expect(page.unavailable).toBe(false);
    expect(page.resourceLimited).toBe(true);
    expect(page.row?.content_complete).toBe(false);
    expect(Buffer.byteLength(page.row?.content ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(page.bytesRead).toBeGreaterThan(0);
    expect(page.bytesRead).toBeLessThan(Buffer.byteLength(body, "utf8"));
  });

  it("returns page-local source hydration bytes and drops the source preview before field retention", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const row = new SqliteFieldSourceRecordRepo(database, fieldSha256)
      .insert(hashedRecord("workspace-1", "round body ".repeat(2_000), "src-long"));
    const entry = sourceIndexEntry({ workspace_id: "workspace-1", root_kind: "source_record",
      root_id: row.record_id, source_version: row.source_version, content_digest: row.content_digest,
      evidence_object_id: null, hypothesis_id: "h0", output_binding: "source-evidence", role: "requested",
      association_milligrades: 1000, claim: "unknown", explanation_ids: [] });
    const payload = new BoundedIndexPayload({ readers: createConditionalFieldObserverReaders(database),
      workspaceId: "workspace-1", remainingMemoryBytes: 100_000, manifestationFor: () => "excerpt" });
    payload.finalize([entry], 500);
    const spent = 100_000 - payload.remainingMemoryBytes;
    expect(spent).toBeGreaterThan(0);
    expect(payload.previews.size).toBe(1);
    expect(payload.takeWork().charged_retained_bytes).toBe(spent);
    expect(payload.releaseSourceHydration()).toBe(spent);
    expect(payload.remainingMemoryBytes).toBe(100_000);
    expect(payload.previews.size).toBe(0);
    expect(payload.releaseSourceHydration()).toBe(0);
  });

  it("maps persisted scope_class so project authorization includes only that native root", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const project = records.insert({
      ...hashedRecord("workspace-1", "project body", "src-project"),
      scope_class: "project"
    });
    const other = records.insert({
      ...hashedRecord("workspace-1", "global body", "src-global"),
      scope_class: "global_domain"
    });
    const omitted = records.insert(hashedRecord("workspace-1", "omitted body", "src-omitted"));
    const page = createConditionalFieldObserverReaders(database).sourceRoots!({
      workspaceId: "workspace-1",
      query: "unused enumeration needle",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    const asOf = "2026-09-09T00:00:00.000Z";
    const input = {
      as_of: asOf,
      query: { interpretation_clock: asOf },
      authorized_scopes: ["project"]
    } as unknown as ObserveConditionalFieldInput;
    expect(sourceRootEligible(input, page.rows.find((row) => row.root_id === project.record_id)!)).toBe(true);
    expect(sourceRootEligible(input, page.rows.find((row) => row.root_id === other.record_id)!)).toBe(false);
    expect(sourceRootEligible(input, page.rows.find((row) => row.root_id === omitted.record_id)!)).toBe(false);
  });

  it("admits an open validity interval and rejects an expired closed one", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const expired = records.insert({
      ...hashedRecord("workspace-1", "expired body", "src-expired"),
      valid_from: "2025-01-01T00:00:00.000Z",
      valid_to: "2026-01-01T00:00:00.000Z"
    });
    const open = records.insert({
      ...hashedRecord("workspace-1", "open body", "src-open"),
      valid_from: "2025-01-01T00:00:00.000Z",
      valid_to: null
    });
    const page = createConditionalFieldObserverReaders(database).sourceRoots!({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    const asOf = "2026-09-09T00:00:00.000Z";
    const input = {
      as_of: asOf,
      query: { interpretation_clock: asOf },
      authorized_scopes: null
    } as unknown as ObserveConditionalFieldInput;
    expect(sourceRootEligible(input, page.rows.find((row) => row.root_id === expired.record_id)!)).toBe(false);
    expect(sourceRootEligible(input, page.rows.find((row) => row.root_id === open.record_id)!)).toBe(true);
  });

  it("denies an empty authorized set and an omitted principal", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const open = records.insert({
      ...hashedRecord("workspace-1", "open body", "src-open"),
      valid_from: "2025-01-01T00:00:00.000Z",
      valid_to: null
    });
    const page = createConditionalFieldObserverReaders(database).sourceRoots!({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    const asOf = "2026-09-09T00:00:00.000Z";
    const row = page.rows.find((item) => item.root_id === open.record_id)!;
    const clock = { as_of: asOf, query: { interpretation_clock: asOf } };
    expect(sourceRootEligible({ ...clock, authorized_scopes: [] } as unknown as ObserveConditionalFieldInput, row)).toBe(false);
    expect(sourceRootEligible(clock as unknown as ObserveConditionalFieldInput, row)).toBe(false);
    expect(sourceRootEligible({ ...clock, authorized_scopes: null } as unknown as ObserveConditionalFieldInput, row)).toBe(true);
  });
});
