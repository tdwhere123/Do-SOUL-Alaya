import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type CoverageRegion,
  type ObserverCursor
} from "@do-soul/alaya-protocol";
import {
  advanceObserverCursor,
  mapNativeReaderPage,
  projectAcceptingIndex,
  resumeIdsAfterCursor
} from "../../../../recall/conditional-field/reference/accepting-projection.js";
import { bindMaxMinField } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { scheduleFairWork } from "../../../../recall/conditional-field/reference/schedule-fair-work.js";
import {
  FAR_FUTURE_EXPIRY,
  QUERY_ID,
  RESULT_VERSION,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView,
  indexClaimMap,
  indexRoleMap,
  deploymentSeeds,
  deploymentTransitions,
  productKey
} from "./deployment.fixture.js";

describe("conditional-field observer and index contracts", () => {
  it("maps interrupted zero rows to interrupted/open, not exhausted/empty", () => {
    const mapped = mapNativeReaderPage({
      ids: [],
      truncated: true,
      readerAvailable: true
    });
    expect(mapped.outcome.status).toBe("interrupted");
    if (mapped.open_regions === undefined) throw new Error("interrupted reader must expose open regions");
    expect(mapped.open_regions.map((region) => region.kind).sort())
      .toEqual(["adjacency", "binding", "guard", "seed"]);
    expect(mapped.outcome.status).not.toBe("exhausted");
  });

  it("keeps seed, adjacency, guard and binding regions open after a partial run", () => {
    const regions = mapNativeReaderPage({
      ids: ["r"],
      truncated: true,
      readerAvailable: true,
      regions: [
        openRegion("seed", "seed"),
        openRegion("adjacency", "adjacency"),
        openRegion("guard", "guard"),
        openRegion("binding", "binding")
      ]
    }).open_regions;
    if (regions === undefined) throw new Error("partial reader must expose open regions");
    expect(regions.map((region) => region.kind).sort())
      .toEqual(["adjacency", "binding", "guard", "seed"]);
    expect(regions.every((region) => region.status === "open")).toBe(true);
  });

  it("serves a finite lower-bound region without consuming the finalization reserve", () => {
    const scheduled = scheduleFairWork({
      regions: [
        { id: "high-refine", priority: 2, finite: false, work: 10_000 },
        { id: "low-finite", priority: 1, finite: true, work: 40 }
      ],
      explorationBudget: 80,
      finalizationReserve: 20,
      totalWork: 100
    });
    expect(scheduled.served).toContain("low-finite");
    expect(scheduled.remainingReserve).toBe(20);
    expect(scheduled.starvedFinite).toBe(false);
  });

  it("distinguishes empty exhausted from unavailable coverage", () => {
    const bound = bindMaxMinField({
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      seeds: [],
      transitions: []
    });
    if (bound.kind !== "bound") throw new Error("expected bound field");
    const exhausted = mapNativeReaderPage({ ids: [], truncated: false, readerAvailable: true });
    const emptyIndex = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      observer: exhausted
    });
    expect(emptyIndex.entries).toEqual([]);
    expect(emptyIndex.completeness.logical_index).toBe("complete");
    expect(emptyIndex.completeness.observed_coverage).toBe("exhausted_empty");
    const unavailable = mapNativeReaderPage({
      ids: [],
      truncated: false,
      readerAvailable: false
    });
    const unavailableIndex = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      observer: unavailable
    });
    expect(unavailableIndex.completeness.observed_coverage).toBe("unavailable");
    expect(unavailableIndex.completeness.logical_index).not.toBe("complete");
    const interrupted = mapNativeReaderPage({ ids: [], truncated: true, readerAvailable: true });
    const interruptedIndex = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      observer: interrupted
    });
    expect(interruptedIndex.completeness.logical_index).not.toBe("complete");
    expect(interruptedIndex.completeness.observed_coverage).not.toBe("exhausted_empty");
    expect(interruptedIndex.completeness.observed_coverage).not.toBe("complete");
    for (const status of ["cancelled", "unknown", "not_applicable"] as const) {
      const index = projectAcceptingIndex({
        snapshot: bound.snapshot,
        view: defaultView(),
        query_id: QUERY_ID,
        snapshot_id: SNAPSHOT_ID,
        result_version: RESULT_VERSION,
        budget: defaultBudget(),
        observer: {
          outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status },
          open_regions: []
        }
      });
      expect(index.completeness.logical_index).not.toBe("complete");
      expect(index.completeness.observed_coverage).toBe(status);
      expect(index.completeness.observed_coverage).not.toBe("exhausted_empty");
    }
  });

  it("can complete the logical index with unknown common cause", () => {
    const bound = bindMaxMinField({
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      seeds: deploymentSeeds(),
      transitions: deploymentTransitions()
    });
    if (bound.kind !== "bound") throw new Error("expected bound field");
    const index = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: indexRoleMap([
        ["r", "requested"],
        ["l", "associated"],
        ["c", "associated"],
        ["h", "associated"]
      ]),
      claims: indexClaimMap([["h", "unknown"]])
    });
    expect(index.completeness.logical_index).toBe("complete");
    expect(index.entries.find((entry) => (entry.object_id ?? "") === "h")?.claim).toBe("unknown");
  });

  it("pages share query, snapshot and result identity and concatenate in serialization order", () => {
    const bound = bindMaxMinField({
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      seeds: deploymentSeeds(),
      transitions: deploymentTransitions()
    });
    if (bound.kind !== "bound") throw new Error("expected bound field");
    const input = {
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget({ page_budget: 2 }),
      expires_at: FAR_FUTURE_EXPIRY,
      roles: indexRoleMap([
        ["r", "requested"],
        ["l", "associated"],
        ["c", "associated"],
        ["h", "associated"]
      ])
    };
    const first = projectAcceptingIndex(input);
    const second = projectAcceptingIndex({ ...input, page_offset: first.entries.length });
    expect(first.query_id).toBe(second.query_id);
    expect(first.snapshot_id).toBe(second.snapshot_id);
    expect(first.result_version).toBe(second.result_version);
    const pages = [first, second];
    let offset = first.entries.length + second.entries.length;
    while (pages.at(-1)?.continuation !== null) {
      const next = projectAcceptingIndex({ ...input, page_offset: offset });
      pages.push(next);
      offset += next.entries.length;
    }
    const full = projectAcceptingIndex({ ...input, budget: defaultBudget({ page_budget: 800 }) });
    expect(pages.flatMap((page) => page.entries).map(entryKey))
      .toEqual(full.entries.map(entryKey));
    const keys = full.entries.map(entryKey);
    expect([...keys].sort()).toEqual(keys);
  });

  it("labels a first page as partial transport, never complete_inline", () => {
    const bound = bindMaxMinField({
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      seeds: [
        {
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          state: productKey("r"),
          milligrades: 1000
        }
      ],
      transitions: [
        {
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          from: productKey("r"),
          to: productKey("l"),
          relation_kind: "observed_log",
          strength_milligrades: 950,
          validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
          applicable: true
        },
        {
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          from: productKey("l"),
          to: productKey("c"),
          relation_kind: "config_via_log",
          strength_milligrades: 850,
          validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
          applicable: true
        }
      ]
    });
    if (bound.kind !== "bound") throw new Error("expected bound field");
    const first = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: FAR_FUTURE_EXPIRY,
      roles: indexRoleMap([
        ["r", "requested"],
        ["l", "associated"],
        ["c", "associated"]
      ])
    });
    expect(first.completeness.transport).toBe("partial");
    expect(first.continuation).not.toBeNull();
    expect(JSON.stringify(first.completeness)).not.toContain("complete_inline");
  });

  it("commits cursor progress only after observed identities", () => {
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
    expect(resumeIdsAfterCursor(ids, afterA)).not.toContain("a");
  });

  it("invalidates an expired or revised continuation instead of an old complete index", () => {
    const bound = bindMaxMinField({
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      seeds: deploymentSeeds(),
      transitions: deploymentTransitions()
    });
    if (bound.kind !== "bound") throw new Error("expected bound field");
    const expired = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget({ page_budget: 2 }),
      expires_at: "2026-01-01T00:00:00.000Z",
      as_of: "2026-09-06T00:00:00.000Z",
      roles: indexRoleMap([["r", "requested"], ["c", "associated"]])
    });
    expect(expired.completeness.observed_coverage).toBe("invalidated");
    expect(expired.completeness.logical_index).not.toBe("complete");
    expect(expired.continuation).toBeNull();
    const revised = projectAcceptingIndex({
      snapshot: bound.snapshot,
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
      roles: indexRoleMap([["r", "requested"], ["c", "associated"]])
    });
    expect(revised.completeness.observed_coverage).toBe("invalidated");
    expect(revised.completeness.logical_index).not.toBe("complete");
  });
});

function openRegion(id: string, kind: CoverageRegion["kind"]): CoverageRegion {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    region_id: id,
    kind,
    status: "open"
  };
}

function entryKey(entry: {
  readonly object_id?: string;
  readonly hypothesis_id: string;
  readonly output_binding: string;
}): string {
  return `${entry.hypothesis_id}:${entry.output_binding}:${entry.object_id ?? ""}`;
}
