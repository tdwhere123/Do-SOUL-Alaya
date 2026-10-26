import { afterEach, describe, expect, it, vi } from "vitest";
import { configuration, fixture, type Fixture } from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { admitScope, digest, publishIndex, query, queryInput } from "./source-index-acquisition-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});

// Latin and CJK terms put every root into both lexical lanes.
const NAVIGATION = "alpha 部署流水线";
const roots = ["aa", "bb"].map(id => ({ id, body: `${NAVIGATION} ${id}`, vectors: [[1, 0, 0]] }));

describe("one acquisition decides each root once per binding mode", () => {
  function setup() {
    const environment = fixture();
    environments.push(environment);
    const config = configuration({ window_bytes: 64 });
    publishIndex(environment, roots, config);
    return { environment, config };
  }

  it("reuses a root's admission when both lexical lanes nominate it", () => {
    const { environment, config } = setup();
    const admit = vi.spyOn(environment.index, "admitQueryCandidate");
    const input = queryInput(config, { navigation_text: NAVIGATION, vector: { status: "unavailable", reason: "not_requested" } });
    const result = query(environment, input, admitScope);
    expect(result.accounting).toMatchObject({ attempted: 4, admitted: 2, duplicate: 2, rejected: 0 });
    expect(result.nominations.map(nomination => nomination.lexical.map(rank => rank.lane)))
      .toEqual([["unicode61", "trigram"], ["unicode61", "trigram"]]);
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it("keeps the vector binding check separate from the unbound lexical admission", () => {
    const { environment, config } = setup();
    const admit = vi.spyOn(environment.index, "admitQueryCandidate");
    const base = queryInput(config, { navigation_text: NAVIGATION });
    if (base.vector.status !== "available") throw new Error("expected query vector");
    const result = query(environment, { ...base, vector: { ...base.vector, input_digest: digest(NAVIGATION) } }, admitScope);
    expect(result.accounting).toMatchObject({ attempted: 6, admitted: 2, duplicate: 4, rejected: 0 });
    expect(admit.mock.calls.filter(call => call[1] === null)).toHaveLength(2);
    expect(admit.mock.calls.filter(call => call[1] !== null)).toHaveLength(2);
  });
});
