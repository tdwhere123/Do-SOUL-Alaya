import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension, type Continuation, type InformationIndex, type RequestBudget } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import {
  runConditionalFieldRecallWithReceipt,
  toSourceObserverRow,
  type ObserverReaders
} from "../../../../recall/recall-service.js";
import { FAR_FUTURE_EXPIRY, SNAPSHOT_ID, defaultBudget } from "../reference/deployment.fixture.js";
import { WS, openSourceSlice } from "../vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

const QUERY = "find observed_log from x to y";
const CLOCK = "2026-09-07T00:00:00.000Z";

describe("runner facet hold does not trap a truncated-open index", () => {
  it("keeps continuation while payload hold zeros the facet cap, then emits once the index completes", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const ids = await plantHub(slice, 24);
    const readers = readersFor(slice);
    // Runner always installs payload_work_per_entry: 5, so hold = min(page_budget, n) * 6.
    // page_budget 800 with 24 spokes zeros cap against this remaining reserve.
    const starved = defaultBudget({
      work_units: 64,
      finalization_reserve: 6,
      min_envelope: 0,
      page_budget: 800
    });
    const first = recall(readers, starved);
    expect(first.index.entries).toEqual([]);
    expect(first.index.completeness.logical_index).toBe("open");
    expect(first.index.continuation).not.toBeNull();

    const starvedPages = collect(readers, starved, 48, first.index);
    const delivered = new Set(starvedPages.flatMap((page) => page.entries.map((entry) => entry.object_id ?? "")));
    for (const page of starvedPages) {
      if (delivered.size === 0) {
        expect(page.completeness.logical_index).toBe("open");
        expect(page.continuation, JSON.stringify(page.completeness)).not.toBeNull();
      }
    }

    const ample = defaultBudget({
      work_units: 400,
      finalization_reserve: 40,
      min_envelope: 1,
      page_budget: 4
    });
    const seed = starvedPages.at(-1) ?? first.index;
    const pages = seed.continuation === null ? starvedPages : collect(readers, ample, 40, seed);
    const members = new Set(pages.flatMap((page) => page.entries.map((entry) => entry.object_id ?? "")));
    expect([...members]).toEqual(expect.arrayContaining(ids.slice(1)));
  });
});

function recall(readers: ObserverReaders, budget: RequestBudget, continuation: Continuation | null = null) {
  return runConditionalFieldRecallWithReceipt({
    workspace_id: WS,
    query_text: QUERY,
    budget,
    result_kind_view: "memory_only",
    snapshot_id: SNAPSHOT_ID,
    interpretation_clock: CLOCK,
    as_of: CLOCK,
    expires_at: FAR_FUTURE_EXPIRY,
    readers,
    continuation,
    authorized_scopes: null
  });
}

function collect(
  readers: ObserverReaders,
  budget: RequestBudget,
  maximum: number,
  first: InformationIndex
): InformationIndex[] {
  const pages = [first];
  let continuation = first.continuation;
  for (let attempt = 0; attempt < maximum && continuation !== null; attempt += 1) {
    const next = recall(readers, budget, continuation);
    pages.push(next.index);
    continuation = next.index.continuation;
  }
  return pages;
}

function readersFor(slice: Awaited<ReturnType<typeof openSourceSlice>>): ObserverReaders {
  const kindsSql = slice.database.connection.prepare(
    `SELECT DISTINCT relation_kind AS kind FROM relation_assertions
     WHERE workspace_id = ?
       AND (? IS NULL OR lower(json_extract(anchors_json, '$.source_anchor.object_id')) = ?)`
  );
  return {
    lexical: (input) => slice.memoryReader.lexical(
      input.workspaceId, input.query, input.limit, input.nativeLimit, input.afterObjectId
    ),
    source: (input) => {
      const page = slice.memoryReader.source(input.workspaceId, input.objectId);
      return { ...page, row: page.row === null ? null : toSourceObserverRow(page.row) };
    },
    relation: (input) => slice.relationReader.read(
      input.workspaceId, input.subject, input.predicate, input.limit, input.nativeLimit,
      input.afterAssertionId
    ),
    relationKinds: (input) => {
      const subject = input.subject === null ? null : input.subject.toLowerCase();
      return (kindsSql.all(input.workspaceId, subject, subject) as { readonly kind: string }[])
        .map((row) => row.kind);
    },
    snapshotPin: (workspaceId) => slice.indexProjection.observablePin(workspaceId)
  };
}

async function plantHub(slice: Awaited<ReturnType<typeof openSourceSlice>>, spokes: number): Promise<string[]> {
  const hub = mem(200);
  await slice.writeMemory(hub, QUERY, MemoryDimension.FACT);
  const ids = [hub];
  for (let index = 1; index <= spokes; index += 1) {
    const id = mem(200 + index);
    ids.push(id);
    await slice.writeMemory(id, `hub spoke ${index}`, MemoryDimension.FACT);
    await slice.admitRelation({
      evidenceId: ev(200 + index),
      assertionId: `observation-${200 + index}`,
      sourceId: hub,
      targetId: id,
      resultObjectId: id,
      relationKind: "observed_log",
      validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
      gist: "stored observation proof"
    });
  }
  return ids;
}

function mem(n: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
}

function ev(n: number): string {
  return `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
}
