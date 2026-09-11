import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  type ObserverAction,
  type QueryInterpretation,
  type SnapshotReadLease
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { readBoundedEmbeddingIds } from "../../../../../../storage/src/repos/memory/reads/memory-embedding-bounded-read.js";
import {
  observeConditionalField,
  startObserverCursor,
  toSourceObserverRow,
  type ObserverReaders
} from "../../../../recall/conditional-field/observers/observe.js";
import {
  QUERY_ID,
  SNAPSHOT_ID,
  YESTERDAY_INSTANT,
  defaultView,
  yesterdayAnchorGuard
} from "../reference/deployment.fixture.js";
import { MEM, WS, openSourceSlice } from "../vertical/source-slice.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field observation revision lifecycle", () => {
  it("reserves native pin reads before tiny observer actions without advancing the cursor", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const native = readersFor(slice, false);
    const pin = vi.fn(native.snapshotPin!);
    const lexical = vi.fn(native.lexical!);
    const source = vi.fn(native.source!);
    const base = observeInput(slice, { action: action("seed", 2), seed_query: "needle",
      readers: { ...native, snapshotPin: pin, lexical, source } });
    const insufficient = observeConditionalField(base);
    expect(insufficient.page.outcome.status).toBe("interrupted");
    expect(insufficient.page.cursor).toEqual(base.cursor);
    expect(insufficient.work).toMatchObject({ work_units: 0, native_visits: 0 });
    expect(pin).not.toHaveBeenCalled();
    const pinOnly = observeConditionalField({ ...base, action: action("seed", 3) });
    expect(pinOnly.page.outcome.status).toBe("interrupted");
    expect(pinOnly.page.cursor).toEqual(base.cursor);
    expect(pinOnly.work).toMatchObject({ work_units: 3, native_visits: 3 });
    expect(pin).toHaveBeenCalledTimes(1);
    expect(lexical).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
  });

  it("emits source, relation, time, binding, and model effect fields", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const seed = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      seed_query: "failed deployment",
      model_id: "assoc.bottleneck.milligrade.v1"
    }));
    const row = seed.page.observations.find((observation) => observation.object_id === MEM.r);
    expect(row?.source_revision.length).toBeGreaterThan(0);
    expect(row?.observed_at).toBeDefined();
    expect(row?.binding_context).toContain("anchor=");
    expect(row?.model_id).toBe("assoc.bottleneck.milligrade.v1");
    const adjacency = observeConditionalField(observeInput(slice, {
      action: action("adjacency", 16),
      relation_subject: MEM.r,
      relation_kind: "observed_log",
      model_id: "assoc.bottleneck.milligrade.v1"
    }));
    const associated = adjacency.page.observations.find((observation) => observation.object_id === MEM.l);
    expect(associated?.relation_kind).toBe("observed_log");
    expect(associated?.binding_context).toContain("anchor=");
    expect(associated?.binding_context).toContain("r=");
    expect(associated?.observed_at).toBeDefined();
  });

  it("changes the observable pin when a relation is admitted", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await slice.writeMemory(MEM.r, "needle seed", MemoryDimension.FACT);
    await slice.writeMemory(MEM.c, "needle target", MemoryDimension.FACT);
    const before = slice.indexProjection.observablePin(WS);
    await slice.admitRelation({
      evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000201",
      assertionId: "assert-r-c",
      sourceId: MEM.r,
      targetId: MEM.c,
      resultObjectId: MEM.c,
      relationKind: "owns",
      validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
      gist: "owns"
    });
    const after = slice.indexProjection.observablePin(WS);
    expect(after.source_revision).not.toBe(before.source_revision);
  });

  it("invalidates resume when the pinned relation snapshot or model identity changes", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await slice.writeMemory(MEM.r, "needle seed", MemoryDimension.FACT);
    const pin = slice.indexProjection.observablePin(WS);
    const first = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      seed_query: "needle",
      expected_source_revision: pin.source_revision,
      model_id: "model-a",
      expected_model_id: "model-a"
    }));
    expect(first.page.outcome.status).not.toBe("invalidated");
    await slice.writeMemory(MEM.c, "needle target", MemoryDimension.FACT);
    await slice.admitRelation({
      evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000221",
      assertionId: "assert-changed",
      sourceId: MEM.r,
      targetId: MEM.c,
      resultObjectId: MEM.c,
      relationKind: "owns",
      validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
      gist: "owns"
    });
    const stale = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      cursor: first.page.cursor,
      seed_query: "needle",
      expected_source_revision: pin.source_revision,
      model_id: "model-a",
      expected_model_id: "model-a"
    }));
    expect(stale.page.outcome.status).toBe("invalidated");
    expect(stale.page.observations).toEqual([]);
    expect(stale.work).toMatchObject({ work_units: 3, native_visits: 3 });
    const mixedModel = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      seed_query: "needle",
      model_id: "model-b",
      expected_model_id: "model-a"
    }));
    expect(mixedModel.page.outcome.status).toBe("invalidated");
  });

  it("commits physical relation progress past an expired first assertion", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await slice.writeMemory(MEM.r, "needle seed", MemoryDimension.FACT);
    await slice.writeMemory(MEM.c, "expired target", MemoryDimension.FACT);
    await slice.writeMemory(MEM.l, "live target", MemoryDimension.FACT);
    await slice.admitRelation({
      evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000211",
      assertionId: "assert-expired",
      sourceId: MEM.r,
      targetId: MEM.c,
      resultObjectId: MEM.c,
      relationKind: "owns",
      validity: {
        kind: "bounded",
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_to: "2026-02-01T00:00:00.000Z"
      },
      gist: "expired"
    });
    await slice.admitRelation({
      evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000212",
      assertionId: "assert-live",
      sourceId: MEM.r,
      targetId: MEM.l,
      resultObjectId: MEM.l,
      relationKind: "owns",
      validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
      gist: "live"
    });
    const pages: string[] = [];
    let cursor = startObserverCursor({
      cursor_id: "adjacency",
      snapshot_id: SNAPSHOT_ID,
      query_id: QUERY_ID,
      region_id: "adjacency"
    });
    for (let step = 0; step < 8; step += 1) {
      const observed = observeConditionalField(observeInput(slice, {
        action: action("adjacency", 7),
        page_limit: 1,
        cursor,
        relation_subject: MEM.r,
        relation_kind: "owns",
        as_of: "2026-09-01T00:00:00.000Z"
      }));
      pages.push(...observed.page.observations.map((row) => row.object_id));
      expect(observed.page.cursor.committed_through).not.toBeNull();
      cursor = observed.page.cursor;
      if (observed.page.outcome.status === "exhausted") break;
    }
    expect(pages).toContain(MEM.l);
    expect(pages).not.toContain(MEM.c);
  });

  it("does not admit or skip an unavailable source hydration", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const ids = await plantNeedles(slice, 2);
    const query = interpretation();
    const observed = observeConditionalField({
      lease: lease(),
      action: action("seed", 8),
      cursor: startObserverCursor({
        cursor_id: "seed-cursor",
        snapshot_id: SNAPSHOT_ID,
        query_id: QUERY_ID,
        region_id: "seed"
      }),
      query,
      workspace_id: WS,
      seed_query: "needle",
      authorized_scopes: null,
      readers: {
        lexical: () => ({
          ids,
          nativeVisits: ids.length,
          nativeBytes: 8,
          rowsRead: ids.length,
          bytesRead: 8,
          truncated: false,
          committedThrough: ids[1] ?? null
        }),
        source: (input) => input.objectId === ids[0]
          ? { row: null, rowsRead: 1, bytesRead: 80, unavailable: true }
          : {
            row: {
              object_id: input.objectId,
              sourceRevision: "rev-2",
              observed_at: "2026-09-06T12:00:00.000Z",
              lifecycle_state: "active",
              scope_class: "project"
            },
            rowsRead: 1,
            bytesRead: 8,
            unavailable: false
          }
      }
    });
    expect(observed.page.observations).toEqual([]);
    expect(observed.page.outcome.status).toBe("unavailable");
    expect(observed.page.outcome.status).not.toBe("exhausted");
    expect(observed.page.cursor.committed_through).toBeNull();
    expect(observed.work.residual_work_units).toBeGreaterThan(0);
  });

  it("does not hydrate source bodies without a positive byte allowance", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantNeedles(slice, 2);
    const denied = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      seed_query: "needle",
      source_byte_limit: 0
    }));
    expect(denied.page.observations).toEqual([]);
    expect(denied.page.outcome.status).toBe("unavailable");
    expect(denied.page.cursor.committed_through).toBeNull();
  });

  it("skips tombstoned sources without admitting them as current observations", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const ids = await plantNeedles(slice, 2);
    slice.database.connection.prepare(
      "UPDATE memory_entries SET retention_state='tombstoned' WHERE object_id=?"
    ).run(ids[0]);
    const observed = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      seed_query: "needle"
    }));
    expect(observed.page.observations.map((row) => row.object_id)).toEqual([ids[1]]);
    expect(observed.page.observations.map((row) => row.object_id)).not.toContain(ids[0]);
  });

  it("keeps measurement presence without inventing a zero bound", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantNeedles(slice, 2);
    slice.storage.memoryEmbeddingRepo.prepareBoundedRecallIndex();
    for (const objectId of [
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000002"
    ]) {
      await slice.storage.memoryEmbeddingRepo.upsert({
        object_id: objectId,
        workspace_id: WS,
        content_hash: `sha256:${objectId}`,
        provider_kind: "openai",
        model_id: "text-embedding-3-small",
        schema_version: 1,
        dimensions: 3,
        embedding: new Float32Array([1, 0, 0]),
        created_at: "2026-09-06T00:00:00.000Z",
        updated_at: "2026-09-06T00:00:00.000Z"
      });
    }
    const measured = observeConditionalField(observeInput(slice, {
      action: action("measurement", 16),
      readers: readersFor(slice, true),
      model_id: "text-embedding-3-small",
      measurement_id: "embedding-presence"
    }));
    expect(measured.page.outcome.status).not.toBe("unavailable");
    expect(measured.page.observations.length).toBeGreaterThan(0);
    expect(measured.page.observations.every((observation) =>
      observation.association_milligrades === undefined
      && observation.model_id === "text-embedding-3-small"
      && observation.measurement_id === "embedding-presence"
    )).toBe(true);
  });
});

