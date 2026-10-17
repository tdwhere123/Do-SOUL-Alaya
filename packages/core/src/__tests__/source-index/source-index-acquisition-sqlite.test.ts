import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sourceIndexProfileId, type SourceIndexQueryVector, type SourceIndexScopeAdmission
} from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import {
  WORKSPACE, configuration, fieldSha256, fixture, publishSource, type Fixture
} from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import {
  AXIS_ROOTS, QUERY_BUDGET, admitScope, digest, expectBounded, expectMetadataOnly, publishIndex, query, queryInput
} from "./source-index-acquisition-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});
function setup() {
  const environment = fixture();
  environments.push(environment);
  return environment;
}
const compareKey = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

describe("source index acquisition through native SQLite", () => {
  it("nominates vector-only roots independently, interleaves roots, and preserves overlapping lane ranks", () => {
    const environment = setup();
    const { documents } = publishIndex(environment);
    const roots = Object.fromEntries(documents.map(document => [document.source.source_id, document]));
    // Equal-length, single-occurrence lexical documents have equal BM25, then root-key ties.
    const lexical = [roots.lexical!, roots.overlap!].sort((a, b) => compareKey(a.source.root_key, b.source.root_key));
    const cosineTies = [roots.lexical!, roots.tie!].sort((a, b) => compareKey(a.source.root_key, b.source.root_key));
    const vector = [roots["vector-only"]!, ...cosineTies, roots.overlap!, roots.negative!];
    const input = queryInput();
    if (input.vector.status !== "available") throw new Error("expected supplied query vector");
    const result = query(environment, input, admitScope);
    expectBounded(result, input);
    expect(result.lexical).toMatchObject({ completion: "complete", index_coverage: "partial" });
    expect(result.vector).toMatchObject({ completion: "complete", state: { status: "ready" }, inspected_windows: 7,
      invalid_windows: 0, ranking: "exact_over_inspected_subset", validation: "validated",
      input: { status: "available", profile_id: input.vector.profile_id, input_digest: digest("needle") } });
    expect(result.accounting).toEqual({ attempted: 7, admitted: 5, duplicate: 2, rejected: 0,
      scope_denied: 0, native_unknown: 0, resource_refused: 0, stale: 0, nomination_limit: 0 });
    expect(result.resource_refusals).toEqual([]);
    const schedule = [lexical[0]!, vector[0]!, lexical[1]!, ...vector.slice(1)];
    expect(result.nominations.map(candidate => candidate.source.source_id))
      .toEqual([...new Set(schedule.map(document => document.source.source_id))]);
    for (const [rank, document] of vector.entries()) {
      const nomination = result.nominations.find(candidate => candidate.source.source_id === document.source.source_id)!;
      expect(nomination.source).toEqual(document.source);
      expect(nomination.vector?.rank).toBe(rank + 1);
      const expectedCosine = document.source.source_id === "vector-only" ? 1 :
        document.source.source_id === "negative" ? -1 : document.source.source_id === "overlap" ? 0 : 0.6;
      expect(nomination.vector?.cosine).toBeCloseTo(expectedCosine, 12);
      const expectedWindow = document.source.source_id === "tie"
        ? [...document.windows].sort((a, b) => compareKey(a.window_id, b.window_id))[0]! : document.windows[0]!;
      expect(nomination.vector?.window).toEqual({ window_id: expectedWindow.window_id,
        start_byte: expectedWindow.start_byte, end_byte: expectedWindow.end_byte, content_digest: digest(expectedWindow.text) });
      const lexicalRank = lexical.findIndex(candidate => candidate.source.root_key === document.source.root_key);
      expect(nomination.lexical).toEqual(lexicalRank < 0 ? [] : [{ rank: lexicalRank + 1, lane: "unicode61",
        lane_rank: lexicalRank + 1, bm25: expect.any(Number) }]);
    }
    expect(result.nominations.find(candidate => candidate.source.source_id === "vector-only")?.lexical).toEqual([]);
    expect(result.limitations).toEqual(expect.arrayContaining(["nominations_are_not_source_absence",
      "sqlite_internal_work_unknown", "lexical_corpus_coverage_untracked", "caller_owned_read_snapshot_required"]));
    expectMetadataOnly(result, AXIS_ROOTS.map(root => root.body));
    expect(query(environment, input, admitScope)).toEqual(result);
  });

  it.each([
    { axis: [7, 0, 0], cosine: 1, start: 0, end: 8 },
    { axis: [0, 7, 0], cosine: 1, start: 8, end: 16 },
    { axis: [0, 0, 7], cosine: 0, start: null, end: null }
  ])("uses positive dot-axis $axis and chooses the best window rather than raw dot magnitude", expected => {
    const environment = setup();
    const { documents } = publishIndex(environment, [AXIS_ROOTS[2]!]);
    const input = queryInput();
    if (input.vector.status !== "available") throw new Error("expected bound query vector");
    const result = query(environment, { ...input, vector: { ...input.vector, embedding: new Float32Array(expected.axis) } }, admitScope);
    const winner = result.nominations[0]!.vector!;
    expect(winner.cosine).toBe(expected.cosine);
    const window = expected.start === null
      ? [...documents[0]!.windows].sort((a, b) => compareKey(a.window_id, b.window_id))[0]!
      : documents[0]!.windows.find(candidate => candidate.start_byte === expected.start)!;
    expect(winner.window).toEqual({ window_id: window.window_id, start_byte: expected.start ?? window.start_byte,
      end_byte: expected.end ?? window.end_byte, content_digest: digest(window.text) });
    expect(result.accounting).toMatchObject({ attempted: 1, admitted: 1, duplicate: 0 });
  });

  it("requires scope authorization, skips denied roots without a bonus refill, and preserves the full native tuple", () => {
    const environment = setup();
    const { documents } = publishIndex(environment);
    const firstLexical = documents.filter(document => ["lexical", "overlap"].includes(document.source.source_id))
      .sort((a, b) => compareKey(a.source.root_key, b.source.root_key))[0]!;
    const vectorOnly = documents.find(document => document.source.source_id === "vector-only")!;
    const input = queryInput(configuration(), { allowance: { max_attempts: 2, max_roots: 2, max_vector_windows: 64 } });
    const authorize = vi.fn<SourceIndexScopeAdmission>((scope, source) => {
      expect(source).toEqual(documents.find(document => document.source.root_key === source.root_key)!.source);
      expect(scope).toBe(source.source_id === "overlap" ? "global_core" : "project");
      return source.source_id === firstLexical.source.source_id ? "denied" : "admitted";
    });
    const result = query(environment, input, authorize);
    expectBounded(result, input);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(result.nominations.map(candidate => candidate.source)).toEqual([vectorOnly.source]);
    expect(result.accounting).toEqual({ attempted: 2, admitted: 1, duplicate: 0, rejected: 1,
      scope_denied: 1, native_unknown: 0, resource_refused: 0, stale: 0, nomination_limit: 0 });
    expect(result.completion).toBe("partial");
    const read = vi.spyOn(environment.index, "readLexicalCandidates");
    expect(() => new SourceIndexAcquisition(environment.index, fieldSha256)
      .nominate(input, undefined as unknown as SourceIndexScopeAdmission)).toThrow(/scope admission/u);
    expect(read).not.toHaveBeenCalled();
  });

  it("honors the caller's one-root and three-attempt limits instead of adopting safety ceilings", () => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput(configuration(), { allowance: { max_attempts: 3, max_roots: 1, max_vector_windows: 64 } });
    const result = query(environment, input, admitScope);
    expectBounded(result, input);
    expect(result.accounting).toMatchObject({ attempted: 3, admitted: 1, rejected: 2, nomination_limit: 2 });
    expect(result.completion).toBe("partial");
  });

  it("reports only the inspected window prefix, not a global nearest-neighbor result or source absence", () => {
    const environment = setup();
    const { documents } = publishIndex(environment);
    const inspected = documents.flatMap(document => document.windows.map(window => ({ source: document.source, window })))
      .sort((a, b) => compareKey(a.window.window_id, b.window.window_id))[0]!;
    const input = queryInput(configuration(), { allowance: { max_attempts: 16, max_roots: 8, max_vector_windows: 1 } });
    const result = query(environment, input, admitScope);
    expectBounded(result, input);
    expect(result.vector).toMatchObject({ completion: "partial", reason: "window_limit", inspected_windows: 1,
      state: { status: "ready" }, ranking: "exact_over_inspected_subset" });
    expect(result.completion).toBe("partial");
    const vectorNominations = result.nominations.filter(candidate => candidate.vector !== null);
    expect(vectorNominations.map(candidate => candidate.source)).toEqual([inspected.source]);
    expect(vectorNominations[0]!.vector?.window.window_id).toBe(inspected.window.window_id);
    expect(vectorNominations[0]!.vector?.rank).toBe(1);
    expect(result.lexical.index_coverage).toBe("partial");
    expect(result.limitations).toContain("nominations_are_not_source_absence");
  });

  it("retains lexical results when the caller grants zero vector windows", () => {
    const environment = setup();
    publishIndex(environment);
    const scan = vi.spyOn(environment.index, "readVectorCandidates");
    const input = queryInput(configuration(), { allowance: { max_attempts: 4, max_roots: 2, max_vector_windows: 0 } });
    const result = query(environment, input, admitScope);
    expectBounded(result, input);
    expect(scan).not.toHaveBeenCalled();
    expect(result.vector).toMatchObject({ completion: "partial", reason: "window_limit", inspected_windows: 0 });
    expect(result.nominations).toHaveLength(2);
    expect(result.nominations.every(candidate => candidate.vector === null)).toBe(true);
    expect(result.completion).toBe("partial");
  });

  it("preserves partial index state after a real source publication without inventing complete corpus coverage", () => {
    const environment = setup();
    const { generation } = publishIndex(environment);
    publishSource(environment, "new unindexed source", "later-source");
    const result = query(environment, queryInput(), admitScope);
    expect(result.nominations).toHaveLength(5);
    expect(result.vector).toMatchObject({ completion: "complete", state: { status: "partial", binding: {
      generation_id: generation.generation_id, source_epoch: generation.source_epoch
    } }, ranking: "exact_over_inspected_subset" });
    expect(result.lexical.index_coverage).toBe("partial");
    expect(result.nominations.some(candidate => candidate.source.source_id === "later-source")).toBe(false);
    expect(result.limitations).toContain("lexical_corpus_coverage_untracked");
  });

  it("distinguishes missing selection, unbound selection, and an activated valid-empty vector index", () => {
    const environment = setup();
    const input = queryInput();
    const unknown = query(environment, input, admitScope);
    expect(unknown.vector).toMatchObject({ completion: "unavailable", state: { status: "unknown", reason: "missing_selection" } });
    expect(unknown.completion).not.toBe("complete");
    const selection = environment.index.select(WORKSPACE, configuration());
    expect(query(environment, input, admitScope).vector).toMatchObject({ completion: "unavailable",
      state: { status: "unbound", reason: "no_active_generation" } });
    const generation = environment.index.begin(selection);
    environment.index.capturePage(WORKSPACE, generation.generation_id, 8, { work: 1000, native_bytes: 262144 });
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
    const empty = query(environment, input, admitScope);
    expect(empty.vector).toMatchObject({ completion: "complete", state: { status: "valid_empty" }, inspected_windows: 0 });
    expect(empty.nominations).toEqual([]);
    expect(empty.limitations).toContain("nominations_are_not_source_absence");
  });

  it.each(["unsupported", "query_unavailable"])("keeps an unavailable %s query distinct from valid empty while lexical retrieval survives", reason => {
    const environment = setup();
    publishIndex(environment);
    const scan = vi.spyOn(environment.index, "readVectorCandidates");
    const result = query(environment, queryInput(configuration(), { vector: { status: "unavailable", reason } }), admitScope);
    expect(scan).not.toHaveBeenCalled();
    expect(result.vector).toMatchObject({ completion: "unavailable", state: null, reason, validation: "not_applicable",
      input: { status: "unavailable", reason } });
    expect(result.nominations).toHaveLength(2);
    expect(result.completion).toBe("partial");
    expect(result.resource_refusals).toEqual([]);
  });
});

