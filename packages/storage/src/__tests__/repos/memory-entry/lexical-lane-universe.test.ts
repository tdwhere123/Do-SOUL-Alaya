import { afterEach, describe, expect, it } from "vitest";
import type { MemoryObjectKey } from "@do-soul/alaya-protocol";
import { StorageTier } from "@do-soul/alaya-protocol";
import { SqliteMemoryObjectKeyRepo } from "../../../repos/memory-entry/object-key-repo.js";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "./memory-entry-repo-fixture.js";

const HIT = "11111111-1111-4111-8111-111111111111";
const MISS = "22222222-2222-4222-8222-222222222222";
const TOMB = "33333333-3333-4333-8333-333333333333";
const DORM = "44444444-4444-4444-8444-444444444444";
const WARM = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const KEY_OWNER = "77777777-7777-4777-8777-777777777777";
const KEY_WARM = "88888888-8888-4888-8888-888888888888";

afterEach(() => {
  for (const database of trackedDatabases) database.close();
  trackedDatabases.clear();
});

describe("per-lane evaluated universe witness", () => {
  it("enumerates scoped membership independent of MATCH hits", async () => {
    const { repo, database } = await seedPopulation();
    const field = await repo.searchByKeywordField!(
      "workspace-1", "go stable", 8, {}, [], { variant: "lexical_relaxed" }
    );
    const exact = universe(field, "exact");
    const porter = universe(field, "porter");
    const trigram = universe(field, "trigram");
    const keyPorter = universe(field, "object_key_porter");

    expect(exact.tokens_routed).toBe(true);
    expect(porter.tokens_routed).toBe(true);
    expect(exact.candidate_keys).toEqual([HIT, MISS, WARM, KEY_OWNER].sort());
    expect(porter.candidate_keys).toEqual(exact.candidate_keys);
    expect(trigram.candidate_keys).toEqual(exact.candidate_keys);
    expect(exact.candidate_keys).not.toContain(TOMB);
    expect(exact.candidate_keys).not.toContain(DORM);
    expect(exact.candidate_keys).not.toContain(OTHER);
    expect(keyPorter.candidate_keys).toEqual([KEY_OWNER]);
    expect(universe(field, "object_key_trigram").candidate_keys).toEqual([KEY_OWNER]);
    expect(field.matches.map((row) => row.object_id)).toContain(HIT);
    expect(field.matches.map((row) => row.object_id)).not.toContain(MISS);
    expect(porter.count).toBe(porter.candidate_keys.length);

    database.connection.prepare(
      "DELETE FROM memory_content_fts_porter WHERE object_id = ?"
    ).run(MISS);
    const after = await repo.searchByKeywordField!(
      "workspace-1", "go stable", 8, {}, [], { variant: "lexical_relaxed" }
    );
    expect(universe(after, "exact").candidate_keys).toContain(MISS);
    expect(universe(after, "porter").candidate_keys).not.toContain(MISS);
    expect(universe(after, "trigram").candidate_keys).toContain(MISS);
  });

  it("applies workspace, tier, objectIds, tombstone, and dormant scope", async () => {
    const { repo } = await seedPopulation();
    const hot = await repo.searchByKeywordField!(
      "workspace-1", "go stable", 8, { tier: StorageTier.HOT }, [], { variant: "lexical_relaxed" }
    );
    expect(universe(hot, "exact").candidate_keys).toEqual([HIT, MISS, KEY_OWNER].sort());
    expect(universe(hot, "exact").scope.tier).toBe("hot");

    const scoped = await repo.searchByKeywordField!(
      "workspace-1", "go stable", 8, { objectIds: [MISS, HIT] }, [], { variant: "lexical_relaxed" }
    );
    expect(universe(scoped, "exact").candidate_keys).toEqual([HIT, MISS]);
    expect(universe(scoped, "exact").scope.object_ids).toEqual([HIT, MISS]);

    const other = await repo.searchByKeywordField!(
      "workspace-2", "go stable", 8, {}, [], { variant: "lexical_relaxed" }
    );
    expect(universe(other, "exact").candidate_keys).toEqual([OTHER]);
    expect(universe(other, "exact").scope.workspace_id).toBe("workspace-2");
  });

  it("encodes each lane's effective objectIds+tier scope, not a shared request stamp", async () => {
    const { repo, database } = await seedPopulation();
    await repo.create(createMemoryEntry({
      object_id: KEY_WARM,
      content: "Stable warm key owner.",
      storage_tier: StorageTier.WARM
    }));
    new SqliteMemoryObjectKeyRepo(database).replaceOwnerKeys("workspace-1", KEY_WARM, [
      objectKey(KEY_WARM)
    ]);
    const objectIds = [HIT, WARM, KEY_OWNER, KEY_WARM];
    const field = await repo.searchByKeywordField!(
      "workspace-1",
      "go stable",
      8,
      { objectIds, tier: StorageTier.HOT },
      [],
      { variant: "lexical_relaxed" }
    );
    const exact = universe(field, "exact");
    const porter = universe(field, "porter");
    const keyPorter = universe(field, "object_key_porter");
    expect(exact.scope).toEqual({
      workspace_id: "workspace-1",
      object_ids: [...objectIds].sort(),
      tier: "hot"
    });
    expect(porter.scope).toEqual({
      workspace_id: "workspace-1",
      object_ids: [...objectIds].sort(),
      tier: null
    });
    expect(universe(field, "trigram").scope.tier).toBeNull();
    expect(keyPorter.scope.tier).toBe("hot");
    expect(universe(field, "object_key_trigram").scope.tier).toBe(keyPorter.scope.tier);
    expect(exact.candidate_keys).toEqual([HIT, KEY_OWNER].sort());
    expect(porter.candidate_keys).toEqual([...objectIds].sort());
    expect(keyPorter.candidate_keys).toEqual([KEY_OWNER]);
    for (const lane of field.lexical_raw_rank_receipt?.lanes ?? []) {
      const keys = new Set(lane.evaluated_universe?.candidate_keys ?? []);
      expect(lane.rows.every((row) => keys.has(row.candidate_key))).toBe(true);
    }
  });

  it("treats empty objectIds as unscoped and SQL-ran empty as known empty", async () => {
    const { repo } = await seedPopulation();
    const unscoped = await repo.searchByKeywordField!(
      "workspace-1", "go stable", 8, { objectIds: [] }, [], { variant: "lexical_relaxed" }
    );
    expect(universe(unscoped, "exact").scope.object_ids).toBeNull();
    expect(universe(unscoped, "exact").candidate_keys.length).toBeGreaterThan(0);

    const empty = await repo.searchByKeywordField!(
      "workspace-1", "go stable", 8, { objectIds: ["does-not-exist"] }, [], { variant: "lexical_relaxed" }
    );
    expect(universe(empty, "exact").tokens_routed).toBe(true);
    expect(universe(empty, "exact").applicability).toEqual({ applicable: true });
    expect(universe(empty, "exact").candidate_keys).toEqual([]);
    expect(universe(empty, "exact").count).toBe(0);

    const { repo: emptyRepo } = await createRepo();
    const sqlEmpty = await emptyRepo.searchByKeywordField!(
      "workspace-1", "go stable", 8, {}, [], { variant: "lexical_relaxed" }
    );
    expect(universe(sqlEmpty, "porter").tokens_routed).toBe(true);
    expect(universe(sqlEmpty, "porter").candidate_keys).toEqual([]);
    expect(universe(sqlEmpty, "porter").count).toBe(0);
  });

  it("marks lanes with no routed tokens inapplicable instead of known-empty", async () => {
    const { repo } = await seedPopulation();
    const field = await repo.searchByKeywordField!(
      "workspace-1", "北京市", 8, {}, [], { variant: "lexical_relaxed" }
    );
    expect(universe(field, "porter")).toMatchObject({
      tokens_routed: false,
      applicability: { applicable: false, reason: "no_tokens_routed" },
      candidate_keys: [],
      count: 0
    });
    expect(universe(field, "object_key_porter").tokens_routed).toBe(false);
    expect(universe(field, "trigram").tokens_routed).toBe(true);
    expect(universe(field, "trigram").applicability).toEqual({ applicable: true });
  });

  it("does zero universe queries and omits the fat receipt when capture is off", async () => {
    const { repo, database } = await seedPopulation();
    const sql: string[] = [];
    const original = database.connection.prepare.bind(database.connection);
    database.connection.prepare = ((query: string) => {
      sql.push(query);
      return original(query);
    }) as typeof database.connection.prepare;

    const field = await repo.searchByKeywordField!("workspace-1", "go stable", 8);
    expect(field).not.toHaveProperty("lexical_raw_rank_receipt");
    expect(JSON.stringify(field)).not.toContain("evaluated_universe");
    expect(field.lexical_raw_rank?.lanes.every((lane) => !("evaluated_universe" in lane))).toBe(true);
    expect(sql.some(isUniverseExactSql)).toBe(false);
    expect(sql.some(isUniverseIndexedSql)).toBe(false);

    sql.length = 0;
    await repo.searchByKeywordField!(
      "workspace-1", "go stable", 8, {}, [], { variant: "lexical_relaxed" }
    );
    expect(sql.some(isUniverseExactSql)).toBe(true);
    expect(sql.some(isUniverseIndexedSql)).toBe(true);
  });

  it("round-trips the captured witness through JSON archive", async () => {
    const { repo } = await seedPopulation();
    const field = await repo.searchByKeywordField!(
      "workspace-1", "go stable", 8, {}, [], { variant: "lexical_relaxed" }
    );
    const archived = JSON.parse(JSON.stringify(field.lexical_raw_rank_receipt));
    expect(archived.lanes.map((lane: { lane_id: string }) => lane.lane_id)).toEqual(
      field.lexical_raw_rank_receipt?.lanes.map((lane) => lane.lane_id)
    );
    expect(archived.lanes[0].evaluated_universe.universe_digest)
      .toBe(universe(field, "exact").universe_digest);
  });
});

