import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "./memory-entry-repo-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("keyword field lexical raw-rank receipt emit", () => {
  it("omits the fat sibling when capture-proof is off", async () => {
    const repo = await seedRepo();
    const field = await repo.searchByKeywordField!("workspace-1", "stable", 1);

    expect(field.lexical_raw_rank).toBeDefined();
    expect(field.lexical_raw_rank?.lanes.every((lane) => !("rows" in lane))).toBe(true);
    expect(field.lexical_raw_rank?.lanes.every((lane) => !("evaluated_universe" in lane))).toBe(true);
    expect(field).not.toHaveProperty("lexical_raw_rank_receipt");
    expect(field).not.toHaveProperty("lexical_bound_proof");
  });

  it("attaches the full base sibling only when capture-proof is on", async () => {
    const repo = await seedRepo();
    const field = await repo.searchByKeywordField!(
      "workspace-1", "stable", 1, {}, [], { variant: "lexical_relaxed" }
    );
    const porter = field.lexical_raw_rank_receipt?.lanes.find((lane) =>
      lane.lane_id === "porter"
    );

    expect(field.lexical_raw_rank?.lanes.every((lane) => !("rows" in lane))).toBe(true);
    expect(field.lexical_raw_rank_receipt?.query_run_id)
      .toBe("memory.keyword.lexical_relaxed.depth:1");
    expect(porter?.status).toBe("truncated");
    expect(porter?.requested_limit).toBe(1);
    expect(porter?.rows.length).toBeGreaterThan(0);
    expect(porter?.unseen_upper_bound).toBe(porter?.rows.at(-1)?.grouped_ordinal);
    expect(porter?.evaluated_universe?.tokens_routed).toBe(true);
    expect(porter?.evaluated_universe?.candidate_keys.length).toBeGreaterThan(0);
    expect(field.lexical_raw_rank_receipt?.lanes.find((lane) => lane.lane_id === "exact")
      ?.evaluated_universe).toMatchObject({
      tokens_routed: false,
      applicability: { applicable: false, reason: "no_tokens_routed" }
    });

    const expanded = await repo.searchByKeywordField!(
      "workspace-1", "stable", 1, {}, [], { variant: "lexical_expanded" }
    );
    expect(expanded.lexical_raw_rank_receipt?.query_run_id)
      .toBe("memory.keyword.lexical_expanded.depth:1");
    expect(expanded.lexical_raw_rank_receipt?.query_run_id)
      .not.toBe(field.lexical_raw_rank_receipt?.query_run_id);
  });

  it("does not clone diagnostic siblings onto refinements", async () => {
    const repo = await seedRepo();
    const field = await repo.searchByKeywordField!(
      "workspace-1", "stable", 1, {}, [2], { variant: "lexical_relaxed" }
    );
    const level = field.refinement_levels?.[0];

    expect(field.lexical_raw_rank_receipt).toBeDefined();
    expect(level).toBeDefined();
    expect(level).not.toHaveProperty("lexical_raw_rank");
    expect(level).not.toHaveProperty("lexical_raw_rank_receipt");
    expect(level?.matches.length).toBeGreaterThan(field.matches.length);
  });
});

async function seedRepo() {
  const { repo } = await createRepo();
  await repo.create(createMemoryEntry({
    object_id: "66666666-1111-4111-8111-111111111111",
    content: "Stable review evidence needs exact witness lines."
  }));
  await repo.create(createMemoryEntry({
    object_id: "77777777-2222-4222-8222-222222222222",
    content: "Stable review evidence matters more."
  }));
  return repo;
}