function observeInput(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  overrides: Partial<Parameters<typeof observeConditionalField>[0]> & {
    readonly action: ObserverAction;
  }
) {
  const query = overrides.query ?? interpretation();
  return {
    lease: overrides.lease ?? lease(),
    action: overrides.action,
    cursor: overrides.cursor ?? startObserverCursor({
      cursor_id: `${overrides.action.action}-cursor`,
      snapshot_id: SNAPSHOT_ID,
      query_id: QUERY_ID,
      region_id: overrides.action.region_id
    }),
    query,
    workspace_id: WS,
    readers: overrides.readers ?? readersFor(slice, false),
    seed_query: overrides.seed_query,
    relation_subject: overrides.relation_subject,
    relation_kind: overrides.relation_kind,
    authorized_scopes: overrides.authorized_scopes ?? null,
    anchor_object_ids: overrides.anchor_object_ids,
    object_observed_at: overrides.object_observed_at,
    page_limit: overrides.page_limit,
    as_of: overrides.as_of,
    model_id: overrides.model_id,
    measurement_id: overrides.measurement_id,
    expected_model_id: overrides.expected_model_id,
    expected_source_revision: overrides.expected_source_revision,
    source_byte_limit: overrides.source_byte_limit
  };
}

function readersFor(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  includeEmbeddings: boolean
): ObserverReaders {
  return {
    lexical: (input) => slice.memoryReader.lexical(
      input.workspaceId,
      input.query,
      input.limit,
      input.nativeLimit,
      input.afterObjectId
    ),
    source: (input) => {
      const page = slice.memoryReader.source(input.workspaceId, input.objectId, input.byteLimit);
      return {
        row: page.row === null ? null : toSourceObserverRow(page.row),
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        unavailable: page.unavailable
      };
    },
    relation: (input) => slice.relationReader.read(
      input.workspaceId,
      input.subject,
      input.predicate,
      input.limit,
      input.nativeLimit,
      input.afterAssertionId
    ),
    embeddingIds: includeEmbeddings
      ? (input) => readBoundedEmbeddingIds(slice.database, input.workspaceId, {
        providerKind: "openai",
        modelId: "text-embedding-3-small",
        schemaVersion: 1,
        maxRows: input.maxRows,
        maxMetadataUtf8Bytes: 256
      }, input.afterObjectId)
      : undefined,
    snapshotPin: (workspaceId) => slice.indexProjection.observablePin(workspaceId)
  };
}