describe("query input validation and binding", () => {
  it.each([
    ["profile digest", "profile_binding_mismatch", { profile_id: `sha256:${"0".repeat(64)}` }],
    ["input digest", "input_binding_mismatch", { input_digest: digest("different navigation") }],
    ["dimensions", "invalid_query_vector", { embedding: new Float32Array([1, 0]) }],
    ["zero norm", "invalid_query_vector", { embedding: new Float32Array([0, 0, 0]) }],
    ["NaN", "invalid_query_vector", { embedding: new Float32Array([NaN, 0, 0]) }],
    ["infinity", "invalid_query_vector", { embedding: new Float32Array([Infinity, 0, 0]) }],
    ["profile shape", "invalid_profile", { profile: { ...configuration().profile, dimensions: 0 } }]
  ] as const)("rejects %s without discarding lexical results", (_label, reason, changes) => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput();
    if (input.vector.status !== "available") throw new Error("expected query vector");
    const scan = vi.spyOn(environment.index, "readVectorCandidates");
    const vector = { ...input.vector, ...changes };
    const result = query(environment, { ...input, vector }, admitScope);
    expect(result.vector).toMatchObject({ completion: "unavailable", reason, inspected_windows: 0, validation: "invalid",
      input: { status: "available", profile_id: vector.profile_id, input_digest: vector.input_digest } });
    expect(result.completion).toBe("partial");
    expect(result.resource_refusals).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
    expect(result.nominations).toHaveLength(2);
  });

  it("rejects a self-consistent query profile that does not match the selected native generation", () => {
    const environment = setup();
    publishIndex(environment);
    const profile = configuration({ dimensions: 4 }).profile;
    const input = queryInput(configuration(), { vector: { status: "available", profile,
      profile_id: sourceIndexProfileId(profile, fieldSha256), input_digest: digest("needle"), embedding: new Float32Array([1, 0, 0, 0]) } });
    const result = query(environment, input, admitScope);
    expect(result.vector).toMatchObject({ completion: "unavailable", reason: "selected_profile_mismatch", state: { status: "ready" },
      validation: "validated", input: { status: "available", profile_id: sourceIndexProfileId(profile, fieldSha256),
        input_digest: digest("needle") } });
    expect(result.nominations).toHaveLength(2);
    expect(result.nominations.every(candidate => candidate.vector === null)).toBe(true);
  });
});

