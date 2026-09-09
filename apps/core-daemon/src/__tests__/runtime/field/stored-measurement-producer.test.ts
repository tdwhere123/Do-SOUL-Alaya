import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import {
  compileConditionalFieldQuery,
  snapshotIdFromPin
} from "@do-soul/alaya-core";
import { digestOriginalQuery } from "../../../../../../packages/core/src/recall/conditional-field/query/compile-query.js";
import { observeField } from "../../../../../../packages/core/src/recall/runtime/conditional-field-observe.js";
import { hashMemoryContent } from "../../../../../../packages/core/src/embedding-recall/helpers.js";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import { createSourceBoundRecallFixture } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { defaultBudget } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";

const databases = new Set<StorageDatabase>();
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

const QUERY_TEXT = "kubernetes";
const QUERY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000401";
const OBJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000402";
const NOW = "2026-09-06T12:00:00.000Z";

describe("worker stored measurement producer", () => {
  it("observeField retains measured raw from worker stored-pair readers without live fetch or Garden", async () => {
    const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
    await fixture.writeMemory(QUERY_ID, QUERY_TEXT, MemoryDimension.FACT);
    await fixture.writeMemory(OBJECT_ID, "opaque archival payload", MemoryDimension.FACT);
    fixture.storage.memoryEmbeddingRepo.prepareBoundedRecallIndex();
    await fixture.storage.memoryEmbeddingRepo.upsert({
      object_id: QUERY_ID,
      workspace_id: "workspace-1",
      content_hash: hashMemoryContent(QUERY_TEXT),
      provider_kind: "openai",
      model_id: "stored-fixture",
      schema_version: 1,
      dimensions: 2,
      embedding: new Float32Array([1, 0]),
      created_at: NOW,
      updated_at: NOW
    });
    await fixture.storage.memoryEmbeddingRepo.upsert({
      object_id: OBJECT_ID,
      workspace_id: "workspace-1",
      content_hash: hashMemoryContent("opaque archival payload"),
      provider_kind: "openai",
      model_id: "stored-fixture",
      schema_version: 1,
      dimensions: 2,
      embedding: new Float32Array([1, 0]),
      created_at: NOW,
      updated_at: NOW
    });
    const beforeGarden = fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get();
    const readers = createConditionalFieldObserverReaders(fixture.database);
    expect(typeof readers.embeddingIds).toBe("function");
    expect(typeof readers.measureStoredPair).toBe("function");
    const pin = readers.snapshotPin!("workspace-1");
    const interpretation = compileConditionalFieldQuery({
      source: "ordinary",
      text: QUERY_TEXT,
      interpretation_clock: NOW,
      snapshot_id: snapshotIdFromPin("workspace-1", pin),
      budget: defaultBudget()
    });
    const observed = observeField(interpretation, {
      workspace_id: "workspace-1",
      query_text: QUERY_TEXT,
      budget: defaultBudget(),
      as_of: NOW,
      readers
    });
    const measured = observed.measurements.find((row) =>
      row.raw.status === "measured"
      && row.raw.referent.kind === "memory_entry"
      && row.raw.referent.object_id === OBJECT_ID
    );
    expect(measured?.raw.status).toBe("measured");
    if (measured?.raw.status !== "measured") throw new Error("expected observeField retained measured raw");
    expect(Number.isFinite(measured.raw.raw as number)).toBe(true);
    expect(measured.raw.raw).toBe(1);
    expect(measured.cap.status).toBe("inapplicable");
    expect(measured.raw.raw).not.toBe(950);
    expect(digestOriginalQuery(QUERY_TEXT)).toBe(hashMemoryContent(QUERY_TEXT));
    expect(observed.measurements.every((row) =>
      row.raw.status !== "missing" || !("raw" in row.raw)
    )).toBe(true);
    expect(fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get())
      .toEqual(beforeGarden);
  });
});