async function seedPopulation() {
  const { repo, database } = await createRepo();
  await repo.create(createMemoryEntry({
    object_id: HIT,
    content: "Stable review evidence needs exact witness lines."
  }));
  await repo.create(createMemoryEntry({
    object_id: MISS,
    content: "Unrelated garden notes without the query token."
  }));
  await repo.create(createMemoryEntry({
    object_id: TOMB,
    content: "Stable tombstone should not join the universe.",
    retention_state: "tombstoned"
  }));
  await repo.create(createMemoryEntry({
    object_id: DORM,
    content: "Stable dormant should not join the universe.",
    lifecycle_state: "dormant"
  }));
  await repo.create(createMemoryEntry({
    object_id: WARM,
    content: "Stable warm-tier row.",
    storage_tier: StorageTier.WARM
  }));
  await repo.create(createMemoryEntry({
    object_id: OTHER,
    workspace_id: "workspace-2",
    run_id: "run-3",
    content: "Stable row in another workspace."
  }));
  await repo.create(createMemoryEntry({
    object_id: KEY_OWNER,
    content: "Key owner content without the query token either."
  }));
  new SqliteMemoryObjectKeyRepo(database).replaceOwnerKeys("workspace-1", KEY_OWNER, [
    objectKey(KEY_OWNER)
  ]);
  return { repo, database };
}

