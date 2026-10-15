import { describe, expect, it } from "vitest";
import {
  MemoryDimension, productSubjectId, type Guard, type QueryHypothesis, type QueryProgram
} from "@do-soul/alaya-protocol";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import type { FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import type { ObserverReaders, SourceObserverRow } from "../../../../recall/conditional-field/observers/observe.js";
import { encodeSourceFilters } from "../../../../recall/conditional-field/query/ordinary-language.js";
import { extractQualifiedResults } from "./qualified-expression-native.fixture.js";
import { defaultBudget } from "../reference/deployment.fixture.js";
import { AS_OF, OPEN_GUARD, edge, query, relation } from "./relation-grounding.fixture.js";

const MEMORY = 20_000_000;
const H0: QueryHypothesis[] = [{ schema_version: 1, hypothesis_id: "h0",
  bindings: [{ schema_version: 1, variable: "c", value: "G" }] }];
const Y_WANTED: QueryHypothesis[] = [{ schema_version: 1, hypothesis_id: "h0",
  bindings: [{ schema_version: 1, variable: "y", value: "wanted" }] }];
const INTERVAL: Guard = { schema_version: 1, kind: "interval_relation", verdict: "unresolved", variable: "c",
  time_scope: "anchor", interval: { start: "2026-09-01T00:00:00.000Z", end: "2026-09-11T00:00:00.000Z",
    time_domain: "calendar_day" } };
const NAMED: Guard = { schema_version: 1, kind: "query_predicate", verdict: "unresolved", time_scope: "none",
  variable: "c", predicate_name: encodeSourceFilters({ dimension_filter: [MemoryDimension.FACT] }) };

type Row = ReturnType<typeof edge>;
type ObserveOptions = Readonly<{
  resume?: FieldEngineState; work?: number; pageSize?: number; lexicalIds?: readonly string[];
  holdOpen?: boolean; unavailable?: ReadonlySet<string>;
  authorizedScopes?: readonly string[] | null;
  sources?: Readonly<Record<string, Partial<SourceObserverRow>>>; hypotheses?: readonly QueryHypothesis[];
}>;

function hop(kind: string, source: string, target: string, guard: Guard = OPEN_GUARD): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
    facet_mode: "same_path", threshold_milligrades: 0, guard };
}

