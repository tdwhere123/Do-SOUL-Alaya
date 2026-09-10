import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  type Continuation,
  type InformationIndex,
  type RequestBudget,
  type SourceEvidenceTarget
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { hydrateUtf8Chunk } from "../../../../memory/evidence-create/source-utf8-hydrate.js";
import {
  captureIndexPreviews,
  runConditionalFieldRecallWithReceipt,
  toSourceObserverRow,
  type ObserverReaders
} from "../../../../recall/recall-service.js";
import { RSS_SAMPLE_METHOD, type RequestActualCost } from "../../../../recall/runtime/request-cost-ledger.js";
import {
  FAR_FUTURE_EXPIRY,
  INTERPRETATION_CLOCK,
  LAST_WEEK_INSTANT,
  SNAPSHOT_ID,
  YESTERDAY_INSTANT,
  defaultBudget
} from "../reference/deployment.fixture.js";
import { MEM, WS, openSourceSlice } from "../vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

const QUERY = "find observed_log from x to y";
const CLOCK = "2026-09-07T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
const OVERSIZED = `needle ${"汉".repeat(80)}`;

describe("conditional-field actual request cost", () => {
  it("aggregates exclusive native work, phase timing, and RSS without double-charging", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantHub(slice, 3);
    const executed = recall(readersFor(slice), defaultBudget({ page_budget: 8 }));
    const actual = requireActual(executed.execution_receipt.actual);
    expect(actual.native_visits).toBeGreaterThan(0);
    expect(actual.native_visits).toBeLessThan(executed.execution_receipt.requested_budget.work_units);
    expect(sumExclusive(actual, "native_visits")).toBe(actual.native_visits);
    expect(sumExclusive(actual, "native_bytes")).toBe(actual.native_bytes);
    expect(sumExclusive(actual, "charged_retained_bytes")).toBe(actual.charged_retained_bytes);
    for (const phase of Object.values(actual.phases)) {
      expect(phase.exclusive_ms).toBeLessThanOrEqual(phase.inclusive_ms + 1e-6);
    }
    expect(actual.phases.observe.inclusive_ms + 1e-6)
      .toBeGreaterThanOrEqual(actual.phases.seed.inclusive_ms + actual.phases.adjacency.inclusive_ms);
    expect(actual.rss.method).toBe(RSS_SAMPLE_METHOD);
    expect(actual.rss.start_bytes).toBeGreaterThan(0);
    expect(actual.rss.after_projection_bytes).toBeGreaterThan(0);
  });

  it.each([0, 1])("rejects an unserviceable %i-unit request without a replayable cursor", (work_units) => {
    const readers: ObserverReaders = { lexical: () => { throw new Error("unserviceable"); } };
    const executed = recall(readers, defaultBudget({ work_units, finalization_reserve: 0, min_envelope: 0, page_budget: 1 }));
    expect(executed.index.entries).toEqual([]);
    expect(executed.index.continuation).toBeNull();
    expect(executed.index.completeness.logical_index).not.toBe("complete");
    const actual = requireActual(executed.execution_receipt.actual);
    expect(actual.native_visits).toBeLessThanOrEqual(work_units);
  });

  it("keeps a continuation when a tiny budget interrupts facet indexing", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantHub(slice, 24);
    const tiny = defaultBudget({ work_units: 12, finalization_reserve: 4, min_envelope: 0, page_budget: 1 });
    const first = recall(readersFor(slice), tiny);
    expect(first.index.continuation).not.toBeNull();
    const second = recall(readersFor(slice), tiny, first.index.continuation);
    expect(second.index.completeness.logical_index).not.toBe("invalidated");
    if (second.index.entries.length === 0) expect(second.index.continuation).not.toBeNull();
    const pages = collect(readersFor(slice), defaultBudget({
      work_units: 400, finalization_reserve: 40, min_envelope: 1, page_budget: 4
    }), 40, second.index);
    expect(pages.at(-1)!.continuation).toBeNull();
  });

  it("makes retained progress under a tiny serviceable budget then finishes on resume", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const ids = await plantHub(slice, 4);
    const tiny = defaultBudget({ work_units: 48, finalization_reserve: 12, min_envelope: 1, page_budget: 1 });
    const first = recall(readersFor(slice), tiny);
    expect(first.index.completeness.logical_index).not.toBe("complete");
    expect(first.index.continuation !== null || first.index.entries.length > 0).toBe(true);
    const pages = collect(
      readersFor(slice),
      defaultBudget({ work_units: 240, finalization_reserve: 40, min_envelope: 1, page_budget: 2 }),
      40,
      first.index
    );
    const delivered = new Set(pages.flatMap((page) => page.entries.map((entry) => entry.object_id ?? "")));
    expect(pages.at(-1)!.continuation).toBeNull();
    expect([...delivered].sort()).toEqual(expect.arrayContaining(ids.slice(1)));
  });

  it("delivers a hub and SCC from real SQLite without spinning", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const hub = await plantHub(slice, 3);
    const scc = await plantScc(slice);
    const budget = defaultBudget({ page_budget: 4, work_units: 240, finalization_reserve: 40, min_envelope: 1 });
    const first = recall(readersFor(slice), budget);
    const pages = collect(readersFor(slice), budget, 50, first.index);
    const ids = new Set(pages.flatMap((page) => page.entries.map((entry) => entry.object_id ?? "")));
    for (const id of [...hub.slice(1), scc[1]!]) expect(ids.has(id), id).toBe(true);
    expect(pages.length).toBeLessThan(50);
    expect(pages.at(-1)!.continuation).toBeNull();
  });

  it("delivers one diamond product without paying path-count work", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeploymentDiamond(slice);
    const budget = defaultBudget({ page_budget: 8, work_units: 10_000, finalization_reserve: 512 });
    const first = runConditionalFieldRecallWithReceipt({
      workspace_id: WS,
      query_text: "yesterday failed deployment",
      budget,
      result_kind_view: "memory_only",
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: INTERPRETATION_CLOCK,
      as_of: INTERPRETATION_CLOCK,
      expires_at: FAR_FUTURE_EXPIRY,
      readers: readersFor(slice)
    });
    const pages = collect(readersFor(slice), budget, 20, first.index, "yesterday failed deployment", INTERPRETATION_CLOCK);
    const hits = pages.flatMap((page) => page.entries.filter((entry) => entry.object_id === MEM.c));
    expect(new Set(hits.map((entry) => entry.object_id)).size).toBe(1);
    expect(hits[0]?.association_milligrades).toBe(1000);
    const actual = requireActual(first.execution_receipt.actual);
    expect(actual.phases.solve.relaxations).toBeLessThan(128);
    expect(actual.native_visits).toBeLessThan(256);
  });

  it("omits an oversized UTF-8 source chunk and resumes the next offset", () => {
    const firstChunk = hydrateUtf8Chunk(OVERSIZED, { offset: 0, byteLimit: 32 });
    expect(firstChunk.status).toBe("chunk");
    if (firstChunk.status !== "chunk") return;
    const target: SourceEvidenceTarget = {
      kind: "source_evidence",
      workspace_id: "workspace",
      root_kind: "source_record",
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null
    };
    const calls: Array<Readonly<{ offset?: number; byteLimit?: number }>> = [];
    const first = runConditionalFieldRecallWithReceipt({
      workspace_id: "workspace",
      query_text: "needle",
      budget: defaultBudget({ page_budget: 4 }),
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: INTERPRETATION_CLOCK,
      as_of: INTERPRETATION_CLOCK,
      expires_at: FAR_FUTURE_EXPIRY,
      result_kind_view: "source_only",
      readers: sourceReaders(calls, false)
    });
    const source = first.index.entries.find((entry) => entry.target.kind === "source_evidence");
    expect(source?.target.kind).toBe("source_evidence");
    if (source?.target.kind !== "source_evidence") return;
    expect(["omitted", "partial", "open"]).toContain(first.index.completeness.payload);
    expect(JSON.stringify(captureIndexPreviews(first.index, {}, "workspace"))).not.toContain("汉".repeat(40));
    const startOffset = source.target.span?.content_end ?? firstChunk.end_offset;
    calls.length = 0;
    const resumed = runConditionalFieldRecallWithReceipt({
      workspace_id: "workspace",
      query_text: "needle",
      budget: defaultBudget({ page_budget: 4 }),
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: INTERPRETATION_CLOCK,
      as_of: INTERPRETATION_CLOCK,
      expires_at: FAR_FUTURE_EXPIRY,
      result_kind_view: "source_only",
      payload_continuation: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        purpose: "payload_expansion",
        target,
        start_offset: startOffset,
        byte_budget: 32
      },
      readers: sourceReaders(calls, true)
    });
    expect(calls.some((call) => call.offset === startOffset)).toBe(true);
    const actual = requireActual(resumed.execution_receipt.actual);
    expect(actual.phases.payload.native_bytes).toBeGreaterThan(0);
    expect(actual.native_bytes).toBeGreaterThanOrEqual(actual.phases.payload.native_bytes);
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
    continuation
  });
}