function universe(
  field: Awaited<ReturnType<NonNullable<
    Awaited<ReturnType<typeof createRepo>>["repo"]["searchByKeywordField"]
  >>>,
  laneId: string
) {
  const lane = field.lexical_raw_rank_receipt?.lanes.find((item) => item.lane_id === laneId);
  if (lane?.evaluated_universe === undefined) {
    throw new Error(`expected universe for ${laneId}`);
  }
  return lane.evaluated_universe;
}

function objectKey(ownerId: string): MemoryObjectKey {
  return {
    schema_version: 1,
    workspace_id: "workspace-1",
    owner_id: ownerId,
    key_id: "gist-retriever",
    key_type: "gist_remainder",
    surface: "Golden Retriever",
    normalized_surface: "golden retriever",
    language: "en",
    source_kind: "evidence_gist",
    source_ref: "evidence:capsule-1:gist:0:16"
  };
}

function isUniverseExactSql(sql: string): boolean {
  return /SELECT\s+object_id\s+FROM\s+memory_entries/iu.test(sql) && !/content,/u.test(sql);
}

function isUniverseIndexedSql(sql: string): boolean {
  return /SELECT\s+DISTINCT/iu.test(sql) && /MATCH\s+\?/u.test(sql) && !/bm25/u.test(sql);
}
