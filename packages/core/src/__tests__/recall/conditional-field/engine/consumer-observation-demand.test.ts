import { describe, expect, it } from "vitest";
import { productSubjectId, type Guard, type QueryInterpretation, type QueryProgram } from "@do-soul/alaya-protocol";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { assessUnknownCause } from "../../../../recall/runtime/semantic-attribution.js";
import type { FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const AS_OF = "2026-09-07T00:00:00.000Z";
const TRUE_GUARD = { schema_version: 1, kind: "query_predicate", time_scope: "none", verdict: "unresolved" } as const;

function relation(kind: string, source: string, target: string, guard: Guard = TRUE_GUARD): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: kind,
    source_variable: source, target_variable: target, guard, facet_mode: "same_path", threshold_milligrades: 0 };
}

function query(program: QueryProgram, patch: Partial<QueryInterpretation> = {}): QueryInterpretation {
  return { schema_version: 1, query_id: "consumer-observation", snapshot_id: SNAPSHOT_ID,
    status: "resolved", holes: [], hypotheses: [], view: defaultView(), program, ...patch };
}

function edge(source: string, target: string, predicate: string, id = `${source}-${target}-${predicate}`) {
  return { assertionId: id, sourceObjectId: source, targetObjectId: target, resultObjectId: target,
    predicate, source_revision: "rev", validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" },
    sourceObservations: [{ source_id: `event-${id}`, source_sha256: "rev" }],
    evidenceReceipts: [{ evidenceId: `evidence-${id}`, eventId: `event-${id}`, eventType: "test", occurredAt: AS_OF }] };
}

function fixture(program: QueryProgram, rows: readonly ReturnType<typeof edge>[], options: Readonly<{
  sourceRows?: Readonly<Record<string, Readonly<{ scope_class?: string; predicates?: Readonly<Record<string, boolean>> }> | null>>;
  interpretation?: Partial<QueryInterpretation>;
  resume?: FieldEngineState;
  scopes?: readonly string[] | null;
  work?: number;
  memory?: number;
}> = {}) {
  const relationCalls: string[] = [];
  const sourceCalls: string[] = [];
  const sourceRows = options.sourceRows ?? {};
  const state = observeField(query(program, options.interpretation), {
    workspace_id: "ws", query_text: "a", as_of: AS_OF, authorized_scopes: options.scopes ?? null,
    ...(options.resume === undefined ? {} : { resume_field: options.resume }),
    budget: defaultBudget({ work_units: options.work ?? 10_000, memory_bytes: options.memory ?? 1_000_000 }),
    readers: {
      lexical: () => ({ ids: ["a"], nativeVisits: 1, nativeBytes: 1, rowsRead: 1, bytesRead: 1, truncated: false }),
      source: ({ objectId }) => {
        sourceCalls.push(objectId);
        const specified = sourceRows[objectId];
        if (specified === null) return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
        return { row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active",
          scope_class: specified?.scope_class ?? "project",
          ...(specified?.predicates === undefined ? {} : { predicates: specified.predicates }) },
          rowsRead: 1, bytesRead: 32, unavailable: false };
      },
      relation: ({ subject, predicate, afterAssertionId, limit, nativeLimit }) => {
        relationCalls.push(`${subject ?? "null"}\0${predicate}`);
        const remaining = rows.filter((row) => row.sourceObjectId === subject && row.predicate === predicate
          && row.assertionId > (afterAssertionId ?? "")).sort((left, right) => left.assertionId.localeCompare(right.assertionId));
        const observations = remaining.slice(0, Math.min(limit, nativeLimit));
        return { observations, nativeVisits: observations.length, nativeBytes: observations.length * 32,
          rowsRead: observations.length, bytesRead: observations.length * 32, truncated: observations.length < remaining.length,
          committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
      }
    }
  });
  const accepted = state.binding.kind === "bound" ? state.binding.snapshot.values
    .filter((value) => value.accepting && (value.milligrades ?? 0) > 0)
    .map((value) => productSubjectId(value.state)) : [];
  return { state, accepted, relationCalls, sourceCalls };
}

