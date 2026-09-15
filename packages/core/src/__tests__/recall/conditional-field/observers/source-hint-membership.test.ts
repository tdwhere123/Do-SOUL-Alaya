import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type QueryInterpretation
} from "@do-soul/alaya-protocol";
import {
  observeConditionalField,
  startObserverCursor,
  type ObserverReaders,
  type SourceRootObserverRow
} from "../../../../recall/conditional-field/observers/observe.js";
import { compileQuerySourceSketch } from "../../../../recall/conditional-field/query/query-source-sketch.js";
import {
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView
} from "../reference/deployment.fixture.js";

const ROOTS = ["root-a", "root-b", "root-c"] as const;

describe("source hint membership", () => {
  it.each(["disabled", "absent", "empty", "wrong", "stale", "corrupt"] as const)(
    "preserves completed membership when hints are %s",
    (mode) => {
      const query = sketchQuery();
      const expected = collectIds(query, readers("disabled"));
      expect([...expected].sort()).toEqual([...ROOTS]);
      expect(collectIds(query, readers(mode))).toEqual(expected);
    }
  );

  it("does not let hint exhaustion close the source residual", () => {
    const query = sketchQuery();
    const observed = observeConditionalField(seedInput(query, readers("empty"), 2));
    expect(observed.page.outcome.status).not.toBe("exhausted");
    expect(observed.page.cursor.committed_through).toBeTruthy();
  });

  it("continues without duplicate public identities after a narrow budget", () => {
    const query = sketchQuery();
    const observerReaders = readers("disabled");
    const first = observeConditionalField(seedInput(query, observerReaders, 2));
    expect(first.page.outcome.status).not.toBe("exhausted");
    const second = observeConditionalField(seedInput(query, observerReaders, 8, first.page.cursor));
    const ids = [...first.page.observations, ...second.page.observations].map((row) => row.object_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...new Set(ids)].sort()).toEqual([...ROOTS]);
  });

  it("skips a withdrawn hinted root and keeps exhaustive membership", () => {
    const query = sketchQuery();
    const withdrawn = readers("stale");
    expect([...collectIds(query, withdrawn)].sort()).toEqual([...ROOTS]);
  });

  it("keeps an interrupted hydration residual open", () => {
    const query = sketchQuery();
    const observerReaders: ObserverReaders = {
      sourceRoots: () => ({
        rows: [sourceRoot("root-a")],
        nativeVisits: 1,
        nativeBytes: 4,
        rowsRead: 1,
        bytesRead: 4,
        truncated: true,
        resourceLimited: true,
        committedThrough: "root-a"
      }),
      sourceRoot: () => ({ row: null, rowsRead: 1, bytesRead: 0, unavailable: false, resourceLimited: true })
    };
    const observed = observeConditionalField(seedInput(query, observerReaders, 4));
    expect(observed.page.outcome.status).toBe("interrupted");
    expect(observed.page.outcome.status).not.toBe("exhausted");
  });
});

function collectIds(query: QueryInterpretation, observerReaders: ObserverReaders): ReadonlySet<string> {
  let cursor = startObserverCursor({
    cursor_id: "seed", snapshot_id: SNAPSHOT_ID, query_id: query.query_id, region_id: "seed"
  });
  const ids = new Set<string>();
  for (let step = 0; step < 8; step += 1) {
    const observed = observeConditionalField(seedInput(query, observerReaders, 8, cursor));
    for (const row of observed.page.observations) ids.add(row.object_id);
    cursor = observed.page.cursor;
    if (observed.page.outcome.status === "exhausted") break;
  }
  return ids;
}

function sketchQuery(): QueryInterpretation {
  return compileQuerySourceSketch({
    snapshot_id: SNAPSHOT_ID,
    budget: defaultBudget(),
    interpretation_clock: INTERPRETATION_CLOCK,
    view: { ...defaultView(), result_kind_view: "source_only" },
    sketch: {
      original_query: "find the adopted access context",
      relation: {
        predicate: "access",
        arguments: [{ role: "capability", phrase: "full PC" }],
        qualifiers: [{ role: "temporal", phrase: "instantly" }]
      }
    }
  });
}

function seedInput(
  query: QueryInterpretation,
  observerReaders: ObserverReaders,
  workLimit: number,
  cursor = startObserverCursor({
    cursor_id: "seed", snapshot_id: SNAPSHOT_ID, query_id: query.query_id, region_id: "seed"
  })
) {
  return {
    lease: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      lease_id: "lease-1",
      snapshot_id: SNAPSHOT_ID,
      query_id: query.query_id,
      status: "active" as const
    },
    action: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      action: "seed" as const,
      region_id: "seed",
      work_limit: workLimit
    },
    cursor,
    query,
    workspace_id: "ws",
    authorized_scopes: null,
    readers: observerReaders
  };
}

function readers(mode: "disabled" | "absent" | "empty" | "wrong" | "stale" | "corrupt"): ObserverReaders {
  const roots = ROOTS.map((rootId) => sourceRoot(rootId));
  const exhaustive: ObserverReaders["sourceRoots"] = ({ afterCursor, limit }) => {
    const start = afterCursor === null ? 0 : ROOTS.indexOf(afterCursor as typeof ROOTS[number]) + 1;
    const page = roots.slice(Math.max(0, start), Math.max(0, start) + Math.max(1, limit));
    return {
      rows: page,
      nativeVisits: page.length,
      nativeBytes: 8,
      rowsRead: page.length,
      bytesRead: 8,
      truncated: start + page.length < roots.length,
      committedThrough: page.at(-1)?.root_id ?? afterCursor
    };
  };
  if (mode === "disabled") return { sourceRoots: exhaustive };
  const hydrate: NonNullable<ObserverReaders["sourceRoot"]> = (input) => {
    const row = roots.find((item) => item.root_id === input.rootId);
    if (mode === "stale" || row === undefined) {
      return { row: null, rowsRead: 1, bytesRead: 0, unavailable: true };
    }
    return { row, rowsRead: 1, bytesRead: 8, unavailable: false };
  };
  return {
    sourceRoots: exhaustive,
    sourceRoot: hydrate,
    boundInterpretations: ({ afterCursor }) => {
      if (mode === "absent") throw new Error("hint reader exploded");
      if (mode === "corrupt") {
        return {
          rows: afterCursor === null ? [{ object_id: "gist-1", gist: "{not-json" }] : [],
          nativeVisits: 1, nativeBytes: 8, rowsRead: 1, bytesRead: 8,
          truncated: afterCursor === null, committedThrough: "gist-1"
        };
      }
      if (mode === "empty") {
        return { rows: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0,
          truncated: false, committedThrough: afterCursor };
      }
      return {
        rows: afterCursor === null ? [{ object_id: "gist-1", gist: JSON.stringify({ contract: "nope" }) }] : [],
        nativeVisits: 1, nativeBytes: 8, rowsRead: 1, bytesRead: 8,
        truncated: false, committedThrough: "gist-1"
      };
    }
  };
}

function sourceRoot(rootId: string): SourceRootObserverRow {
  return {
    kind: "source_record",
    workspace_id: "ws",
    root_id: rootId,
    revision: "rev-1",
    digest: SNAPSHOT_ID,
    evidence_object_id: `capsule-${rootId}`,
    content: `${rootId} body`,
    content_complete: true
  };
}
