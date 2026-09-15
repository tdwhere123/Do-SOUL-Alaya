import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  BoundSourceInterpretationSchema, locateSourceInterpretation, sourceRecallTarget,
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

  it("continues without duplicate public identities after a narrow budget with hints on", () => {
    const query = sketchQuery();
    const observerReaders = readers("wrong");
    const first = observeConditionalField(seedInput(query, observerReaders, 2));
    expect(first.page.outcome.status).not.toBe("exhausted");
    const second = observeConditionalField(seedInput(query, observerReaders, 8, first.page.cursor));
    const ids = [...first.page.observations, ...second.page.observations].map((row) => row.object_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...new Set(ids)].sort()).toEqual([...ROOTS]);
  });

  it("skips a withdrawn hinted root and keeps exhaustive membership with hints on", () => {
    const query = sketchQuery();
    const withdrawn = readers("stale");
    expect([...collectIds(query, withdrawn)].sort()).toEqual([...ROOTS]);
  });

  it("emits the current revision when a hinted root is stale", () => {
    const query = sketchQuery();
    const current = sourceRoot("root-a", "rev-2");
    const observerReaders: ObserverReaders = {
      sourceRoots: () => ({
        rows: [current], nativeVisits: 1, nativeBytes: 4, rowsRead: 1, bytesRead: 4,
        truncated: false, committedThrough: "root-a"
      }),
      sourceRoot: (input) => input.revision === "rev-2"
        ? { row: current, rowsRead: 1, bytesRead: 8, nativeWork: 5, unavailable: false }
        : { row: null, rowsRead: 1, bytesRead: 0, nativeWork: 5, unavailable: true },
      boundInterpretations: ({ afterCursor }) => ({
        rows: afterCursor === null ? [{ object_id: "gist-1", gist: validHint("root-a", "rev-1") }] : [],
        nativeVisits: 1, nativeBytes: 8, nativeWork: 1, rowsRead: 1, bytesRead: 8,
        truncated: false, committedThrough: "gist-1"
      })
    };
    const observed = observeConditionalField(seedInput(query, observerReaders, 8));
    expect(observed.page.observations.some((row) => row.object_id === "root-a")).toBe(true);
    expect(observed.source_roots?.[0]?.revision).toBe("rev-2");
  });

  it("transfers leftover hint work to exhaustive when the hint page is unavailable", () => {
    const query = sketchQuery();
    const observerReaders: ObserverReaders = {
      sourceRoots: ({ afterCursor, limit }) => {
        const start = afterCursor === null ? 0 : ROOTS.indexOf(afterCursor as typeof ROOTS[number]) + 1;
        const page = ROOTS.map((rootId) => sourceRoot(rootId)).slice(Math.max(0, start), Math.max(0, start) + Math.max(1, limit));
        return {
          rows: page, nativeVisits: page.length, nativeBytes: 8, rowsRead: page.length, bytesRead: 8,
          truncated: start + page.length < ROOTS.length, committedThrough: page.at(-1)?.root_id ?? afterCursor
        };
      },
      boundInterpretations: () => ({
        rows: [], nativeVisits: 0, nativeBytes: 0, nativeWork: 0, rowsRead: 0, bytesRead: 0,
        truncated: false, unavailable: true, committedThrough: null
      })
    };
    const observed = observeConditionalField(seedInput(query, observerReaders, 6));
    expect(observed.page.observations.length).toBeGreaterThan(0);
    expect(observed.page.observations[0]?.object_id).toBe("root-a");
  });

  it.each(["disabled", "wrong"] as const)("preserves mixed completed membership when hints are %s", (mode) => {
    const query = sketchQuery("mixed");
    expect([...collectIds(query, mixedReaders(mode))].sort()).toEqual(["mem-a", "root-a", "root-b", "root-c"]);
  });

  it.each(["disabled", "wrong"] as const)("preserves memory-only completed membership when hints are %s", (mode) => {
    const query = sketchQuery("memory_only");
    expect([...collectIds(query, mixedReaders(mode))].sort()).toEqual(["mem-a"]);
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

function sketchQuery(resultKind: "source_only" | "mixed" | "memory_only" = "source_only"): QueryInterpretation {
  return compileQuerySourceSketch({
    snapshot_id: SNAPSHOT_ID,
    budget: defaultBudget(),
    interpretation_clock: INTERPRETATION_CLOCK,
    view: { ...defaultView(), result_kind_view: resultKind },
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
    seed_query: "find the adopted access context",
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
        rows: afterCursor === null ? [{ object_id: "gist-1", gist: validHint(mode === "wrong" ? "missing-root" : "root-a", "rev-1") }] : [],
        nativeVisits: 1, nativeBytes: 8, rowsRead: 1, bytesRead: 8,
        truncated: false, committedThrough: "gist-1"
      };
    }
  };
}

function mixedReaders(mode: "disabled" | "wrong"): ObserverReaders {
  const base = readers(mode);
  return {
    ...base,
    lexical: ({ afterObjectId, nativeLimit }) => {
      const ids = afterObjectId === null ? ["mem-a"] : [];
      const page = ids.slice(0, Math.max(1, nativeLimit));
      return {
        ids: page, nativeVisits: page.length, nativeBytes: 8, rowsRead: page.length, bytesRead: 8,
        truncated: false, committedThrough: page.at(-1) ?? afterObjectId
      };
    },
    source: (input) => ({
      row: { object_id: input.objectId, sourceRevision: "rev-1", content: `${input.objectId} body` },
      rowsRead: 1, bytesRead: 8, unavailable: false
    })
  };
}

function sourceRoot(rootId: string, revision = "rev-1"): SourceRootObserverRow {
  return {
    kind: "source_record",
    workspace_id: "ws",
    root_id: rootId,
    revision,
    digest: SNAPSHOT_ID,
    evidence_object_id: `capsule-${rootId}`,
    content: `${rootId} body`,
    content_complete: true
  };
}

function validHint(rootId: string, revision: string): string {
  const source = "access full PC instantly";
  const located = locateSourceInterpretation({ source, artifactKey: "hint", sha256: fieldContractSha256,
    assertion: { assertion_id: 1, text: source, source_span: [0, source.length] },
    response: { kind: "received", value: { interpretations: [{ assertion_id: 1,
      relations: [{ predicate: { text: "access" }, arguments: [{ role: "capability", phrase: { text: "full PC" } }],
        qualifiers: [{ role: "temporal", phrase: { text: "instantly" } }] }] }] } }
  });
  return JSON.stringify(BoundSourceInterpretationSchema.parse({ ...located, source_target: sourceRecallTarget({
    workspace_id: "ws", root_kind: "source_record", root_id: rootId, source_version: revision,
    content_digest: SNAPSHOT_ID, evidence_object_id: `capsule-${rootId}`
  }) }));
}
