import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  ScopeClass,
  type QueryProgram
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { MEM, WS } from "../conditional-field/vertical/source-slice.js";
import {
  countingReaders,
  encodedRecall,
  indexFromObserved,
  observeProgram,
  openBoundSlice,
  plantDeployment,
  plantNeedles,
  readersFor,
  runRecall,
  setContent,
  setScope,
  tombstone,
  type SourceSlice
} from "./bound-producer.js";
import { defaultBudget } from "./finite-worlds.js";

const databases = new Set<StorageDatabase>();
const OPEN = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
const SEED = "aaaaaaaa-aaaa-4aaa-8aaa-000000000401";
const MIDDLE = "aaaaaaaa-aaaa-4aaa-8aaa-000000000402";
const END = "aaaaaaaa-aaaa-4aaa-8aaa-000000000403";
const SECRET = "aaaaaaaa-aaaa-4aaa-8aaa-000000000301";
const GLOBAL = "aaaaaaaa-aaaa-4aaa-8aaa-000000000302";
const EXPIRED = "aaaaaaaa-aaaa-4aaa-8aaa-000000000303";
const CONFLICT = "aaaaaaaa-aaaa-4aaa-8aaa-000000000304";

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field producer-consumer counterexamples", () => {
  it("F1 program variants differ on the same planted graph", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantChain(slice);
    const epsilon = grades(observeProgram(slice, { schema_version: 1, kind: "epsilon" }, { query_text: "seed" }));
    const empty = grades(observeProgram(slice, { schema_version: 1, kind: "empty" }, { query_text: "seed" }));
    const forward = grades(observeProgram(slice, sequence("observed_log", "config_via_log"), { query_text: "seed" }));
    const reversed = grades(observeProgram(slice, sequence("config_via_log", "observed_log"), { query_text: "seed" }));
    const blocked = grades(observeProgram(slice, sequence("observed_log", "config_via_log", "false"), { query_text: "seed" }));
    const incompleteAnd = grades(observeProgram(slice, {
      schema_version: 1,
      kind: "hyperedge",
      join: "and",
      premises: [relation("observed_log"), relation("uses_service")]
    }, { query_text: "seed" }));
    expect(epsilon).not.toEqual(empty);
    expect(forward).not.toEqual(reversed);
    expect(forward).not.toEqual(blocked);
    expect(forward).not.toEqual(incompleteAnd);
    expect(empty[`${SEED}:accepting`] ?? 0).toBe(0);
    expect(blocked[`${END}:accepting`] ?? 0).toBe(0);
    expect(incompleteAnd[`${END}:accepting`] ?? 0).toBe(0);
  });

  it("F2 tombstone, scope, and expired relation stay out of seed/intermediate/target/preview", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    await slice.writeMemory(SECRET, "secret deployment leftover", MemoryDimension.FACT);
    await slice.admitRelation({
      evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000301",
      assertionId: "assert-r-secret",
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
      evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000303",
      assertionId: "assert-r-expired",
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
    const index = runRecall(slice, { authorized_scopes: [ScopeClass.PROJECT] });
    const ids = index.entries.map((entry) => entry.object_id);
    expect(ids).not.toContain(SECRET);
    expect(ids).not.toContain(GLOBAL);
    expect(ids).not.toContain(EXPIRED);
    const encoded = encodedRecall(index, previewsFrom(slice, ids));
    const texts = encoded.candidates.map((candidate) => candidate.content_preview);
    expect(texts.some((text) => /secret deployment leftover/i.test(text))).toBe(false);
  });

  it("F3 support, conflict, unknown, and no cross-object witness", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    await slice.writeMemory(CONFLICT, "yesterday failed deployment contradicted copy", MemoryDimension.EPISODE);
    await slice.admitRelation({
      evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000304",
      assertionId: "assert-r-conflict",
      sourceId: MEM.r,
      targetId: CONFLICT,
      resultObjectId: CONFLICT,
      relationKind: "contradicts",
      validity: OPEN,
      gist: "contradicts"
    });
    await plantNeedles(slice, 4, 941);
    const index = runRecall(slice);
    const needles = runRecall(slice, { query_text: "needle" });
    const witnesses = [...index.entries, ...needles.entries];
    for (const left of witnesses) {
      for (const right of witnesses) {
        if (left.object_id === right.object_id) continue;
        const leaked = left.explanation_ids.filter((id) => right.explanation_ids.includes(id)
          && id !== left.object_id && id !== right.object_id);
        expect(leaked).toEqual([]);
      }
    }
    expect(needles.entries.length).toBeGreaterThan(0);
    expect(needles.entries.some((entry) => entry.claim === "unknown")).toBe(true);
  });

  it("F4 40-match/32-cap resume equals the full observation", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    const planted = await plantNeedles(slice, 40, 501);
    const inner = readersFor(slice);
    const capped = {
      ...inner,
      lexical: (input: Parameters<NonNullable<typeof inner.lexical>>[0]) =>
        inner.lexical!({ ...input, nativeLimit: Math.min(32, input.nativeLimit) })
    };
    const full = runRecall(slice, {
      query_text: "needle",
      budget: defaultBudget({ page_budget: 800, finalization_reserve: 1000 }),
      readers: capped
    });
    const pages = [];
    let continuation = null as ReturnType<typeof runRecall>["continuation"];
    for (let step = 0; step < 8; step += 1) {
      const page = runRecall(slice, {
        query_text: "needle",
        budget: defaultBudget({ page_budget: 8 }),
        readers: capped,
        continuation
      });
      pages.push(page);
      continuation = page.continuation;
      if (continuation === null) break;
    }
    const concatenated = pages.flatMap((page) => page.entries.map((entry) => entry.object_id));
    const fullIds = full.entries.map((entry) => entry.object_id);
    expect(new Set(concatenated).size).toBe(concatenated.length);
    expect(concatenated).toEqual(fullIds);
    expect(planted.length).toBe(40);
    expect(full.completeness.logical_index).toBe("complete");
    expect(fullIds).toHaveLength(40);
  });

  it("F5 native visits stay inside work_units; memory_bytes=1 is not a complete 31-entry index; tokens follow preview bytes", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantNeedles(slice, 31, 601);
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
    expect(tiny.completeness.logical_index).not.toBe("complete");
    expect(tiny.completeness.representation).not.toBe("complete");
    expect(tiny.entries.length).toBeLessThan(31);
    const longPreview = "x".repeat(1400);
    const encoded = encodedRecall(tight, new Map(tight.entries.map((entry) => [entry.object_id, longPreview])));
    const estimates = encoded.candidates.map((candidate) => candidate.token_estimate);
    if (estimates.length > 0) {
      expect(estimates.every((value) => value === 1)).toBe(false);
      expect(Math.max(...estimates)).toBeGreaterThan(1);
    }
    expect(tight.completeness.observed_coverage).not.toBeUndefined();
  });

  it("F6 pin and preview are not mixed across snapshot commit", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const inner = readersFor(slice);
    let generation = "before";
    const log: string[] = [];
    const readers = {
      ...inner,
      snapshotPin: () => {
        log.push(`pin:${generation}`);
        return inner.snapshotPin!(WS);
      },
      source: (input: Parameters<NonNullable<typeof inner.source>>[0]) => {
        const page = inner.source!(input);
        log.push(`source:${generation}:${input.objectId}`);
        if (page.row === null) return page;
        return { ...page, row: { ...page.row, content: `content-${generation}` } };
      }
    };
    const index = runRecall(slice, { readers });
    const pinPreviews = new Map(index.entries.map((entry) => {
      const page = readers.source({ workspaceId: WS, objectId: entry.object_id });
      return [entry.object_id, page.row?.content ?? ""] as const;
    }));
    generation = "after";
    setContent(slice, MEM.r, "content-after");
    const encoded = encodedRecall(index, pinPreviews);
    const previews = encoded.candidates.map((candidate) => candidate.content_preview);
    const mixed = previews.some((preview) => preview.includes("content-after"))
      && log.some((row) => row.startsWith("source:before"));
    if (mixed && index.completeness.payload === "complete") {
      expect(index.completeness.logical_index).not.toBe("complete");
    }
    expect(previews.some((preview) => preview.includes("content-before"))
      && previews.some((preview) => preview.includes("content-after"))).toBe(false);
  });

  it("F7 midnight continuation is invalidated or same-instance; pages are not spliced", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantNeedles(slice, 8, 921);
    const evening = runRecall(slice, {
      query_text: "needle",
      interpretation_clock: "2026-09-05T23:59:59.000Z",
      budget: defaultBudget({ page_budget: 1 })
    });
    const morning = runRecall(slice, {
      query_text: "needle",
      interpretation_clock: "2026-09-06T00:00:01.000Z",
      budget: defaultBudget({ page_budget: 1 }),
      continuation: evening.continuation
    });
    const eveningIds = evening.entries.map((entry) => entry.object_id);
    const morningIds = morning.entries.map((entry) => entry.object_id);
    const invalidated = morning.completeness.observed_coverage === "invalidated";
    const sameInstance = morning.query_id === evening.query_id && morning.snapshot_id === evening.snapshot_id;
    expect(invalidated || sameInstance).toBe(true);
    if (invalidated) {
      expect(morning.completeness.logical_index).not.toBe("complete");
    }
    const spliced = !invalidated && !sameInstance && morningIds.some((id) => !eveningIds.includes(id));
    expect(spliced).toBe(false);
  });
});