function collect(
  readers: ObserverReaders,
  budget: RequestBudget,
  maximum: number,
  first: InformationIndex,
  query = QUERY,
  clock = CLOCK
): InformationIndex[] {
  const pages = [first];
  let continuation = first.continuation;
  for (let attempt = 0; attempt < maximum && continuation !== null; attempt += 1) {
    const next = runConditionalFieldRecallWithReceipt({
      workspace_id: WS,
      query_text: query,
      budget,
      result_kind_view: "memory_only",
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: clock,
      as_of: clock,
      expires_at: FAR_FUTURE_EXPIRY,
      readers,
      continuation
    });
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

function sourceReaders(
  calls: Array<Readonly<{ offset?: number; byteLimit?: number }>>,
  continued: boolean
): ObserverReaders {
  return {
    sourceRoots: () => ({
      rows: [{
        kind: "source_record" as const,
        workspace_id: "workspace",
        root_id: "rec-1",
        revision: "v1",
        digest: DIGEST,
        evidence_object_id: null,
        content: OVERSIZED,
        content_complete: false
      }],
      nativeVisits: 1,
      nativeBytes: 40,
      rowsRead: 1,
      bytesRead: 40,
      truncated: false
    }),
    sourceRoot: (input) => {
      const byteLimit = Math.min(input.byteLimit ?? 32, 32);
      calls.push({ offset: input.offset, byteLimit });
      const chunk = hydrateUtf8Chunk(OVERSIZED, {
        offset: input.offset ?? 0,
        byteLimit
      });
      if (chunk.status !== "chunk") {
        return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      }
      return {
        row: {
          kind: "source_record" as const,
          workspace_id: "workspace",
          root_id: "rec-1",
          revision: "v1",
          digest: DIGEST,
          evidence_object_id: null,
          content: chunk.text,
          content_complete: chunk.complete
        },
        rowsRead: 1,
        bytesRead: Buffer.byteLength(chunk.text, "utf8"),
        nativeWork: 5,
        unavailable: false,
        ...(chunk.complete || continued ? {} : { resourceLimited: true })
      };
    }
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
    await admit(slice, 200 + index, hub, id);
  }
  return ids;
}

async function plantDeploymentDiamond(slice: Awaited<ReturnType<typeof openSourceSlice>>): Promise<void> {
  await slice.writeMemory(MEM.r, "yesterday failed deployment of checkout", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.l, "deployment log for yesterday checkout failure", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.c, "last-week configuration change for checkout", MemoryDimension.FACT);
  stampObservedAt(slice, MEM.r, YESTERDAY_INSTANT);
  stampObservedAt(slice, MEM.l, YESTERDAY_INSTANT);
  stampObservedAt(slice, MEM.c, LAST_WEEK_INSTANT);
  const open = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
  const edges = [
    [301, MEM.r, MEM.l, "observed_log"],
    [302, MEM.l, MEM.c, "config_via_log"],
    [303, MEM.r, MEM.c, "config_direct"],
    [304, MEM.r, MEM.l, "failed_deployment"],
    [305, MEM.l, MEM.c, "associated_config"],
    [306, MEM.r, MEM.c, "associated_config"]
  ] as const;
  for (const [n, sourceId, targetId, relationKind] of edges) {
    await slice.admitRelation({
      evidenceId: ev(n),
      assertionId: `diamond-${n}`,
      sourceId,
      targetId,
      resultObjectId: targetId,
      relationKind,
      validity: open,
      gist: relationKind
    });
  }
}

function stampObservedAt(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  objectId: string,
  instant: string
): void {
  slice.database.connection.prepare(
    "UPDATE memory_entries SET event_time_start = ?, updated_at = ? WHERE object_id = ?"
  ).run(instant, instant, objectId);
}

async function plantScc(slice: Awaited<ReturnType<typeof openSourceSlice>>): Promise<string[]> {
  const a = mem(400);
  const b = mem(401);
  const c = mem(402);
  await slice.writeMemory(a, QUERY, MemoryDimension.FACT);
  await slice.writeMemory(b, "scc b", MemoryDimension.FACT);
  await slice.writeMemory(c, "scc c", MemoryDimension.FACT);
  await admit(slice, 401, a, b);
  await admit(slice, 402, b, c);
  await admit(slice, 403, c, a);
  return [a, b, c];
}

async function admit(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  n: number,
  sourceId: string,
  targetId: string
): Promise<void> {
  await slice.admitRelation({
    evidenceId: ev(n),
    assertionId: `observation-${n}`,
    sourceId,
    targetId,
    resultObjectId: targetId,
    relationKind: "observed_log",
    validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
    gist: "stored observation proof"
  });
}

function mem(n: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
}

function ev(n: number): string {
  return `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
}

function requireActual(actual: RequestActualCost | undefined): RequestActualCost {
  expect(actual).toBeDefined();
  return actual!;
}

function sumExclusive(actual: RequestActualCost, key: "native_visits" | "native_bytes" | "charged_retained_bytes"): number {
  return Object.values(actual.phases).reduce((sum, phase) => sum + phase[key], 0);
}
