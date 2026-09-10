import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  SNAPSHOT_PIN_NATIVE_WORK
} from "@do-soul/alaya-protocol";
import {
  compileConditionalFieldQuery,
  snapshotIdFromPin
} from "@do-soul/alaya-core";
import { digestOriginalQuery } from "../../../../../../packages/core/src/recall/conditional-field/query/compile-query.js";
import {
  observeConditionalField,
  startObserverCursor
} from "../../../../../../packages/core/src/recall/conditional-field/observers/observe.js";
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
const MODEL_A = "model-a-old";
const MODEL_B = "model-b-new";
const QUERY_A = "aaaaaaaa-aaaa-4aaa-8aaa-000000000401";
const OBJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-000000000410";
const OBJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-000000000420";
const QUERY_B = "cccccccc-cccc-4ccc-8ccc-000000000430";
const EXTRA_B = [
  "dddddddd-dddd-4ddd-8ddd-000000000441",
  "dddddddd-dddd-4ddd-8ddd-000000000442",
  "dddddddd-dddd-4ddd-8ddd-000000000443",
  "dddddddd-dddd-4ddd-8ddd-000000000444"
] as const;
const NOW = "2026-09-06T12:00:00.000Z";
const WORKSPACE = "workspace-1";

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

  it("pins model B enumeration away from the lexicographically first model A profile", async () => {
    const { readers, fixture } = await plantMixedProfiles();
    const beforeGarden = fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get();
    const pinnedB = readers.embeddingIds!({
      workspaceId: WORKSPACE,
      afterObjectId: null,
      maxRows: 32,
      modelId: MODEL_B
    });
    expect(pinnedB.objectIds).toContain(OBJECT_B);
    expect(pinnedB.objectIds).toContain(QUERY_B);
    expect(pinnedB.objectIds).not.toContain(OBJECT_A);
    expect(pinnedB.objectIds).not.toContain(QUERY_A);
    expect(pinnedB.domainStatus).toBeUndefined();
    const pinnedA = readers.embeddingIds!({
      workspaceId: WORKSPACE,
      afterObjectId: null,
      maxRows: 32,
      modelId: MODEL_A
    });
    expect(pinnedA.objectIds).toContain(OBJECT_A);
    expect(pinnedA.objectIds).toContain(QUERY_A);
    expect(pinnedA.objectIds).not.toContain(OBJECT_B);
    expect(pinnedA.objectIds).not.toContain(QUERY_B);
    const observedB = observeWithReaders(readers, { model_id: MODEL_B });
    const measuredB = measuredObjectIds(observedB);
    expect(measuredB).toContain(OBJECT_B);
    expect(measuredB).not.toContain(OBJECT_A);
    expect(measuredB).not.toContain(QUERY_A);
    expect(observedB.measurements.every((row) => row.cap.status === "inapplicable")).toBe(true);
    const observedA = observeWithReaders(readers, { model_id: MODEL_A });
    const measuredA = measuredObjectIds(observedA);
    expect(measuredA).toContain(OBJECT_A);
    expect(measuredA).not.toContain(OBJECT_B);
    expect(measuredA).not.toContain(QUERY_B);
    expect(fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get())
      .toEqual(beforeGarden);
  });

  it("does not guess the min object_id profile when mixed embeddings have no request pin", async () => {
    const { readers, fixture } = await plantMixedProfiles();
    const beforeGarden = fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get();
    const unpinned = readers.embeddingIds!({
      workspaceId: WORKSPACE,
      afterObjectId: null,
      maxRows: 32
    });
    expect(unpinned.objectIds).toEqual([]);
    expect(unpinned.objectIds).not.toContain(QUERY_A);
    expect(unpinned.objectIds).not.toContain(OBJECT_A);
    expect(unpinned.domainStatus).toBe("unavailable");
    const observed = observeWithReaders(readers);
    expect(measuredObjectIds(observed)).toEqual([]);
    expect(observed.measurements.some((row) => row.raw.status === "unavailable")).toBe(true);
    expect(observed.measurements.every((row) => row.raw.status !== "missing")).toBe(true);
    expect(observed.residuals.some((region) =>
      region.kind === "binding" && region.status === "unknown"
    )).toBe(true);
    expect(fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get())
      .toEqual(beforeGarden);
  });

  it("keeps measurement native visits within work_limit", async () => {
    const { readers } = await plantMixedProfiles();
    const maxRows = 3;
    const page = readers.embeddingIds!({
      workspaceId: WORKSPACE,
      afterObjectId: null,
      maxRows,
      modelId: MODEL_B
    });
    expect(page.objectIds).toHaveLength(maxRows);
    expect(page.truncated).toBe(true);
    expect(page.rowVisits).toBe(maxRows + 1);
    expect(page.objectIds.every((id) => id !== QUERY_A && id !== OBJECT_A)).toBe(true);
    let pairCalls = 0;
    const counted = {
      ...readers,
      measureStoredPair: (input: Parameters<NonNullable<typeof readers.measureStoredPair>>[0]) => {
        pairCalls += 1;
        return readers.measureStoredPair!(input);
      }
    };
    const interpretation = compileForReaders(readers);
    const workLimit = 16;
    const innerLimit = workLimit - SNAPSHOT_PIN_NATIVE_WORK;
    const maxIdentities = Math.floor((innerLimit - 1) / 6);
    expect(maxIdentities).toBeGreaterThan(0);
    expect(maxIdentities).toBeLessThan(EXTRA_B.length + 2);
    const measured = observeConditionalField({
      lease: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        lease_id: "lease",
        snapshot_id: interpretation.snapshot_id,
        query_id: interpretation.query_id,
        status: "active"
      },
      action: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        action: "measurement",
        region_id: "binding",
        work_limit: workLimit
      },
      cursor: startObserverCursor({
        cursor_id: "binding",
        snapshot_id: interpretation.snapshot_id,
        query_id: interpretation.query_id,
        region_id: "binding"
      }),
      query: interpretation,
      workspace_id: WORKSPACE,
      readers: counted,
      seed_query: QUERY_TEXT,
      model_id: MODEL_B
    });
    expect(measured.page.observations.length).toBeLessThanOrEqual(maxIdentities);
    expect(pairCalls).toBe(measured.page.observations.length);
    expect(pairCalls).toBeLessThanOrEqual(maxIdentities);
    expect(measured.work.native_visits).toBeLessThanOrEqual(workLimit);
    expect(measured.work.native_visits).toBeGreaterThan(pairCalls);
    expect(measured.page.observations.every((row) =>
      row.object_id !== QUERY_A && row.object_id !== OBJECT_A
    )).toBe(true);
  });
});