function grades(observed: ReturnType<typeof observeProgram>): Readonly<Record<string, number>> {
  const index = indexFromObserved(observed);
  const fromIndex: Record<string, number> = {};
  for (const entry of index.entries) {
    fromIndex[`${entry.object_id}:index`] = entry.association_milligrades;
  }
  if (observed.field.binding.kind !== "bound") return fromIndex;
  const out: Record<string, number> = { ...fromIndex };
  for (const value of observed.field.binding.snapshot.values) {
    const key = `${value.state.object_id}:${value.state.program_state}`;
    out[key] = Math.max(out[key] ?? 0, value.milligrades);
  }
  return out;
}

function sequence(
  first: string,
  second: string,
  verdict: "true" | "false" | "unresolved" = "unresolved"
): QueryProgram {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "sequence",
    steps: [relation(first, verdict), { ...relation(second), source_variable: "t", target_variable: "u" } as QueryProgram]
  };
}

function relation(kind: string, verdict: "true" | "false" | "unresolved" = "unresolved"): QueryProgram {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "relation",
    relation_kind: kind,
    source_variable: "s",
    target_variable: "t",
    guard: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "query_predicate",
      verdict,
      time_scope: "none"
    },
    facet_mode: "same_path",
    threshold_milligrades: 0
  };
}

async function plantChain(slice: SourceSlice): Promise<void> {
  await slice.writeMemory(SEED, "seed chain node", MemoryDimension.FACT);
  await slice.writeMemory(MIDDLE, "middle chain node", MemoryDimension.FACT);
  await slice.writeMemory(END, "end chain node", MemoryDimension.FACT);
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000401",
    assertionId: "assert-seed-middle",
    sourceId: SEED,
    targetId: MIDDLE,
    resultObjectId: MIDDLE,
    relationKind: "observed_log",
    validity: OPEN,
    gist: "alpha"
  });
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000402",
    assertionId: "assert-middle-end",
    sourceId: MIDDLE,
    targetId: END,
    resultObjectId: END,
    relationKind: "config_via_log",
    validity: OPEN,
    gist: "beta"
  });
}

function previewsFrom(slice: SourceSlice, objectIds: readonly string[]): Map<string, string> {
  const previews = new Map<string, string>();
  for (const objectId of objectIds) {
    const page = slice.memoryReader.source(WS, objectId);
    if (page.row?.content !== undefined) previews.set(objectId, page.row.content);
  }
  return previews;
}
