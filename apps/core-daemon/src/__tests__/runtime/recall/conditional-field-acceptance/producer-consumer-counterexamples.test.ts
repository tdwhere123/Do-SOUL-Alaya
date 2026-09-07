import { afterEach, describe, expect, it } from "vitest";
import { CONDITIONAL_FIELD_SCHEMA_VERSION, MemoryDimension, ScopeClass } from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { encodeIndexResults, frameEncodedIndex } from "../../../../mcp-memory/recall/recall-result.js";
import {
  MEM,
  WS,
  countingReaders,
  defaultBudget,
  openBoundSlice,
  plantDeployment,
  plantNeedles,
  readersFor,
  recallThroughHandler,
  runRecall,
  setScope,
  tombstone,
  type SourceSlice
} from "./planted-handler.js";

const databases = new Set<StorageDatabase>();
const OPEN = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
const SECRET = "aaaaaaaa-aaaa-4aaa-8aaa-000000000311";
const GLOBAL = "aaaaaaaa-aaaa-4aaa-8aaa-000000000312";
const EXPIRED = "aaaaaaaa-aaaa-4aaa-8aaa-000000000313";

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field MCP/CLI F1-F7 producer-consumer counterexamples", () => {
  it("F1 ordinary programs do not collapse to one field", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const failed = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    const rules = await recallThroughHandler(slice, { query: "deployment rules", max_results: 800 });
    const emptyish = runRecall(slice, { query_text: "" });
    expect(failed.index.query_id).not.toBe(rules.index.query_id);
    expect(failed.index.entries.map(entryId)).not.toEqual(rules.index.entries.map(entryId));
    const collapsed = emptyish.completeness.logical_index === failed.index.completeness.logical_index
      && JSON.stringify(emptyish.entries) === JSON.stringify(failed.index.entries);
    expect(collapsed).toBe(false);
  });


  it("F1 public dimension and absent domain tags do not return every fact", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const dimension = await recallThroughHandler(slice, {
      query: "checkout",
      max_results: 800,
      dimension: MemoryDimension.EPISODE
    });
    expect(dimension.results.every((row) => row.object_id !== MEM.u)).toBe(true);
    const tagged = await recallThroughHandler(slice, {
      query: "checkout",
      max_results: 800,
      domain_tags: ["absent-tag"]
    });
    expect(tagged.results).toEqual([]);
  });

  it("F2 tombstone, scope, and expired relation are excluded through the handler", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantGovernedExtras(slice);
    const mcp = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    const ids = mcp.index.entries.map((entry) => entry.object_id);
    expect(ids).not.toContain(SECRET);
    expect(ids).not.toContain(EXPIRED);
    expect(mcp.results.some((result) => /secret deployment leftover/i.test(result.content_preview))).toBe(false);
    const scoped = runRecall(slice, { authorized_scopes: [ScopeClass.PROJECT] });
    expect(scoped.entries.map((entry) => entry.object_id)).not.toContain(GLOBAL);
  });

  it("F3 handler explanations do not copy another object's witnesses", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    await plantNeedles(slice, 4, 951);
    const mcp = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    const needles = await recallThroughHandler(slice, { query: "needle", max_results: 800 });
    expect(needles.index.entries.length).toBeGreaterThan(0);
    expect(needles.index.entries.some((entry) => entry.claim === "unknown")).toBe(true);
    for (const left of [...mcp.index.entries, ...needles.index.entries]) {
      for (const right of [...mcp.index.entries, ...needles.index.entries]) {
        if (left.object_id === right.object_id) continue;
        const leaked = left.explanation_ids.filter((id) => right.explanation_ids.includes(id)
          && id !== left.object_id && id !== right.object_id);
        expect(leaked).toEqual([]);
      }
    }
  });

  it("F4 paged 32-cap observation concatenates without skip or duplicate", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantNeedles(slice, 40, 701);
    const full = await recallThroughHandler(slice, { query: "needle", max_results: 800 });
    const pages: string[][] = [];
    let continuation = null as typeof full.index.continuation;
    for (let step = 0; step < 16; step += 1) {
      const page = await recallThroughHandler(slice, {
        query: "needle",
        max_results: 8,
        continuation
      });
      pages.push(page.index.entries.map(entryId));
      continuation = page.index.continuation;
      if (continuation === null) break;
    }
    const concatenated = pages.flat();
    expect(new Set(concatenated).size).toBe(concatenated.length);
    expect(concatenated).toEqual(full.index.entries.map(entryId));
  });

  it("F5 handler encoding does not freeze token_estimate at 1 for long previews", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantNeedles(slice, 8, 801);
    const counted = countingReaders(slice);
    const tight = runRecall(slice, {
      query_text: "needle",
      budget: defaultBudget({
        work_units: 101,
        finalization_reserve: 100,
        min_envelope: 1,
        page_budget: 800
      }),
      readers: counted.readers
    });
    expect(counted.counters.nativeVisits).toBeLessThanOrEqual(101);
    const tiny = runRecall(slice, {
      query_text: "needle",
      budget: defaultBudget({
        work_units: 10_000,
        memory_bytes: 1,
        min_envelope: 1,
        page_budget: 800
      })
    });
    expect(tiny.completeness.logical_index === "complete" && tiny.entries.length >= 31).toBe(false);
    const long = "y".repeat(1400);
    const encoded = encodeIndexResults(tight, new Map(tight.entries.map((entry) => [entry.object_id, long])));
    if (encoded.length > 0) {
      expect(encoded.every((row) => row.budget_state.token_estimate === 1)).toBe(false);
      expect(Math.max(...encoded.map((row) => row.budget_state.token_estimate))).toBeGreaterThan(1);
    }
  });

  it("F5 encoding stops before the advertised token cap", () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      object_id: `obj-${String(index).padStart(2, "0")}`,
      hypothesis_id: "h0",
      output_binding: "hit",
      role: "associated" as const,
      association_milligrades: 800,
      claim: "unknown" as const,
      explanation_ids: []
    }));
    const index = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: "probe",
      snapshot_id: `sha256:${"a".repeat(64)}`,
      result_version: "v1",
      entries,
      completeness: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        logical_index: "complete" as const,
        observed_coverage: "complete" as const,
        transport: "complete" as const,
        payload: "complete" as const,
        representation: "complete" as const
      },
      continuation: null,
      representation: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        policy: "construct_index_then_page_then_payload" as const,
        page_budget: 800,
        identity_tie_break: "serialization" as const
      }
    };
    const preview = "x".repeat(160);
    const encoded = encodeIndexResults(
      index,
      new Map(entries.map((entry) => [entry.object_id, preview])),
      2_000
    );
    const framed = frameEncodedIndex(index, encoded);
    const previewBytes = encoded.reduce((sum, row) => sum + Buffer.byteLength(row.content_preview, "utf8"), 0);
    expect(encoded.length).toBeLessThan(30);
    expect(previewBytes).toBeLessThanOrEqual(2_000);
    expect(encoded.every((row) => row.budget_state.within_budget)).toBe(true);
    expect(framed.completeness.payload).toBe("omitted");
    expect(framed.completeness.transport).toBe("partial");
    expect(framed.completeness.logical_index).toBe("complete");
  });

  it("F6 handler previews are not mixed with a later source generation", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const mcp = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    const before = new Map(mcp.results.map((result) => [result.object_id, result.content_preview]));
    slice.database.connection.prepare(
      "UPDATE memory_entries SET content = ? WHERE object_id = ?"
    ).run("content-after mixed generation", MEM.r);
    const again = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800,
      continuation: mcp.index.continuation
    });
    if (again.index.completeness.observed_coverage === "invalidated") {
      expect(again.index.completeness.logical_index).not.toBe("complete");
    } else if (mcp.index.continuation === null) {
      const mixed = again.results.some((result) => result.object_id === MEM.r
        && result.content_preview.includes("content-after")
        && (before.get(MEM.r) ?? "").includes("yesterday failed"));
      expect(mixed).toBe(false);
    }
  });

  it("F7 midnight continuation is not a spliced two-day page", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantNeedles(slice, 8, 931);
    const evening = await recallThroughHandler(slice, {
      query: "needle",
      max_results: 1,
      now: "2026-09-05T23:59:59.000Z"
    });
    const morning = await recallThroughHandler(slice, {
      query: "needle",
      max_results: 1,
      now: "2026-09-06T00:00:01.000Z",
      continuation: evening.index.continuation
    });
    const invalidated = morning.index.completeness.observed_coverage === "invalidated";
    const sameInstance = morning.index.query_id === evening.index.query_id
      && morning.index.snapshot_id === evening.index.snapshot_id;
    expect(invalidated || sameInstance).toBe(true);
    if (invalidated) {
      expect(morning.index.completeness.logical_index).not.toBe("complete");
    }
  });
});

