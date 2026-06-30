import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENTITY_GROUP_CAP,
  buildEntityIndex,
  expandByEntity,
  groupCandidatesByEntity,
  type EntityCandidate,
  type EntityGroup
} from "../../recall/entity-expansion.js";

function candidate(objectId: string, canonicalEntities: readonly string[] | null | undefined): EntityCandidate {
  return { objectId, canonicalEntities };
}

describe("buildEntityIndex", () => {
  it("maps each canonical entity to its objectIds in input order", () => {
    const index = buildEntityIndex([
      candidate("m1", ["postgres", "alice"]),
      candidate("m2", ["postgres"]),
      candidate("m3", ["alice"])
    ]);
    expect(index.get("postgres")).toEqual(["m1", "m2"]);
    expect(index.get("alice")).toEqual(["m1", "m3"]);
  });

  it("lowercase-normalizes and skips empty/whitespace entities", () => {
    const index = buildEntityIndex([candidate("m1", ["Postgres", "  ", "ALICE"]), candidate("m2", [" postgres "])]);
    expect([...index.keys()].sort()).toEqual(["alice", "postgres"]);
    expect(index.get("postgres")).toEqual(["m1", "m2"]);
  });

  it("de-duplicates an objectId within one candidate when entities collapse after normalization", () => {
    const index = buildEntityIndex([candidate("m1", ["Postgres", "postgres"])]);
    expect(index.get("postgres")).toEqual(["m1"]);
  });

  it("skips null/undefined/empty entity arrays", () => {
    const index = buildEntityIndex([candidate("m1", null), candidate("m2", undefined), candidate("m3", [])]);
    expect(index.size).toBe(0);
  });
});

describe("groupCandidatesByEntity", () => {
  it("puts same-first-entity candidates in one group", () => {
    const groups = groupCandidatesByEntity([
      candidate("m1", ["postgres"]),
      candidate("m2", ["postgres"]),
      candidate("m3", ["alice"])
    ]);
    expect(groups).toEqual<EntityGroup[]>([
      { key: "postgres", memberObjectIds: ["m1", "m2"] },
      { key: "alice", memberObjectIds: ["m3"] }
    ]);
  });

  it("places each candidate in exactly one group via the first-entity rule", () => {
    const groups = groupCandidatesByEntity([
      candidate("m1", ["postgres", "alice"]),
      candidate("m2", ["alice", "postgres"])
    ]);
    // m1's first entity = postgres; m2's first entity = alice → distinct groups, no double-delivery.
    expect(groups).toEqual<EntityGroup[]>([
      { key: "postgres", memberObjectIds: ["m1"] },
      { key: "alice", memberObjectIds: ["m2"] }
    ]);
    const seen = groups.flatMap((g) => g.memberObjectIds);
    expect(seen).toEqual(["m1", "m2"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("gives no-entity candidates their own singleton group keyed null", () => {
    const groups = groupCandidatesByEntity([
      candidate("m1", null),
      candidate("m2", []),
      candidate("m3", ["  "])
    ]);
    expect(groups).toEqual<EntityGroup[]>([
      { key: null, memberObjectIds: ["m1"] },
      { key: null, memberObjectIds: ["m2"] },
      { key: null, memberObjectIds: ["m3"] }
    ]);
  });

  it("normalizes case when forming group keys", () => {
    const groups = groupCandidatesByEntity([candidate("m1", ["Postgres"]), candidate("m2", ["POSTGRES"])]);
    expect(groups).toEqual<EntityGroup[]>([{ key: "postgres", memberObjectIds: ["m1", "m2"] }]);
  });

  it("bounds group size by the cap, dropping overflow members while keeping input order", () => {
    const groups = groupCandidatesByEntity(
      [
        candidate("m1", ["x"]),
        candidate("m2", ["x"]),
        candidate("m3", ["x"]),
        candidate("m4", ["x"])
      ],
      { cap: 2 }
    );
    expect(groups).toEqual<EntityGroup[]>([{ key: "x", memberObjectIds: ["m1", "m2"] }]);
  });

  it("returns an empty array for empty input", () => {
    expect(groupCandidatesByEntity([])).toEqual([]);
  });

  it("is deterministic — group order follows first-member order across repeated calls", () => {
    const input = [
      candidate("m1", ["alice"]),
      candidate("m2", null),
      candidate("m3", ["postgres"]),
      candidate("m4", ["alice"])
    ];
    const first = groupCandidatesByEntity(input);
    const second = groupCandidatesByEntity(input);
    expect(first).toEqual(second);
    expect(first.map((g) => g.key)).toEqual(["alice", null, "postgres"]);
    expect(first[0].memberObjectIds).toEqual(["m1", "m4"]);
  });

  it("defaults the cap to DEFAULT_ENTITY_GROUP_CAP", () => {
    const input = Array.from({ length: DEFAULT_ENTITY_GROUP_CAP + 5 }, (_, i) => candidate(`m${i}`, ["x"]));
    const groups = groupCandidatesByEntity(input);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberObjectIds).toHaveLength(DEFAULT_ENTITY_GROUP_CAP);
  });
});

describe("expandByEntity", () => {
  const pool: EntityCandidate[] = [
    candidate("seed", ["postgres", "alice"]),
    candidate("m2", ["postgres"]),
    candidate("m3", ["alice"]),
    candidate("m4", ["redis"])
  ];

  it("returns same-entity co-members of the seeds, excluding the seeds themselves", () => {
    expect(expandByEntity(["seed"], pool)).toEqual(["m2", "m3"]);
  });

  it("de-duplicates members shared across multiple seed entities", () => {
    const shared: EntityCandidate[] = [
      candidate("seed", ["a", "b"]),
      candidate("m2", ["a", "b"])
    ];
    expect(expandByEntity(["seed"], shared)).toEqual(["m2"]);
  });

  it("bounds the total expansion by the cap, keeping input order", () => {
    expect(expandByEntity(["seed"], pool, 1)).toEqual(["m2"]);
  });

  it("returns empty for empty seeds, non-positive cap, or seeds with no entities", () => {
    expect(expandByEntity([], pool)).toEqual([]);
    expect(expandByEntity(["seed"], pool, 0)).toEqual([]);
    expect(expandByEntity(["m4"], [candidate("m4", null), candidate("m5", ["redis"])])).toEqual([]);
  });

  it("is deterministic across repeated calls", () => {
    expect(expandByEntity(["seed"], pool)).toEqual(expandByEntity(["seed"], pool));
  });
});
