import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type ObserverCursor
} from "@do-soul/alaya-protocol";
import { enumerateSimplePaths, productKey } from "./enumerate-simple-paths.js";
import {
  FAR_FUTURE_EXPIRY,
  QUERY_ID,
  RESULT_VERSION,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView,
  deploymentWorld,
  sqliteInterruptedZero
} from "./finite-worlds.js";
import { compareIndexPages, pageMasqueradesAsFullIndex } from "./frozen-ports.js";
import {
  advanceObserverCursor,
  entryIdentity,
  interpretationMayEmitCompleteEmpty,
  mapNativeReaderPage,
  projectOracleIndex,
  resumeIdsAfterCursor,
  scheduleFairWork,
  tally,
  emptyCounts
} from "./oracle-index.js";

describe("conditional-field independent observer and index oracle", () => {
  it("A09 maps interrupted zero rows to interrupted/open, not exhausted/empty", () => {
    const mapped = mapNativeReaderPage(sqliteInterruptedZero().reader);
    expect(mapped.outcome.status).toBe("interrupted");
    expect(mapped.open_regions.map((region) => region.kind).sort())
      .toEqual(["adjacency", "binding", "guard", "seed"]);
    expect(mapped.outcome.status).not.toBe("exhausted");
    const index = projectWithObserver(mapped);
    expect(index.completeness.logical_index).toBe("open");
    expect(index.completeness.observed_coverage).toBe("interrupted");
    expect(index.completeness.observed_coverage).not.toBe("exhausted_empty");
  });

  it("A09 resume concatenates the same pinned coverage without skipping or duplicating", () => {
    const start: ObserverCursor = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      cursor_id: "seed-cursor",
      snapshot_id: SNAPSHOT_ID,
      query_id: QUERY_ID,
      region_id: "seed",
      position: null,
      committed_through: null
    };
    const ids = ["a", "b", "c"];
    expect(resumeIdsAfterCursor(ids, start)).toEqual(ids);
    const afterA = advanceObserverCursor(start, "a");
    expect(afterA.position).toBe("a");
    expect(afterA.committed_through).toBe("a");
    expect(resumeIdsAfterCursor(ids, afterA)).toEqual(["b", "c"]);
    const afterB = advanceObserverCursor(afterA, "b");
    expect([...resumeIdsAfterCursor(ids, start).slice(0, 1), ...resumeIdsAfterCursor(ids, afterA).slice(0, 1), ...resumeIdsAfterCursor(ids, afterB)])
      .toEqual(ids);
  });

  it("A10 keeps seed, adjacency, guard and binding regions after a partial run", () => {
    const mapped = mapNativeReaderPage({ ids: ["r"], truncated: true, readerAvailable: true });
    expect(mapped.open_regions.map((region) => region.kind).sort())
      .toEqual(["adjacency", "binding", "guard", "seed"]);
    expect(mapped.open_regions.every((region) => region.status === "open")).toBe(true);
    const missing = ["seed", "adjacency", "guard", "binding"].filter((kind) =>
      !mapped.open_regions.some((region) => region.kind === kind)
    );
    expect(missing).toEqual([]);
  });

  it("A11 serves a finite region without consuming the finalization reserve", () => {
    const scheduled = scheduleFairWork({
      regions: [
        { id: "high-refine", finite: false, work: 10_000 },
        { id: "low-finite", finite: true, work: 40 }
      ],
      explorationBudget: 80,
      finalizationReserve: 20
    });
    expect(scheduled.served).toContain("low-finite");
    expect(scheduled.remainingReserve).toBe(20);
    expect(scheduled.starvedFinite).toBe(false);
  });

  it("A12 distinguishes empty exhausted from unavailable and cancelled coverage", () => {
    const exhausted = mapNativeReaderPage({ ids: [], truncated: false, readerAvailable: true });
    const emptyIndex = projectWithObserver(exhausted, emptyField());
    expect(emptyIndex.entries).toEqual([]);
    expect(emptyIndex.completeness.logical_index).toBe("complete");
    expect(emptyIndex.completeness.observed_coverage).toBe("exhausted_empty");
    const unavailable = mapNativeReaderPage({ ids: [], truncated: false, readerAvailable: false });
    const unavailableIndex = projectWithObserver(unavailable, emptyField());
    expect(unavailableIndex.completeness.observed_coverage).toBe("unavailable");
    expect(unavailableIndex.completeness.logical_index).not.toBe("complete");
    for (const status of ["cancelled", "unknown", "not_applicable"] as const) {
      const index = projectWithObserver({
        outcome: { schema_version: 1, status },
        open_regions: []
      }, emptyField());
      expect(index.completeness.logical_index).not.toBe("complete");
      expect(index.completeness.observed_coverage).toBe(status);
      expect(index.completeness.observed_coverage).not.toBe("exhausted_empty");
    }
  });

  it("A13 can complete the logical index with unknown common cause", () => {
    const world = deploymentWorld();
    const field = enumerateSimplePaths(world.seeds, world.edges);
    const index = projectOracleIndex({
      field,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: world.roles,
      claims: world.claims
    });
    expect(index.completeness.logical_index).toBe("complete");
    expect(index.entries.find((entry) => entry.object_id === "h")?.claim).toBe("unknown");
    expect(index.completeness.logical_index).toBe("complete");
  });

  it("A14 pages share query/snapshot/result identity and concatenate in serialization order", () => {
    const world = deploymentWorld();
    const field = enumerateSimplePaths(world.seeds, world.edges);
    const input = {
      field,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget({ page_budget: 2 }),
      expires_at: FAR_FUTURE_EXPIRY,
      roles: world.roles,
      claims: world.claims
    };
    const first = projectOracleIndex(input);
    const pages = [first];
    let offset = first.entries.length;
    while (pages.at(-1)?.continuation !== null) {
      const next = projectOracleIndex({ ...input, page_offset: offset });
      pages.push(next);
      offset += next.entries.length;
    }
    const full = projectOracleIndex({ ...input, budget: defaultBudget({ page_budget: 800 }) });
    const counts = compareIndexPages(pages[0]!, pages.slice(1), full);
    expect(counts.mismatches).toBe(0);
    expect(pages.flatMap((page) => page.entries).map(entryIdentity)).toEqual(full.entries.map(entryIdentity));
    const keys = full.entries.map(entryIdentity);
    expect([...keys].sort()).toEqual(keys);
  });

  it("A15 labels a first page as partial transport, never a full inline index", () => {
    const field = enumerateSimplePaths(
      [{ state: productKey("r"), milligrades: 1000 }],
      [
        {
          from: productKey("r"),
          to: productKey("l"),
          relation_kind: "observed_log",
          strength_milligrades: 950,
          applicable: true,
          cost: 50
        },
        {
          from: productKey("l"),
          to: productKey("c"),
          relation_kind: "config_via_log",
          strength_milligrades: 850,
          applicable: true,
          cost: 150
        }
      ]
    );
    const first = projectOracleIndex({
      field,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: FAR_FUTURE_EXPIRY,
      roles: new Map([["r", "requested"], ["l", "associated"], ["c", "associated"]])
    });
    expect(first.completeness.transport).toBe("partial");
    expect(first.continuation).not.toBeNull();
    expect(pageMasqueradesAsFullIndex(first)).toBe(false);
    expect(JSON.stringify(first.completeness)).not.toContain("complete_inline");
  });

  it("invalidates expired or snapshot-mismatched continuations instead of an old complete index", () => {
    const world = deploymentWorld();
    const field = enumerateSimplePaths(world.seeds, world.edges);
    const expired = projectOracleIndex({
      field,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget({ page_budget: 2 }),
      expires_at: "2026-01-01T00:00:00.000Z",
      as_of: "2026-09-06T00:00:00.000Z",
      roles: world.roles
    });
    expect(expired.completeness.observed_coverage).toBe("invalidated");
    expect(expired.completeness.logical_index).not.toBe("complete");
    const revised = projectOracleIndex({
      field,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      prior_continuation: {
        schema_version: 1,
        continuation_id: "page-2",
        query_id: QUERY_ID,
        snapshot_id: `sha256:${"e".repeat(64)}`,
        result_version: RESULT_VERSION,
        expires_at: FAR_FUTURE_EXPIRY,
        cursor: "offset-2"
      },
      roles: world.roles
    });
    expect(revised.completeness.observed_coverage).toBe("invalidated");
    expect(revised.completeness.logical_index).not.toBe("complete");
  });

  it("does not map unsupported interpretation to a complete empty index", () => {
    expect(interpretationMayEmitCompleteEmpty("unsupported")).toBe(false);
    expect(interpretationMayEmitCompleteEmpty("malformed")).toBe(false);
    expect(interpretationMayEmitCompleteEmpty("resource_rejected")).toBe(false);
    expect(interpretationMayEmitCompleteEmpty("resolved")).toBe(true);
    const index = projectOracleIndex({
      field: emptyField(),
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: new Map(),
      interpretation_status: "unsupported"
    });
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(index.completeness.observed_coverage).not.toBe("exhausted_empty");
  });

  it("counts observation holes when a required region is omitted", () => {
    const mapped = mapNativeReaderPage({ ids: ["r"], truncated: true, readerAvailable: true });
    const producerRegions = mapped.open_regions.filter((region) => region.kind !== "guard");
    let counts = emptyCounts();
    for (const kind of ["seed", "adjacency", "guard", "binding"] as const) {
      if (producerRegions.some((region) => region.kind === kind)) counts = tally(counts, "matches");
      else counts = tally(counts, "observation_holes");
    }
    expect(counts.observation_holes).toBe(1);
    expect(counts.matches).toBe(3);
  });
});

function emptyField() {
  return enumerateSimplePaths([], []);
}

function projectWithObserver(
  observer: ReturnType<typeof mapNativeReaderPage>,
  field = emptyField()
) {
  return projectOracleIndex({
    field,
    view: defaultView(),
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    result_version: RESULT_VERSION,
    budget: defaultBudget(),
    roles: new Map(),
    observer
  });
}