function entryId(entry: { readonly object_id: string; readonly hypothesis_id: string; readonly output_binding: string }): string {
  return `${entry.hypothesis_id}\0${entry.output_binding}\0${entry.object_id}`;
}

async function plantGovernedExtras(slice: SourceSlice): Promise<void> {
  await plantDeployment(slice);
  await slice.writeMemory(SECRET, "secret deployment leftover", MemoryDimension.FACT);
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000311",
    assertionId: "assert-r-secret-accept",
    sourceId: MEM.r,
    targetId: SECRET,
    resultObjectId: SECRET,
    relationKind: "observed_log",
    validity: OPEN,
    gist: "secret"
  });
  tombstone(slice, SECRET);
  await slice.writeMemory(GLOBAL, "yesterday failed deployment global_core copy", MemoryDimension.EPISODE);
  setScope(slice, GLOBAL, ScopeClass.GLOBAL_CORE);
  await slice.writeMemory(EXPIRED, "expired relation target from yesterday failed deployment", MemoryDimension.FACT);
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000313",
    assertionId: "assert-r-expired-accept",
    sourceId: MEM.r,
    targetId: EXPIRED,
    resultObjectId: EXPIRED,
    relationKind: "observed_log",
    validity: {
      kind: "bounded",
      valid_from: "2020-01-01T00:00:00.000Z",
      valid_to: "2020-12-31T00:00:00.000Z"
    },
    gist: "expired"
  });
}