function observe(program: QueryProgram, rows: readonly Row[], options: ObserveOptions = {}): FieldEngineState {
  const hypotheses = options.hypotheses ?? [];
  const readers: ObserverReaders = {
    lexical: () => {
      const ids = [...options.lexicalIds ?? ["A"]];
      return { ids, nativeVisits: ids.length, nativeBytes: ids.length, rowsRead: ids.length, bytesRead: ids.length,
        truncated: false };
    },
    source: ({ objectId }) => {
      if (options.unavailable?.has(objectId) === true) {
        return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      }
      const extra = options.sources?.[objectId] ?? {};
      const row: SourceObserverRow = { object_id: objectId, sourceRevision: extra.sourceRevision ?? "rev",
        lifecycle_state: extra.lifecycle_state ?? "active", scope_class: extra.scope_class ?? "project", ...extra };
      return { row, rowsRead: 1, bytesRead: 32, unavailable: false };
    },
    relation: ({ subject, predicate, afterAssertionId, limit, nativeLimit }) => {
      const remaining = rows.filter((row) => row.sourceObjectId === subject && row.predicate === predicate
        && row.assertionId > (afterAssertionId ?? "")).sort((left, right) => left.assertionId.localeCompare(right.assertionId));
      const observations = remaining.slice(0, Math.min(limit, nativeLimit, options.pageSize ?? Infinity));
      return { observations, nativeVisits: observations.length, nativeBytes: observations.length,
        rowsRead: observations.length, bytesRead: observations.length,
        truncated: options.holdOpen === true || observations.length < remaining.length,
        committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
    }
  };
  return observeField(query(program, { hypotheses }), {
    workspace_id: "ws", query_text: "incremental-grounding", as_of: AS_OF, readers,
    authorized_scopes: options.authorizedScopes === undefined ? null : options.authorizedScopes,
    ...(options.resume === undefined ? {} : { resume_field: options.resume }),
    budget: defaultBudget({ work_units: options.work ?? 200_000, memory_bytes: MEMORY,
      finalization_reserve: 0, min_envelope: 0 })
  });
}

function members(state: FieldEngineState): string[] {
  if (state.binding.kind !== "bound") return [];
  return [...new Set(state.binding.snapshot.values.filter((value) => value.accepting && (value.milligrades ?? 0) > 0)
    .map((value) => productSubjectId(value.state)))].sort();
}

function assertionIds(state: FieldEngineState): string[] {
  return [...state.observed_relations ?? []].map((row) => row.assertionId).sort();
}

function view(state: FieldEngineState, rows: readonly Row[]) {
  return extractQualifiedResults(state, new Map(rows.map((row) => [row.assertionId, {
    id: row.assertionId, revision: row.source_revision ?? "rev"
  }])));
}

describe("incremental grounding matches a fresh rebuild", () => {
  it("admits a previously rejected unifying row", () => {
    const program = relation("p");
    const rejected = edge("p", "A", "other", "a-other");
    const admitted = edge("p", "A", "wanted", "b-wanted");
    const held = observe(program, [rejected], { hypotheses: Y_WANTED, holdOpen: true, work: 8_000, pageSize: 1 });
    expect(held.last_observer_status).toBe("interrupted");
    expect(assertionIds(held)).toEqual(["a-other"]);
    // Hand-derived: y is bound to wanted, so other never unifies.
    expect(members(held)).toEqual([]);
    const live = observe(program, [rejected, admitted], { hypotheses: Y_WANTED, resume: held, pageSize: 1 });
    const fresh = observe(program, [rejected, admitted], { hypotheses: Y_WANTED, pageSize: 1 });
    expect(members(live)).toEqual(["wanted"]);
    expect(view(live, [rejected, admitted])).toEqual(view(fresh, [rejected, admitted]));
  });

  it("inserts the first row after an absence read", () => {
    const program = relation("p");
    const row = edge("p", "A", "T", "p-T");
    const held = observe(program, [], { holdOpen: true, work: 4_000 });
    expect(held.last_observer_status).toBe("interrupted");
    expect(assertionIds(held)).toEqual([]);
    expect(members(held)).toEqual([]);
    const live = observe(program, [row], { resume: held });
    const fresh = observe(program, [row]);
    expect(members(live)).toEqual(["T"]);
    expect(view(live, [row])).toEqual(view(fresh, [row]));
  });

  it("keeps an unavailable non-endpoint guard unresolved on resume", () => {
    const program: QueryProgram = { schema_version: 1, kind: "sequence",
      steps: [hop("p", "x", "m"), hop("q", "m", "y", INTERVAL)] };
    const rows = [edge("p", "A", "M", "p-M"), edge("q", "M", "Y", "q-Y")];
    const first = { hypotheses: H0, unavailable: new Set(["G"]) };
    const held = observe(program, rows, first);
    // Hand-derived: G is not an endpoint; without its observed_at the interval stays unresolved.
    expect(members(held)).toEqual([]);
    const live = observe(program, rows, { ...first, resume: held });
    const fresh = observe(program, rows, { hypotheses: H0, sources: { G: { observed_at: AS_OF } } });
    expect(members(live)).toEqual([]);
    expect(members(fresh)).toEqual(["Y"]);
  });

  it("keeps an unavailable named predicate unresolved on resume", () => {
    const program = relation("p", "y", NAMED);
    const rows = [edge("p", "A", "T", "p-T")];
    const first = { hypotheses: H0, unavailable: new Set(["G"]) };
    const held = observe(program, rows, first);
    // Hand-derived: the filter reads G, which is not a row endpoint, so T stays out until G is a fact.
    expect(members(held)).toEqual([]);
    const live = observe(program, rows, { ...first, resume: held });
    const fresh = observe(program, rows, { hypotheses: H0, sources: { G: { dimension: MemoryDimension.FACT } } });
    expect(members(live)).toEqual([]);
    expect(members(fresh)).toEqual(["T"]);
  });

  it("does not retain a relation rejected for an unavailable endpoint", () => {
    const program = relation("p");
    const rows = [edge("p", "A", "B", "p-B")];
    const first = { unavailable: new Set(["B"]) };
    const held = observe(program, rows, first);
    // Hand-derived: missing target revision blocks B and cannot become a retained relation.
    expect(members(held)).toEqual([]);
    const live = observe(program, rows, { ...first, resume: held });
    const fresh = observe(program, rows);
    expect(members(live)).toEqual([]);
    expect(assertionIds(held)).toEqual([]);
    expect(assertionIds(live)).toEqual([]);
    expect(members(fresh)).toEqual(["B"]);
  });

  it("resumes a budget interruption with the same proof alternatives", () => {
    const program = relation("p");
    const rows = [edge("p", "A", "T", "p-0"), edge("p", "A", "T", "p-1")];
    const fresh = observe(program, rows, { pageSize: 1 });
    let held: FieldEngineState | undefined;
    for (const work of [80, 120, 180, 250, 400, 700, 1_200, 2_000, 4_000, 8_000]) {
      const candidate = observe(program, rows, { pageSize: 1, work });
      if (candidate.last_observer_status === "interrupted" && assertionIds(candidate).length > 0
        && assertionIds(candidate).length < rows.length) {
        held = candidate;
        break;
      }
    }
    expect(held, "need an interrupted field that retained a proper prefix of the rows").toBeDefined();
    const live = observe(program, rows, { pageSize: 1, resume: held });
    // Hand-derived: both assertions independently support T at hard identity.
    expect(members(live)).toEqual(["T"]);
    expect(view(live, rows)).toEqual(view(fresh, rows));
    expect(view(fresh, rows)[0]?.supports).toHaveLength(2);
  });

  it.each([
    { name: "out-of-scope", source: { scope_class: "private" }, row: {} },
    { name: "inactive source", source: { lifecycle_state: "archived" }, row: {} },
    { name: "inactive resolution", source: {}, row: { resolutionKind: "retracted", resolvedAt: AS_OF } },
    { name: "invalid interpretation", source: {}, row: { validity: {
      kind: "interpretation" as const, hypothesis_id: "foreign", packet_id: "foreign"
    } } },
    { name: "outside validity", source: {}, row: { validity: {
      kind: "open" as const, valid_from: "2027-01-01T00:00:00.000Z"
    } } }
  ])("does not retain $name rows from an unavailable page", ({ source, row }) => {
    const program = relation("p");
    const rows = [
      { ...edge("p", "A", "T", "a-rejected"), ...row },
      edge("p", "A", "B", "b-unavailable")
    ];
    const options = { authorizedScopes: ["project"], sources: { T: source }, unavailable: new Set(["B"]) };
    const held = observe(program, rows, options);
    expect(members(held)).toEqual([]);
    expect(assertionIds(held)).toEqual([]);
    expect(held.observed_relation_bytes ?? 0).toBe(0);
    const resumed = observe(program, rows, { ...options, resume: held });
    expect(members(resumed)).toEqual([]);
    expect(assertionIds(resumed)).toEqual([]);
    expect(resumed.observed_relation_bytes ?? 0).toBe(0);
  });
});