describe("consumer-directed physical observation", () => {
  it("closes a single relation kind with local empty reads", () => {
    const result = fixture(relation("p", "s", "t"), [edge("a", "b", "p")]);
    expect(result.accepted).toContain("b");
    expect(result.relationCalls).toContain("a\0p");
    expect(result.relationCalls).not.toContain("b\0p");
    expect(result.state.residuals.find((row) => row.kind === "adjacency")?.status).toBe("exhausted");
  });

  it("does not reuse physical completion across a changed program or scope", () => {
    const rows = [edge("a", "b", "p"), edge("a", "c", "q")];
    const first = fixture(relation("p", "s", "t"), rows);
    expect(first.accepted).toContain("b");
    const changedProgram = fixture(relation("q", "s", "t"), rows, { resume: first.state });
    expect(changedProgram.relationCalls).toContain("a\0q");
    expect(changedProgram.accepted).toContain("c");
    expect(changedProgram.accepted).not.toContain("b");
    const changedScope = fixture(relation("p", "s", "t"), rows, { resume: first.state, scopes: [] });
    expect(changedScope.accepted).not.toContain("b");
    expect(changedScope.state.pair_progress).not.toBe(first.state.pair_progress);
  });

  it("reads an internal node of a nested hyperedge premise", () => {
    const nested: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "or", premises: [
      { schema_version: 1, kind: "sequence", steps: [relation("p", "s", "m"), relation("q", "m", "t")] },
      relation("r", "s", "t")
    ] };
    const result = fixture(nested, [edge("a", "middle", "p"), edge("middle", "end", "q")]);
    expect(result.relationCalls).toContain("middle\0q");
    expect(result.accepted).toContain("end");
  });

  it("reads a third bound source before resolving its authorization guard", () => {
    const guard = { schema_version: 1, kind: "authorization", authorization_scope: "project",
      variable: "c", time_scope: "none", verdict: "unresolved" } as const;
    const interpretation: Partial<QueryInterpretation> = { hypotheses: [{ schema_version: 1,
      hypothesis_id: "h", bindings: [{ schema_version: 1, variable: "c", value: "x" }] }] };
    const result = fixture(relation("p", "s", "t", guard), [edge("a", "b", "p")], { interpretation });
    expect(result.sourceCalls).toContain("x");
    expect(result.accepted).toContain("b");
    expect(result.state.residuals.find((row) => row.kind === "guard")?.status).toBe("exhausted");
    const absent = fixture(relation("p", "s", "t", guard), [edge("a", "b", "p")], {
      interpretation, sourceRows: { x: null }
    });
    expect(absent.accepted).not.toContain("b");
    expect(absent.sourceCalls.filter((id) => id === "x")).toHaveLength(1);
    expect(absent.state.residuals.find((row) => row.kind === "guard")?.status).toBe("unknown");
  });

  it("keeps an actual unknown guard independent of a positive branch", () => {
    const unknown = { schema_version: 1, kind: "query_predicate", predicate_name: "unavailable_flag",
      variable: "t", time_scope: "none", verdict: "true" } as const;
    const program: QueryProgram = { schema_version: 1, kind: "alternative", options: [
      relation("p", "s", "t", unknown), relation("q", "s", "u")
    ] };
    const result = fixture(program, [edge("a", "blocked", "p"), edge("a", "allowed", "q")]);
    expect(result.accepted).toContain("allowed");
    expect(result.accepted).not.toContain("blocked");
    expect(result.state.residuals.find((row) => row.kind === "guard")?.status).toBe("unknown");
  });

  it("replaces a hydrated guard verdict while retaining another branch's unknown", () => {
    const authorization: Guard = { schema_version: 1, kind: "authorization", authorization_scope: "project",
      variable: "c", time_scope: "none", verdict: "unresolved" };
    const unknown: Guard = { schema_version: 1, kind: "query_predicate", predicate_name: "unavailable_flag",
      variable: "t", time_scope: "none", verdict: "true" };
    const program: QueryProgram = { schema_version: 1, kind: "alternative", options: [
      relation("p", "s", "t", authorization), relation("q", "s", "t", unknown),
      relation("r", "s", "t")
    ] };
    const interpretation: Partial<QueryInterpretation> = { hypotheses: [{ schema_version: 1,
      hypothesis_id: "h", bindings: [{ schema_version: 1, variable: "c", value: "x" }] }] };
    const rows = [edge("a", "authorized", "p"), edge("a", "unknown", "q"), edge("a", "independent", "r")];
    const trueFact = fixture(program, rows, { interpretation, sourceRows: { x: { scope_class: "project" } } });
    expect(trueFact.sourceCalls).toContain("x");
    expect(trueFact.accepted).toEqual(expect.arrayContaining(["authorized", "independent"]));
    expect(trueFact.accepted).not.toContain("unknown");
    expect(trueFact.state.residuals.find((row) => row.kind === "guard")?.status).toBe("unknown");
    const falseFact = fixture(program, rows, { interpretation, sourceRows: { x: { scope_class: "private" } } });
    expect(falseFact.accepted).not.toContain("authorized");
    expect(falseFact.accepted).toContain("independent");
    expect(falseFact.state.residuals.find((row) => row.kind === "guard")?.status).toBe("unknown");
  });

  it("reads claim evidence from a bound cause outside relation endpoints", () => {
    const view = { ...defaultView(), claim_demands: [{ variable: "h", proposition_kind: "cause",
      argument_variables: ["c", "h"], required_claim: "supported" as const }] };
    const result = fixture(relation("p", "s", "h"), [edge("a", "b", "p"), edge("x", "b", "cause")], {
      interpretation: { hypotheses: [{ schema_version: 1, hypothesis_id: "h",
        bindings: [{ schema_version: 1, variable: "c", value: "x" }] }], view }
    });
    expect(result.relationCalls).toContain("x\0cause");
    expect([...result.state.observed_relations ?? []].some((row) => row.sourceObjectId === "x" && row.predicate === "cause")).toBe(true);
    const assessed = assessUnknownCause(result.state, { as_of: AS_OF });
    expect([...assessed.claims.values()]).toContain("supported");
  });

  it("rejects nested repeat expansion before any native read under a tight envelope", () => {
    let program: QueryProgram = relation("p", "s", "t");
    for (let index = 0; index < 4; index += 1) program = { schema_version: 1, kind: "repeat",
      count: 8, local_variables: ["s", "t"], body: program };
    const result = fixture(program, [], { work: 200, memory: 10_000 });
    expect(result.relationCalls).toEqual([]);
    expect(result.state.last_observer_status).toBe("interrupted");
    expect(result.state.memory_exhausted).toBe(true);
  });
});
