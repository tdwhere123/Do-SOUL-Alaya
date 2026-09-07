import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  type InformationIndex,
  type QueryInterpretation
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { compileConditionalFieldQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import {
  observeConditionalField,
  startObserverCursor,
  toSourceObserverRow,
  type ObserverReaders
} from "../../../../recall/conditional-field/observers/observe.js";
import { runConditionalFieldRecall } from "../../../../recall/runtime/recall-service-runner.js";
import {
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget
} from "../reference/deployment.fixture.js";
import { MEM, WS, openSourceSlice } from "../vertical/source-slice.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("G3 snapshot, cursor, unavailable source, and continuation", () => {
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

  it("does not admit an unavailable source hydration as an observation", () => {
    const query = compileQuery("needle");
    const observed = observeConditionalField({
      lease: activeLease(query),
      action: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        action: "seed",
        region_id: "seed",
        work_limit: 1
      },
      cursor: startObserverCursor({
        cursor_id: "seed",
        snapshot_id: query.snapshot_id,
        query_id: query.query_id,
        region_id: "seed"
      }),
      query,
      workspace_id: WS,
      seed_query: "needle",
      readers: {
        lexical: () => ({
          ids: ["missing"],
          nativeVisits: 1,
          nativeBytes: 9,
          rowsRead: 1,
          bytesRead: 9,
          truncated: false
        }),
        source: () => ({ row: null, rowsRead: 0, bytesRead: 0, unavailable: true })
      }
    });
    expect(observed.page.observations).toEqual([]);
    expect(observed.page.outcome.status).toBe("unavailable");
    expect(observed.page.outcome.status).not.toBe("exhausted");
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
    const query = compileQuery("needle");
    let cursor = startObserverCursor({
      cursor_id: "adjacency",
      snapshot_id: query.snapshot_id,
      query_id: query.query_id,
      region_id: "adjacency"
    });
    const pages: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      const observed = observeConditionalField({
        lease: activeLease(query),
        action: {
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          action: "adjacency",
          region_id: "adjacency",
          work_limit: 1
        },
        cursor,
        query,
        workspace_id: WS,
        as_of: "2026-09-01T00:00:00.000Z",
        relation_subject: MEM.r,
        relation_kind: "owns",
        readers: readersFor(slice)
      });
      pages.push(...observed.page.observations.map((row) => row.object_id));
      expect(observed.page.cursor.committed_through).not.toBeNull();
      cursor = observed.page.cursor;
      if (observed.page.outcome.status === "exhausted") break;
    }
    expect(pages).toContain(MEM.l);
    expect(pages).not.toContain(MEM.c);
  });

  it("concatenates every page of six complete matches against uninterrupted enumeration", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const ids = await plantNeedles(slice, 6, 901);
    const full = runRecall(slice, { page_budget: 100 });
    expect(full.entries.map((entry) => entry.object_id).sort()).toEqual([...ids].sort());
    const pages: InformationIndex[] = [];
    let continuation: InformationIndex["continuation"] = null;
    for (let step = 0; step < 8; step += 1) {
      const page = runRecall(slice, { page_budget: 2, continuation });
      pages.push(page);
      continuation = page.continuation;
      if (continuation === null) break;
    }
    expect(pages.flatMap((page) => page.entries).map((entry) => entry.object_id))
      .toEqual(full.entries.map((entry) => entry.object_id));
    expect(pages.some((page) => page.entries.length === 0)).toBe(false);
  });

  it("continues interrupted observation without skipping already-read identities", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantNeedles(slice, 6, 921);
    const tight = defaultBudget({
      work_units: 20,
      finalization_reserve: 5,
      min_envelope: 1,
      page_budget: 1
    });
    const full = runRecall(slice, { page_budget: 100 });
    const pages: InformationIndex[] = [];
    let continuation: InformationIndex["continuation"] = null;
    for (let step = 0; step < 12; step += 1) {
      const page = runRecall(slice, { budget: tight, continuation });
      pages.push(page);
      continuation = page.continuation;
      if (continuation === null) break;
    }
    const concatenated = pages.flatMap((page) => page.entries).map((entry) => entry.object_id);
    expect(new Set(concatenated).size).toBe(concatenated.length);
    expect(concatenated).toEqual(full.entries.map((entry) => entry.object_id).slice(0, concatenated.length));
    if (full.entries.length > 1 && concatenated.length > 1) {
      expect(concatenated[1]).toBe(full.entries[1]?.object_id);
    }
  });
});

function compileQuery(text: string): QueryInterpretation {
  return compileConditionalFieldQuery({
    source: "ordinary",
    text,
    snapshot_id: SNAPSHOT_ID,
    budget: defaultBudget(),
    interpretation_clock: INTERPRETATION_CLOCK
  });
}

function activeLease(query: QueryInterpretation) {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    lease_id: "lease",
    snapshot_id: query.snapshot_id,
    query_id: query.query_id,
    status: "active" as const
  };
}

function runRecall(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  input: Readonly<{
    readonly page_budget?: number;
    readonly continuation?: InformationIndex["continuation"];
    readonly budget?: ReturnType<typeof defaultBudget>;
  }>
): InformationIndex {
  return runConditionalFieldRecall({
    workspace_id: WS,
    query_text: "needle",
    budget: input.budget ?? defaultBudget({ page_budget: input.page_budget ?? 2 }),
    snapshot_id: SNAPSHOT_ID,
    interpretation_clock: INTERPRETATION_CLOCK,
    as_of: INTERPRETATION_CLOCK,
    expires_at: "2099-01-01T00:00:00.000Z",
    readers: readersFor(slice),
    continuation: input.continuation ?? null
  });
}

function readersFor(slice: Awaited<ReturnType<typeof openSourceSlice>>): ObserverReaders {
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
    snapshotPin: (workspaceId) => slice.indexProjection.observablePin(workspaceId)
  };
}

async function plantNeedles(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  count: number,
  start: number
): Promise<readonly string[]> {
  const ids = Array.from({ length: count }, (_, index) =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${String(start + index).padStart(12, "0")}`
  );
  for (const [index, objectId] of ids.entries()) {
    await slice.writeMemory(objectId, `needle item ${index + 1}`, MemoryDimension.FACT);
  }
  return ids;
}