describe("explicit adapter/input injections, not native boundary evidence", () => {
  it.each([42, [1, 0, 0]])("rejects a non-Float32 scalar/vector input %j", embedding => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput();
    const vector = { ...input.vector, embedding } as unknown as SourceIndexQueryVector;
    if (vector.status !== "available") throw new Error("expected supplied query vector");
    expect(query(environment, { ...input, vector }, admitScope).vector).toMatchObject({ completion: "unavailable",
      reason: "invalid_query_vector", validation: "invalid", input: { status: "available",
        profile_id: vector.profile_id, input_digest: vector.input_digest } });
  });

  it("captures query-vector, budget and allowance values before a reentrant adapter mutates caller-owned input", () => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput();
    const mutable = input as { budget: { work_units: number; memory_bytes: number };
      allowance: { max_attempts: number; max_roots: number; max_vector_windows: number } };
    const read = environment.index.readLexicalCandidates.bind(environment.index);
    vi.spyOn(environment.index, "readLexicalCandidates").mockImplementation((...args) => {
      const result = read(...args);
      if (input.vector.status === "available") input.vector.embedding.set([-5, 0, 0]);
      mutable.budget.work_units = 0;
      mutable.allowance.max_attempts = 1;
      return result;
    });
    const result = query(environment, input, admitScope);
    expect(result.nominations.find(candidate => candidate.source.source_id === "vector-only")?.vector?.cosine).toBe(1);
    expect(result.accounting.attempted).toBe(7);
    expect(result.resources.work).toBeLessThanOrEqual(QUERY_BUDGET.work_units);
  });

  it("marks malformed adapter vectors partial instead of treating them as valid empty", () => {
    const environment = setup();
    publishIndex(environment);
    const scan = environment.index.readVectorCandidates.bind(environment.index);
    vi.spyOn(environment.index, "readVectorCandidates").mockImplementation((...args) => {
      const page = scan(...args);
      return { ...page, candidates: page.candidates.map(candidate => ({ ...candidate, embedding: new Float32Array([NaN, 0, 0]) })) };
    });
    const result = query(environment, queryInput(), admitScope);
    expect(result.vector).toMatchObject({ completion: "partial", reason: "invalid_vectors", invalid_windows: 7 });
    expect(result.nominations).toHaveLength(2);
    expect(result.nominations.every(candidate => candidate.vector === null)).toBe(true);
    expect(result.completion).toBe("partial");
  });
});
