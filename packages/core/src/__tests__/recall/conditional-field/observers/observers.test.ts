import { afterEach, describe, expect, it } from "vitest";
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
  type ObserverReaders
} from "../../../../recall/conditional-field/observers/observe.js";
import {
  LAST_WEEK_INSTANT,
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

describe("conditional-field resumable observers", () => {
  it("concatenates advancing seed pages onto the finite pinned lexical domain", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const ids = await plantNeedles(slice, 8);
    const full = slice.memoryReader.lexical(WS, "needle", 16);
    expect(full.ids).toEqual(ids);
    const pages: string[] = [];
    let cursor = startObserverCursor({
      cursor_id: "seed-cursor",
      snapshot_id: SNAPSHOT_ID,
      query_id: QUERY_ID,
      region_id: "seed"
    });
    for (let step = 0; step < 8; step += 1) {
      const result = observeConditionalField(observeInput(slice, {
        action: action("seed", 512),
        cursor,
        seed_query: "needle",
        page_limit: 2
      }));
      pages.push(...result.page.observations.map((observation) => observation.object_id));
      cursor = result.page.cursor;
      if (result.page.outcome.status === "exhausted") break;
      expect(result.page.outcome.status).not.toBe("exhausted");
    }
    expect(pages).toEqual(full.ids);
    expect(pages).toEqual(ids);
  });

  it("maps native zero-row interrupts to interrupted/open and charges the visits", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantNeedles(slice, 8);
    const before = observeConditionalField(observeInput(slice, {
      action: action("seed", 0),
      seed_query: "needle"
    }));
    expect(before.page.observations).toEqual([]);
    expect(before.page.outcome.status).toBe("interrupted");
    expect(before.page.open_regions.some((region) => region.status === "open")).toBe(true);
    expect(before.page.outcome.status).not.toBe("exhausted");
    const during = observeConditionalField(observeInput(slice, {
      action: action("seed", 1),
      seed_query: "needle"
    }));
    expect(during.page.observations).toHaveLength(1);
    expect(during.page.outcome.status).toBe("open");
    expect(during.work.native_visits).toBe(1);
    expect(during.work.work_units).toBeGreaterThan(0);
    expect(during.page.cursor.committed_through).toBe(during.page.observations[0]?.object_id);
  });

  it("exhausts an empty authorized seed domain and keeps unopened channels", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const empty = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      seed_query: "needle"
    }));
    expect(empty.page.observations).toEqual([]);
    expect(empty.page.outcome.status).toBe("exhausted");
    expect(empty.page.open_regions.find((region) => region.kind === "seed")?.status).toBe("exhausted");
    expect(empty.page.open_regions.filter((region) => region.kind !== "seed")
      .every((region) => region.status === "open")).toBe(true);
  });

  it("commits the cursor only after observed identities and does not skip on retry", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const ids = await plantNeedles(slice, 4);
    const first = observeConditionalField(observeInput(slice, {
      action: action("seed", 512),
      seed_query: "needle",
      page_limit: 1
    }));
    expect(first.page.observations.map((observation) => observation.object_id)).toEqual([ids[0]]);
    expect(first.page.cursor.position).toBe(ids[0]);
    expect(first.page.cursor.committed_through).toBe(ids[0]);
    const retry = observeConditionalField(observeInput(slice, {
      action: action("seed", 512),
      cursor: first.page.cursor,
      seed_query: "needle",
      page_limit: 1
    }));
    expect(retry.page.observations.map((observation) => observation.object_id)).toEqual([ids[1]]);
    expect(retry.page.observations.map((observation) => observation.object_id)).not.toContain(ids[0]);
  });

  it("invalidates expired, mismatched, or revised snapshot leases", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantNeedles(slice, 2);
    const expired = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      seed_query: "needle",
      lease: lease({ status: "expired" })
    }));
    expect(expired.page.outcome.status).toBe("invalidated");
    expect(expired.page.observations).toEqual([]);
    const mismatched = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      seed_query: "needle",
      lease: lease({ snapshot_id: `sha256:${"e".repeat(64)}` })
    }));
    expect(mismatched.page.outcome.status).toBe("invalidated");
    expect(mismatched.page.cursor.committed_through).toBeNull();
  });

  it("keeps last-week associated config outside an event-local anchor interval", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const seed = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      seed_query: "failed deployment",
      anchor_object_ids: [MEM.r],
      object_observed_at: { [MEM.r]: YESTERDAY_INSTANT, [MEM.c]: LAST_WEEK_INSTANT }
    }));
    expect(seed.page.observations.some((observation) => observation.object_id === MEM.r)).toBe(true);
    const adjacency = observeConditionalField(observeInput(slice, {
      action: action("adjacency", 16),
      relation_subject: MEM.r,
      relation_kind: "config_direct",
      anchor_object_ids: [MEM.r],
      object_observed_at: { [MEM.r]: YESTERDAY_INSTANT, [MEM.c]: LAST_WEEK_INSTANT }
    }));
    expect(adjacency.page.observations.some((observation) => observation.object_id === MEM.c)).toBe(true);
    expect(adjacency.page.outcome.status).not.toBe("not_applicable");
  });

  it("keeps an unauthorized identity inaccessible on every seed page", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantNeedles(slice, 2);
    const deniedQuery = interpretation({
      program: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        kind: "relation",
        relation_kind: "failed_deployment",
        source_variable: "anchor",
        target_variable: "r",
        guard: {
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          kind: "authorization",
          verdict: "unresolved",
          authorization_scope: "secret"
        },
        facet_mode: "same_path",
        threshold_milligrades: 0
      }
    });
    const denied = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      seed_query: "needle",
      query: deniedQuery,
      authorized_scopes: ["public"]
    }));
    expect(denied.page.observations).toEqual([]);
    expect(denied.page.cursor.committed_through).not.toBeNull();
    const again = observeConditionalField(observeInput(slice, {
      action: action("seed", 16),
      cursor: denied.page.cursor,
      seed_query: "needle",
      query: deniedQuery,
      authorized_scopes: ["public"]
    }));
    expect(again.page.observations).toEqual([]);
  });

  it("concatenates relation pages and reports unavailable measurement without inventing zero", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const full = slice.relationReader.read(WS, MEM.r, "observed_log", 16);
    const pages: string[] = [];
    let cursor = startObserverCursor({
      cursor_id: "adj-cursor",
      snapshot_id: SNAPSHOT_ID,
      query_id: QUERY_ID,
      region_id: "adjacency"
    });
    for (let step = 0; step < 8; step += 1) {
      const result = observeConditionalField(observeInput(slice, {
        action: action("adjacency", 512),
        cursor,
        relation_subject: MEM.r,
        relation_kind: "observed_log",
        page_limit: 2
      }));
      pages.push(...result.page.observations.map((observation) => observation.object_id));
      cursor = result.page.cursor;
      if (result.page.outcome.status === "exhausted") break;
    }
    expect(pages).toEqual(full.observations.map((row) => row.targetObjectId));
    const measured = observeConditionalField(observeInput(slice, {
      action: action("measurement", 16)
    }));
    expect(measured.page.outcome.status).toBe("unavailable");
    expect(JSON.stringify(measured.page.observations)).not.toContain("\"association_milligrades\":0");
    expect(measured.page.outcome.status).not.toBe("exhausted");
  });

  it("enumerates embedding identities without minting a guaranteed bound", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantNeedles(slice, 4);
    slice.storage.memoryEmbeddingRepo.prepareBoundedRecallIndex();
    for (const objectId of [
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000003",
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000004"
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
    const pages: string[] = [];
    let cursor = startObserverCursor({
      cursor_id: "measure-cursor",
      snapshot_id: SNAPSHOT_ID,
      query_id: QUERY_ID,
      region_id: "measurement"
    });
    for (let step = 0; step < 8; step += 1) {
      const result = observeConditionalField(observeInput(slice, {
        action: action("measurement", 512),
        cursor,
        page_limit: 2,
        readers: readersFor(slice, true)
      }));
      expect(result.page.observations.every((observation) =>
        observation.association_milligrades === undefined
        && observation.low_milligrades === undefined
        && observation.high_milligrades === undefined
      )).toBe(true);
      pages.push(...result.page.observations.map((observation) => observation.object_id));
      cursor = result.page.cursor;
      if (result.page.outcome.status === "exhausted") break;
    }
    const full = readersFor(slice, true).embeddingIds?.({
      workspaceId: WS,
      afterObjectId: null,
      maxRows: 512
    });
    expect(pages).toEqual(full?.objectIds);
  });
});

