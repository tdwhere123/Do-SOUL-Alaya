import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  SNAPSHOT_PIN_NATIVE_WORK,
  type StoredCosineAdmission,
  type StoredCosineObligation
} from "@do-soul/alaya-protocol";
import {
  capableRecallConsumerDeclaration,
  compileConditionalFieldQuery,
  RecallService,
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
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createSourceBoundRecallFixture, createTaskSurface } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
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
  it("delivers an admitted prepared measurement through a real worker RPC and keeps raw-only discovery out", async () => {
    const { fixture } = await plantMixedProfiles();
    const directory = await mkdtemp(join(tmpdir(), "alaya-prepared-measurement-rpc-"));
    const filename = join(directory, "source.sqlite");
    await fixture.database.connection.backup(filename);
    const worker = createRecallReadWorkerClient({ databaseFilename: filename, workerCount: 1,
      workerUrl: new URL("../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url) })!;
    try {
      await worker.ready();
      const service = new RecallService({ ...fixture.dependencies, now: () => NOW,
        readSnapshot: worker.readSnapshot, conditionalFieldPort: worker.conditionalFieldPort });
      const request = { ...capableRecallConsumerDeclaration(), workspaceId: WORKSPACE, taskSurface: { ...createTaskSurface(), display_name: QUERY_TEXT }, strategy: "chat" as const,
        budget: { ...defaultBudget(), work_units: 10000, memory_bytes: 1000000, page_budget: 64 } };
      const rawOnly = await service.recall(request);
      expect(rawOnly.index?.entries.some((entry) => entry.object_id === OBJECT_B)).toBe(false);
      const measured = await service.recall({ ...request, interpretation_proposal: { schema_version: 1,
        original_query_digest: digestOriginalQuery(QUERY_TEXT), producer_id: "alaya.query.proposal.core.v1",
        stored_cosine_admission: admission([MODEL_B]) } });
      const entry = measured.index?.entries.find((candidate) => candidate.object_id === OBJECT_B);
      expect(entry?.target).toMatchObject({ kind: "memory_entry", workspace_id: WORKSPACE, object_id: OBJECT_B });
      expect(measured.candidates.find((result) => result.object_id === OBJECT_B)?.target).toEqual(entry?.target);
      expect(measured.execution_receipt?.compile_input.interpretation_proposal?.stored_cosine_admission)
        .toEqual(admission([MODEL_B]));
    } finally {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
      authorized_scopes: null,
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
    expect(page.rowVisits).toBe(maxRows + 2);
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
      authorized_scopes: null,
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

  it("admits declared compatible soft products from several stored profiles without lexical hits", async () => {
    const { readers } = await plantMixedProfiles();
    const interpretation = compileForReaders(readers, admission([MODEL_A, MODEL_B]));
    const observed = observeField(interpretation, { workspace_id: WORKSPACE, query_text: QUERY_TEXT,
      budget: defaultBudget(), as_of: NOW, readers: withoutLexicalHits(readers),
      authorized_scopes: null });
    const objects = observed.seeds.filter((seed) => seed.state.target.kind === "memory_entry")
      .map((seed) => seed.state.target.kind === "memory_entry" ? seed.state.target.object_id : "");
    expect(objects).toContain(OBJECT_A);
    expect(objects, JSON.stringify({ cursor: observed.resume_cursors, status: observed.last_observer_status,
      residuals: observed.residuals, work: observed.remaining_exploration, measurements: observed.measurements.map((row) => row.raw) })).toContain(OBJECT_B);
    expect(observed.measurements.filter((row) => row.raw.status === "measured").map((row) =>
      row.raw.status === "measured" ? row.raw.model_id : "")).toEqual(expect.arrayContaining([MODEL_A, MODEL_B]));
    expect(observed.seeds.every((seed) => seed.milligrades === 1000)).toBe(true);
  });

  it("admits the declared maximum vector dimension when the shared request allowance can pay for both vectors", async () => {
    const { readers, fixture } = await plantMixedProfiles();
    const dimensions = 16384;
    const embedding = new Float32Array(dimensions);
    embedding[0] = 1;
    for (const [object_id, content] of [[OBJECT_B, "opaque archival payload b"], [QUERY_B, QUERY_TEXT]]) {
      await fixture.storage.memoryEmbeddingRepo.upsert({ object_id: object_id!, workspace_id: WORKSPACE,
        content_hash: hashMemoryContent(content!), provider_kind: "openai", model_id: MODEL_B, schema_version: 1,
        dimensions, embedding, created_at: NOW, updated_at: NOW });
    }
    const declaration = { ...admission([MODEL_B]), obligations: [{ ...obligation(MODEL_B), dimensions }] };
    const observed = observeField(compileForReaders(readers, declaration), { workspace_id: WORKSPACE,
      query_text: QUERY_TEXT, as_of: NOW, readers: withoutLexicalHits(readers),
      authorized_scopes: null,
      budget: { ...defaultBudget(), work_units: 100000, memory_bytes: 1000000 } });
    expect(observed.seeds.some((seed) => seed.state.target.kind === "memory_entry"
      && seed.state.target.object_id === OBJECT_B)).toBe(true);
  });

  it("does not borrow an old vector after canonical memory content changes", async () => {
    const { readers, fixture } = await plantMixedProfiles();
    fixture.database.connection.prepare("UPDATE memory_entries SET content = ? WHERE object_id = ?").run("changed source", OBJECT_B);
    const interpretation = compileForReaders(readers, admission([MODEL_B]));
    const observed = observeField(interpretation, { workspace_id: WORKSPACE, query_text: QUERY_TEXT,
      budget: defaultBudget(), as_of: NOW, readers: withoutLexicalHits(readers),
      authorized_scopes: null });
    expect(observed.seeds.some((seed) => seed.state.target.kind === "memory_entry" && seed.state.target.object_id === OBJECT_B)).toBe(false);
    expect(observed.measurements.some((row) => row.observation_id.includes(OBJECT_B) && row.raw.status === "unavailable")).toBe(true);
  });

  it("compares the raw threshold before projecting equal milligrade bins", async () => {
    const { readers, fixture } = await plantMixedProfiles();
    await fixture.storage.memoryEmbeddingRepo.upsert({ object_id: OBJECT_B, workspace_id: WORKSPACE,
      content_hash: hashMemoryContent("opaque archival payload b"), provider_kind: "openai", model_id: MODEL_B,
      schema_version: 1, dimensions: 2, embedding: new Float32Array([0.0000001, 1]), created_at: NOW, updated_at: NOW });
    const declaration = admission([MODEL_B], 0.000001);
    const observed = observeField(compileForReaders(readers, declaration), { workspace_id: WORKSPACE,
      query_text: QUERY_TEXT, budget: defaultBudget(), as_of: NOW, readers: withoutLexicalHits(readers),
      authorized_scopes: null });
    const measured = observed.measurements.find((row) => row.raw.status === "measured" && row.raw.referent.kind === "memory_entry"
      && row.raw.referent.object_id === OBJECT_B);
    expect(measured?.raw.status).toBe("measured");
    expect(measured?.cap.status).toBe("inapplicable");
    expect(observed.seeds.some((seed) => seed.state.target.kind === "memory_entry" && seed.state.target.object_id === OBJECT_B)).toBe(false);
  });

  it("refuses unaffordable declared vectors before body reads and keeps a retryable measurement cursor", async () => {
    const { readers } = await plantMixedProfiles();
    const profile = obligation(MODEL_B);
    const short = readers.measureStoredPair!({ workspaceId: WORKSPACE, objectId: OBJECT_B,
      queryDigest: digestOriginalQuery(QUERY_TEXT), profile, byteLimit: 8, workLimit: 100 });
    expect(short).toMatchObject({ resourceLimited: true, rowVisits: 0, bytesRead: 0 });
    const retry = readers.measureStoredPair!({ workspaceId: WORKSPACE, objectId: OBJECT_B,
      queryDigest: digestOriginalQuery(QUERY_TEXT), profile, byteLimit: 65536, workLimit: 100 });
    expect(retry.objectStatus).toBe("ready");
    expect(retry.queryStatus).toBe("ready");
  });

  it("admits an authorized prepared measurement after reading the actual source scope", async () => {
    const { readers } = await plantMixedProfiles();
    expect(readers.source!({ workspaceId: WORKSPACE, objectId: OBJECT_B }).row?.scope_class).toBe("project");
    const observed = observeField(compileForReaders(readers, admission([MODEL_B])), { workspace_id: WORKSPACE,
      query_text: QUERY_TEXT, budget: defaultBudget(), as_of: NOW, readers: withoutLexicalHits(readers),
      authorized_scopes: ["project"] });
    expect(observed.seeds.some((seed) => seed.state.target.kind === "memory_entry" && seed.state.target.object_id === OBJECT_B)).toBe(true);
  });

  it("does not promote an embedding discovery when its source program guard is false", async () => {
    const { readers } = await plantMixedProfiles();
    const pin = readers.snapshotPin!(WORKSPACE);
    const interpretation = compileConditionalFieldQuery({ source: "ordinary", text: QUERY_TEXT,
      interpretation_clock: NOW, snapshot_id: snapshotIdFromPin(WORKSPACE, pin), budget: defaultBudget(),
      interpretation_proposal: { schema_version: 1, original_query_digest: digestOriginalQuery(QUERY_TEXT),
        producer_id: "alaya.query.proposal.core.v1", stored_cosine_admission: admission([MODEL_B]),
        program: { schema_version: 1, kind: "relation", relation_kind: "observed_log", source_variable: "s", target_variable: "t",
          facet_mode: "same_path", threshold_milligrades: 0,
          guard: { schema_version: 1, kind: "query_predicate", verdict: "unresolved", variable: "s",
            predicate_name: "source.literal.nfc.v1", entity_id: "not-in-any-source" } } } });
    const observed = observeField(interpretation, { workspace_id: WORKSPACE, query_text: QUERY_TEXT,
      budget: defaultBudget(), as_of: NOW, readers: withoutLexicalHits(readers),
      authorized_scopes: null });
    expect(observed.measurements.some((row) => row.raw.status === "measured")).toBe(true);
    expect(observed.seeds.some((seed) => seed.state.target.kind === "memory_entry" && seed.state.target.object_id === OBJECT_B)).toBe(false);
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

function compileForReaders(readers: ReturnType<typeof createConditionalFieldObserverReaders>, declaration?: StoredCosineAdmission) {
  const pin = readers.snapshotPin!(WORKSPACE);
  return compileConditionalFieldQuery({
    source: "ordinary",
    text: QUERY_TEXT,
    interpretation_clock: NOW,
    snapshot_id: snapshotIdFromPin(WORKSPACE, pin),
    budget: defaultBudget()
    , ...(declaration === undefined ? {} : { interpretation_proposal: { schema_version: 1 as const,
      original_query_digest: digestOriginalQuery(QUERY_TEXT), producer_id: "alaya.query.proposal.core.v1",
      stored_cosine_admission: declaration } })
  });
}

function obligation(model: string, threshold = 0.5): StoredCosineObligation {
  return { obligation_id: model, producer_id: "stored.cosine.pair.v1", provider_kind: "openai", model_id: model,
    schema_version: 1, dimensions: 2, domain: "cosine.unit.v1", normalization: "l2.dot.v1", raw_threshold: threshold,
    transfer_id: "policy.cosine.linear.milligrade.v1", transfer_version: "1", policy_defined: true };
}

function admission(models: readonly string[], threshold = 0.5): StoredCosineAdmission {
  return { registry_version: "stored.cosine.admission.v1", join: "any", obligations: models.map((model) => obligation(model, threshold)) };
}

function withoutLexicalHits(readers: ReturnType<typeof createConditionalFieldObserverReaders>) {
  return { ...readers, sourceRoots: undefined, lexical: () => ({ ids: [], nativeVisits: 1, nativeBytes: 0,
    rowsRead: 0, bytesRead: 0, truncated: false }) };
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
    authorized_scopes: null,
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
