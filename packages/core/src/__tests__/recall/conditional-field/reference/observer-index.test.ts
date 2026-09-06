import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type CoverageRegion
} from "@do-soul/alaya-protocol";
import {
  mapNativeReaderPage,
  projectAcceptingIndex
} from "../../../../recall/conditional-field/reference/accepting-projection.js";
import { bindMaxMinField } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import {
  QUERY_ID,
  RESULT_VERSION,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView,
  deploymentSeeds,
  deploymentTransitions,
  productKey
} from "./deployment.fixture.js";

describe("conditional-field observer and index contracts", () => {
  it("A09 maps interrupted zero rows to interrupted/open, not exhausted/empty", () => {
    const mapped = mapNativeReaderPage({
      ids: [],
      truncated: true,
      readerAvailable: true
    });
    expect(mapped.outcome.status).toBe("interrupted");
    expect(mapped.open_regions.map((region) => region.kind).sort())
      .toEqual(["adjacency", "binding", "guard", "seed"]);
    expect(mapped.outcome.status).not.toBe("exhausted");
  });

  it("A10 keeps seed, adjacency, guard and binding regions open after a partial run", () => {
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
    expect(regions.map((region) => region.kind).sort())
      .toEqual(["adjacency", "binding", "guard", "seed"]);
    expect(regions.every((region) => region.status === "open")).toBe(true);
  });

  it("A11 serves a finite lower-bound region without consuming the finalization reserve", () => {
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

  it("A12 distinguishes empty exhausted from unavailable coverage", () => {
    const empty = mapNativeReaderPage({ ids: [], truncated: false, readerAvailable: true });
    expect(empty.outcome.status).toBe("exhausted");
    expect(empty.open_regions).toEqual([]);
    const bound = bindMaxMinField({
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      seeds: [],
      transitions: []
    });
    if (bound.kind !== "bound") throw new Error("expected bound field");
    const index = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget()
    });
    expect(index.entries).toEqual([]);
    expect(index.completeness.logical_index).toBe("complete");
    expect(index.completeness.observed_coverage).toBe("exhausted_empty");
    const unavailable = mapNativeReaderPage({
      ids: [],
      truncated: false,
      readerAvailable: false
    });
    expect(unavailable.outcome.status).toBe("unavailable");
    expect(unavailable.outcome.status).not.toBe("exhausted");
  });

  it("A13 can complete the logical index with unknown common cause", () => {
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
      roles: new Map([
        ["r", "requested"],
        ["l", "associated"],
        ["c", "associated"],
        ["h", "associated"]
      ]),
      claims: new Map([["h", "unknown"]])
    });
    expect(index.completeness.logical_index).toBe("complete");
    expect(index.entries.find((entry) => entry.object_id === "h")?.claim).toBe("unknown");
  });

  it("A14 pages share query, snapshot and result identity and concatenate in serialization order", () => {
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
      roles: new Map([
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

  it("A15 labels a first page as partial transport, never complete_inline", () => {
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
      roles: new Map([
        ["r", "requested"],
        ["l", "associated"],
        ["c", "associated"]
      ])
    });
    expect(first.completeness.transport).toBe("partial");
    expect(first.continuation).not.toBeNull();
    expect(JSON.stringify(first.completeness)).not.toContain("complete_inline");
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

function entryKey(entry: { readonly object_id: string; readonly hypothesis_id: string }): string {
  return `${entry.hypothesis_id}:${entry.object_id}`;
}

function scheduleFairWork(input: Readonly<{
  readonly regions: readonly Readonly<{
    readonly id: string;
    readonly priority: number;
    readonly finite: boolean;
    readonly work: number;
  }>[];
  readonly explorationBudget: number;
  readonly finalizationReserve: number;
  readonly totalWork: number;
}>): Readonly<{
  readonly served: readonly string[];
  readonly remainingReserve: number;
  readonly starvedFinite: boolean;
}> {
  const exploration = Math.min(
    input.explorationBudget,
    Math.max(0, input.totalWork - input.finalizationReserve)
  );
  const served: string[] = [];
  let remaining = exploration;
  const finite = input.regions.filter((region) => region.finite)
    .sort((left, right) => left.priority - right.priority);
  const infinite = input.regions.filter((region) => !region.finite)
    .sort((left, right) => right.priority - left.priority);
  for (const region of finite) {
    if (remaining < region.work) continue;
    remaining -= region.work;
    served.push(region.id);
  }
  for (const region of infinite) {
    if (remaining <= 0) break;
    remaining -= Math.min(remaining, region.work);
    served.push(region.id);
  }
  return {
    served,
    remainingReserve: input.finalizationReserve,
    starvedFinite: finite.some((region) => !served.includes(region.id))
  };
}
