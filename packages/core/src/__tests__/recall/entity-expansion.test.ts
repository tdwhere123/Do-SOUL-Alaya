import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENTITY_GROUP_CAP,
  groupCandidatesByEntity,
  type EntityCandidate,
  type EntityGroup
} from "../../recall/entity-expansion.js";

function candidate(objectId: string, canonicalEntities: readonly string[] | null | undefined): EntityCandidate {
  return { objectId, canonicalEntities };
}

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

  it("groups candidates that share an entity set regardless of entity order (one group, no double-delivery)", () => {
    const groups = groupCandidatesByEntity([
      candidate("m1", ["postgres", "alice"]),
      candidate("m2", ["alice", "postgres"])
    ]);
    // Both entities anchor at index 0; the lexicographically-smallest "alice" wins for both → one shared group.
    expect(groups).toEqual<EntityGroup[]>([{ key: "alice", memberObjectIds: ["m1", "m2"] }]);
    const seen = groups.flatMap((g) => g.memberObjectIds);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("assigns a multi-entity candidate to its stronger-anchored entity's group", () => {
    const groups = groupCandidatesByEntity([
      candidate("m1", ["postgres"]),
      candidate("m2", ["alice", "postgres"])
    ]);
    // postgres anchors at index 0 (m1), alice at index 1; m2 joins postgres (lower anchor).
    expect(groups).toEqual<EntityGroup[]>([{ key: "postgres", memberObjectIds: ["m1", "m2"] }]);
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
