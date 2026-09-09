import { afterEach, describe, expect, it } from "vitest";
import { SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { sourceRootEligible } from "../../../../../../packages/core/src/recall/conditional-field/observers/observation-admission.js";
import type { ObserveConditionalFieldInput } from "../../../../../../packages/core/src/recall/conditional-field/observers/observe.js";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import {
  fieldSha256,
  hashedRecord,
  openFieldDatabase
} from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";

const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("worker source-root hydrate", () => {
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
    expect(page.bytesRead).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(page.row?.content ?? "", "utf8")).toBe(page.bytesRead);
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
    } as ObserveConditionalFieldInput;
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
      authorized_scopes: []
    } as ObserveConditionalFieldInput;
    expect(sourceRootEligible(input, page.rows.find((row) => row.root_id === expired.record_id)!)).toBe(false);
    expect(sourceRootEligible(input, page.rows.find((row) => row.root_id === open.record_id)!)).toBe(true);
  });
});