function action(kind: ObserverAction["action"], workLimit: number): ObserverAction {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    action: kind,
    region_id: kind === "relation" ? "adjacency" : kind,
    work_limit: workLimit
  };
}

function lease(overrides: Partial<SnapshotReadLease> = {}): SnapshotReadLease {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    lease_id: "lease-1",
    snapshot_id: SNAPSHOT_ID,
    query_id: QUERY_ID,
    status: "active",
    ...overrides
  };
}

function interpretation(overrides: Partial<QueryInterpretation> = {}): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: QUERY_ID,
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program: overrides.program ?? {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "relation",
      relation_kind: "failed_deployment",
      source_variable: "anchor",
      target_variable: "r",
      guard: yesterdayAnchorGuard(),
      facet_mode: "same_path",
      threshold_milligrades: 0
    },
    view: defaultView(),
    holes: [],
    hypotheses: [],
    ...overrides
  };
}

async function plantNeedles(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  count: number
): Promise<readonly string[]> {
  const ids = Array.from({ length: count }, (_, index) =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`
  );
  for (const [index, objectId] of ids.entries()) {
    await slice.writeMemory(objectId, `needle item ${index + 1}`, MemoryDimension.FACT);
  }
  return ids;
}

async function plantDeployment(slice: Awaited<ReturnType<typeof openSourceSlice>>): Promise<void> {
  await slice.writeMemory(MEM.r, "yesterday failed deployment of checkout", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.l, "deployment log for yesterday checkout failure", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.c, "last-week configuration change for checkout", MemoryDimension.FACT);
  for (const objectId of [MEM.r, MEM.l, MEM.c]) {
    slice.database.connection.prepare(
      "UPDATE memory_entries SET event_time_start = ? WHERE object_id = ?"
    ).run(YESTERDAY_INSTANT, objectId);
  }
  const open = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000201",
    assertionId: "assert-r-l",
    sourceId: MEM.r,
    targetId: MEM.l,
    resultObjectId: MEM.l,
    relationKind: "observed_log",
    validity: open,
    gist: "log of yesterday failed deployment"
  });
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000203",
    assertionId: "assert-r-c",
    sourceId: MEM.r,
    targetId: MEM.c,
    resultObjectId: MEM.c,
    relationKind: "config_direct",
    validity: open,
    gist: "direct config association"
  });
}