function observeInput(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  overrides: Partial<Parameters<typeof observeConditionalField>[0]> & {
    readonly action: ObserverAction;
    readonly cursor?: Parameters<typeof observeConditionalField>[0]["cursor"];
    readonly seed_query?: string;
    readonly relation_subject?: string | null;
    readonly relation_kind?: string;
    readonly lease?: SnapshotReadLease;
    readonly query?: QueryInterpretation;
    readonly page_limit?: number;
    readonly readers?: ObserverReaders;
    readonly authorized_scopes?: readonly string[];
    readonly anchor_object_ids?: readonly string[];
    readonly object_observed_at?: Readonly<Record<string, string>>;
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
    authorized_scopes: overrides.authorized_scopes,
    anchor_object_ids: overrides.anchor_object_ids,
    object_observed_at: overrides.object_observed_at,
    page_limit: overrides.page_limit
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
      const page = slice.memoryReader.source(input.workspaceId, input.objectId);
      return {
        row: page.row === null
          ? null
          : {
            object_id: page.row.object_id,
            sourceRevision: page.row.sourceRevision,
            observed_at: page.row.event_time_start ?? undefined,
            content: page.row.content,
            lifecycle_state: page.row.lifecycle_state,
            retention_state: page.row.retention_state,
            scope_class: page.row.scope_class,
            evidence_refs: page.row.evidence_refs,
            valid_from: page.row.valid_from,
            valid_to: page.row.valid_to
          },
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
      : undefined
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