type RecallFixture = Awaited<ReturnType<typeof createSourceBoundRecallFixture>>;

async function plantEmbedding(
  fixture: RecallFixture,
  objectId: string,
  content: string,
  modelId: string
): Promise<void> {
  await fixture.writeMemory(objectId, content, MemoryDimension.FACT);
  await fixture.storage.memoryEmbeddingRepo.upsert({
    object_id: objectId,
    workspace_id: WORKSPACE,
    content_hash: hashMemoryContent(content),
    provider_kind: "openai",
    model_id: modelId,
    schema_version: 1,
    dimensions: 2,
    embedding: new Float32Array([1, 0]),
    created_at: NOW,
    updated_at: NOW
  });
}

async function plantMixedProfiles() {
  const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
  fixture.storage.memoryEmbeddingRepo.prepareBoundedRecallIndex();
  await plantEmbedding(fixture, QUERY_A, QUERY_TEXT, MODEL_A);
  await plantEmbedding(fixture, OBJECT_A, "opaque archival payload a", MODEL_A);
  await plantEmbedding(fixture, OBJECT_B, "opaque archival payload b", MODEL_B);
  await plantEmbedding(fixture, QUERY_B, QUERY_TEXT, MODEL_B);
  for (const [index, objectId] of EXTRA_B.entries()) {
    await plantEmbedding(fixture, objectId, `opaque archival payload extra ${index}`, MODEL_B);
  }
  return { fixture, readers: createConditionalFieldObserverReaders(fixture.database) };
}

function compileForReaders(readers: ReturnType<typeof createConditionalFieldObserverReaders>) {
  const pin = readers.snapshotPin!(WORKSPACE);
  return compileConditionalFieldQuery({
    source: "ordinary",
    text: QUERY_TEXT,
    interpretation_clock: NOW,
    snapshot_id: snapshotIdFromPin(WORKSPACE, pin),
    budget: defaultBudget()
  });
}

function observeWithReaders(
  readers: ReturnType<typeof createConditionalFieldObserverReaders>,
  pin: Readonly<{ readonly model_id?: string }> = {}
) {
  return observeField(compileForReaders(readers), {
    workspace_id: WORKSPACE,
    query_text: QUERY_TEXT,
    budget: defaultBudget(),
    as_of: NOW,
    readers,
    ...pin
  });
}

function measuredObjectIds(observed: ReturnType<typeof observeField>): readonly string[] {
  return observed.measurements.flatMap((row) => {
    if (row.raw.status !== "measured" || row.raw.referent.kind !== "memory_entry") return [];
    return [row.raw.referent.object_id];
  });
}
