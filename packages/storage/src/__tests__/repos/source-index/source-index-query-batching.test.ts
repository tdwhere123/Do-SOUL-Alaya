import { afterEach, describe, expect, it, vi } from "vitest";
import { splitFtsLanes, type SourceIndexLexicalRead, type SourceIndexVectorRead } from "@do-soul/alaya-protocol";
import { tokenizeFtsQuery } from "../../../repos/shared/fts-lane-routing.js";
import {
  QUERY_BUDGET, WORKSPACE, fixture, laneMatch, publishIndexed, rankedLane, vectorWindowIds, type Fixture
} from "./source-index-query-fixture.js";
import { buildReady, configuration, publishSource } from "./source-index-fixture.js";

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
type Rows = Record<string, unknown>[];
/** Rows every executed statement of this connection returned, keyed by SQL text. */
function observeRows(environment: Fixture) {
  const prototype = Object.getPrototypeOf(environment.database.connection.prepare("SELECT 1")) as {
    all(): unknown[]; get(): unknown;
  };
  const all = vi.spyOn(prototype, "all"), get = vi.spyOn(prototype, "get");
  const sourceOf = (context: unknown) => (context as { source: string }).source;
  return {
    reset: () => { all.mockClear(); get.mockClear(); },
    batches: (needle: string): Rows[] => all.mock.contexts.flatMap((context, index) =>
      sourceOf(context).includes(needle) && all.mock.results[index]!.type === "return"
        ? [all.mock.results[index]!.value as Rows] : []),
    gets: (needle: string) => get.mock.contexts.filter(context => sourceOf(context).includes(needle)).length
  };
}
const fetchedLexicalBytes = (rows: Rows) => rows.reduce((sum, row) =>
  sum + 24 + Buffer.byteLength(row.root_key as string) + (row.metadata_bytes as number), 0);
const BODY = "alpha 部署流水线配置";
function publishBoth(environment: Fixture, count: number) {
  return Array.from({ length: count }, (_, index) =>
    publishIndexed(environment, `${BODY} ${"alpha ".repeat(index)}unique${index}`, `both-${index}`));
}
const query = "alpha 部署流水线";
const lanes = splitFtsLanes(tokenizeFtsQuery(query));
function independentLanes(environment: Fixture) {
  return {
    unicode61: rankedLane(environment.database, "source_index_fts", WORKSPACE, laneMatch(lanes.porterTokens)).map(row => row.root_key),
    trigram: rankedLane(environment.database, "source_index_fts_trigram", WORKSPACE, laneMatch(lanes.trigramTokens)).map(row => row.root_key)
  };
}

describe("source index lexical lane batches", () => {
  it("alternates lanes across batch boundaries in each lane's independent ranking order", () => {
    const environment = setup();
    publishBoth(environment, 6);
    const expected = independentLanes(environment);
    expect(expected.unicode61).toHaveLength(6);
    expect(expected.trigram).toHaveLength(6);
    const read = environment.index.readLexicalCandidates(WORKSPACE, query, 7, QUERY_BUDGET);
    expect(read).toMatchObject({ completion: "partial", reason: "candidate_limit" });
    expect(read.candidates.map(candidate => candidate.lexical.lane))
      .toEqual(["unicode61", "trigram", "unicode61", "trigram", "unicode61", "trigram", "unicode61"]);
    expect(read.candidates.map(candidate => candidate.lexical.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const lane of ["unicode61", "trigram"] as const) {
      const own = read.candidates.filter(candidate => candidate.lexical.lane === lane);
      expect(own.map(candidate => candidate.source.root_key)).toEqual(expected[lane].slice(0, own.length));
      expect(own.map(candidate => candidate.lexical.lane_rank)).toEqual(own.map((_, index) => index + 1));
    }
  });

  it("completes only after every lane has probed past its last row, as one statement per lane", () => {
    const environment = setup();
    publishBoth(environment, 5);
    const observed = observeRows(environment);
    const complete = environment.index.readLexicalCandidates(WORKSPACE, query, 128, QUERY_BUDGET);
    expect(complete).toMatchObject({ completion: "complete", reason: null });
    expect(complete.candidates).toHaveLength(10);
    // Each lane asks for its whole share once, gets fewer rows than asked and is therefore finished.
    expect(observed.batches("MATCH")).toHaveLength(2);
    expect(observed.gets("MATCH")).toBe(0);
    const bounded = environment.index.readLexicalCandidates(WORKSPACE, query, 10, QUERY_BUDGET);
    expect(bounded).toMatchObject({ completion: "partial", reason: "candidate_limit" });
    expect(bounded.candidates.map(candidate => candidate.source.root_key))
      .toEqual(complete.candidates.map(candidate => candidate.source.root_key));
  });

  it("orders equal scores by root_key across the rows of one batch", () => {
    const environment = setup();
    const published = Array.from({ length: 5 }, (_, index) => publishIndexed(environment, "shared alpha phrase", `tie-${index}`));
    const sorted = published.map(row => row.source.root_key).sort((left, right) => left < right ? -1 : 1);
    const read = environment.index.readLexicalCandidates(WORKSPACE, "alpha", 3, QUERY_BUDGET);
    expect(read.candidates.map(candidate => candidate.source.root_key)).toEqual(sorted.slice(0, 3));
    expect(new Set(read.candidates.map(candidate => candidate.lexical.bm25)).size).toBe(1);
    expect(read.candidates.map(candidate => candidate.lexical.lane_rank)).toEqual([1, 2, 3]);
  });

  it("pays for every fetched row and keeps a consumed prefix at each budget refusal point", () => {
    const environment = setup();
    publishBoth(environment, 6);
    const observed = observeRows(environment);
    const full = environment.index.readLexicalCandidates(WORKSPACE, query, 8, QUERY_BUDGET);
    const runs: { read: SourceIndexLexicalRead; fetched: Rows[] }[] = [];
    const step = Math.max(1, Math.floor(full.resources.work / 120));
    for (let work = 0; work <= full.resources.work + step; work += step) {
      observed.reset();
      const budget = { work_units: work, memory_bytes: QUERY_BUDGET.memory_bytes };
      runs.push({ read: environment.index.readLexicalCandidates(WORKSPACE, query, 8, budget), fetched: observed.batches("MATCH") });
      const { read, fetched } = runs.at(-1)!;
      expect(read.resources.work).toBeLessThanOrEqual(work);
      expect(read.candidates.map(candidate => candidate.source.root_key))
        .toEqual(full.candidates.slice(0, read.candidates.length).map(candidate => candidate.source.root_key));
      expect(read.resources.native_bytes).toBeGreaterThanOrEqual(fetched.reduce((sum, rows) => sum + fetchedLexicalBytes(rows), 0));
    }
    expect(full).toMatchObject({ completion: "partial", reason: "candidate_limit" });
    // The sweep must reach refusals after rows were already read, or it proves nothing about their payment.
    expect(runs.some(({ read, fetched }) => read.reason === "read_budget" && fetched.length > 0
      && read.candidates.length < fetched.flat().length)).toBe(true);
    expect(runs.every(({ read }) => read.reason !== "read_budget" || read.resource_refusal?.stage === "lexical")).toBe(true);
  });

  it("does not read far past what a small remaining budget could decode", () => {
    const environment = setup();
    publishBoth(environment, 6);
    const observed = observeRows(environment);
    const read = environment.index.readLexicalCandidates(WORKSPACE, query, 12, { work_units: 600, memory_bytes: QUERY_BUDGET.memory_bytes });
    expect(read.reason).toBe("read_budget");
    // One row decodes for at least its JSON byte count in work, so 600 units cannot consume a full batch.
    expect(observed.batches("MATCH").flat().length).toBeLessThanOrEqual(2 * 2);
  });
});

describe("source index vector pages", () => {
  function manyWindows(environment: Fixture) {
    publishSource(environment, "w".repeat(200), "wide");
    const ready = buildReady(environment, configuration({ window_bytes: 8 }));
    const expected = vectorWindowIds(environment.database, WORKSPACE, ready.generation.generation_id);
    expect(expected.length).toBeGreaterThanOrEqual(20);
    return expected;
  }

  it("chains cursor pages of one statement each into the single-read window order", () => {
    const environment = setup();
    const expected = manyWindows(environment);
    const observed = observeRows(environment);
    const seen: string[] = [];
    let cursor: SourceIndexVectorRead["cursor"] = null, pages = 0;
    for (;;) {
      const page = environment.index.readVectorCandidates(WORKSPACE, cursor, 7, QUERY_BUDGET);
      seen.push(...page.candidates.map(candidate => candidate.window.window_id)); pages++;
      if (page.completion === "complete") break;
      expect(page).toMatchObject({ completion: "partial", reason: "window_page_limit", inspected: 7 });
      cursor = page.cursor;
    }
    expect(seen).toEqual(expected);
    expect(observed.batches("ORDER BY v.window_id ASC LIMIT")).toHaveLength(pages);
    expect(observed.gets("ORDER BY v.window_id ASC LIMIT")).toBe(0);
  });

  it("reads one target per root in a page and none for a root the capture already owns", () => {
    const environment = setup();
    manyWindows(environment);
    const observed = observeRows(environment);
    const page = environment.index.readVectorCandidates(WORKSPACE, null, 16, QUERY_BUDGET);
    expect(page.inspected).toBe(16);
    expect(observed.batches("ORDER BY v.window_id ASC LIMIT").flat().every(row => !("target_json" in row))).toBe(true);
    expect(observed.batches("FROM source_index_roots").flat()).toHaveLength(1);
    expect(new Set(page.candidates.map(candidate => candidate.source)).size).toBe(1);
  });

  it("never fetches more windows than the remaining budget can consume and pays for what it fetched", () => {
    const environment = setup();
    const expected = manyWindows(environment);
    const observed = observeRows(environment);
    const full = environment.index.readVectorCandidates(WORKSPACE, null, 24, QUERY_BUDGET);
    expect(full.candidates.map(candidate => candidate.window.window_id)).toEqual(expected.slice(0, 24));
    const step = Math.max(1, Math.floor(full.resources.work / 150));
    let refusedAfterRows = false;
    for (let work = 0; work <= full.resources.work + step; work += step) {
      observed.reset();
      const read = environment.index.readVectorCandidates(WORKSPACE, null, 24, { work_units: work, memory_bytes: QUERY_BUDGET.memory_bytes });
      const fetched = observed.batches("ORDER BY v.window_id ASC LIMIT").flat();
      expect(read.resources.work).toBeLessThanOrEqual(work);
      expect(read.candidates.map(candidate => candidate.window.window_id))
        .toEqual(expected.slice(0, read.candidates.length));
      expect(read.cursor?.after_window_id ?? null).toBe(read.inspected === 0 ? null : expected[read.inspected - 1]);
      // A consumed window charges at least 6 + dimensions work (3 here), so a page never outruns the budget.
      expect(fetched.length).toBeLessThanOrEqual(Math.floor(work / 9) + 1);
      expect(read.resources.native_bytes).toBeGreaterThanOrEqual(fetched.reduce((sum, row) =>
        sum + (row.window_bytes as number) + (row.embedding_blob as Buffer).length, 0));
      refusedAfterRows ||= read.reason === "read_budget" && read.inspected > 0;
    }
    expect(refusedAfterRows).toBe(true);
  });
});
