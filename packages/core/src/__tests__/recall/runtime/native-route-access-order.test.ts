import { describe, expect, it } from "vitest";
import { orderNativeRouteAccess, type NativeRouteLane, type NativeRouteOccurrence,
  type NativeRoutePoolMember } from "../../../recall/runtime/native-route-opportunity.js";

function lanes(rows: readonly (readonly NativeRouteOccurrence[])[]): NativeRouteLane[] {
  return ["original-lexical", "original-vector", "hint-lexical", "hint-vector"].map((lane, index) => ({
    lane: lane as NativeRouteLane["lane"], scope: index % 2 === 0 ? "fetched-lexical-page" : "exact-over-inspected-subset",
    ...(rows[index]?.length ? { state: "exact-captured", occurrences: rows[index]! } : { state: "measured-empty" })
  }));
}
const occurrence = (reference: string, root_key: string, native_rank: number): NativeRouteOccurrence =>
  ({ reference, root_key, native_rank });
const pool = (record_id: string, catalog_position: number | null): NativeRoutePoolMember => ({ record_id, catalog_position });

function input() {
  return {
    lanes: lanes([
      [occurrence("ol-a", "root-a", 2), occurrence("ol-b", "root-b", 22)],
      [occurrence("ov-b", "root-b", 8), occurrence("ov-a", "root-a", 60)],
      [occurrence("hl-c", "root-c", 4)], [occurrence("hv-d", "root-d", 17)]
    ]),
    pool: [pool("tail-late", 91), pool("record-c", 21), pool("record-b", null), pool("tail-early", 3),
      pool("record-d", 77), pool("record-a", 14)],
    acquired_root_keys: ["root-c", "root-a", "root-d", "root-b"],
    associations: [
      { occurrence_reference: "ol-a", root_key: "root-a", record_id: "record-a" },
      { occurrence_reference: "ol-b", root_key: "root-b", record_id: "record-b" },
      { occurrence_reference: "ov-b", root_key: "root-b", record_id: "record-b" },
      { occurrence_reference: "ov-a", root_key: "root-a", record_id: "record-a" },
      { occurrence_reference: "hl-c", root_key: "root-c", record_id: "record-c" },
      { occurrence_reference: "hv-d", root_key: "root-d", record_id: "record-d" }
    ],
    unvisited_sources: false
  };
}

describe("access-only native order over a closed source pool", () => {
  it("places first ranked opportunities once, traces duplicates, then appends the captured catalog tail", () => {
    const captured = input(), result = orderNativeRouteAccess(captured);
    expect(result.status).toBe("ordered");
    if (result.status !== "ordered") throw new Error("expected closed pool permutation");
    expect(result.record_ids).toEqual(["record-a", "record-b", "record-c", "record-d", "tail-early", "tail-late"]);
    expect(result.trace.map(row => [row.lane, row.occurrence.native_rank, row.record_id, row.decision])).toEqual([
      ["original-lexical", 2, "record-a", "placed"], ["original-vector", 8, "record-b", "placed"],
      ["hint-lexical", 4, "record-c", "placed"], ["hint-vector", 17, "record-d", "placed"],
      ["original-lexical", 22, "record-b", "duplicate"], ["original-vector", 60, "record-a", "duplicate"]
    ]);
    expect(result.trace[1]!.scope).toBe("exact-over-inspected-subset");
    expect(result.acquired_root_keys).toEqual(["root-c", "root-a", "root-d", "root-b"]);
    expect(result.pool_record_ids).toEqual(["tail-late", "record-c", "record-b", "tail-early", "record-d", "record-a"]);
    expect(result.lanes.map(lane => lane.last_native_rank)).toEqual([22, 60, 4, 17]);
    expect(result.record_ids).toHaveLength(captured.pool.length);
    expect(new Set(result.record_ids)).toEqual(new Set(captured.pool.map(row => row.record_id)));
  });

  it("keeps the entire baseline pool including unread and beyond-sixteen records separately from acquired roots", () => {
    const captured = input();
    captured.pool = [pool("unread-01", 1), pool("record-a", 2), pool("unread-03", 3), pool("unread-04", 4),
      pool("record-b", 5), pool("unread-06", 6), pool("unread-07", 7), pool("unread-08", 8),
      pool("unread-09", 9), pool("unread-10", 10), pool("unread-11", 11), pool("unread-12", 12),
      pool("unread-13", 13), pool("unread-14", 14), pool("unread-15", 15), pool("unread-16", 16),
      pool("unread-17", 17), pool("record-d", 18), pool("record-c", 19), pool("unread-20", 20)];
    const result = orderNativeRouteAccess(captured);
    expect(result.status).toBe("ordered");
    if (result.status !== "ordered") throw new Error("expected full closed pool order");
    expect(result.record_ids).toEqual(["record-a", "record-b", "record-c", "record-d", "unread-01", "unread-03",
      "unread-04", "unread-06", "unread-07", "unread-08", "unread-09", "unread-10", "unread-11", "unread-12",
      "unread-13", "unread-14", "unread-15", "unread-16", "unread-17", "unread-20"]);
    expect(result.pool_record_ids).toHaveLength(20);
    expect(result.acquired_root_keys).toEqual(["root-c", "root-a", "root-d", "root-b"]);
    expect(result.record_ids).not.toContain("root-a");
  });

  it("fails closed for a missing unranked catalog position without returning a partial permutation", () => {
    const captured = input();
    captured.pool[0] = pool("tail-late", null);
    const result = orderNativeRouteAccess(captured);
    expect(result.status).toBe("non_total");
    expect(result).toMatchObject({ reason: "missing_catalog_position", missing_record_ids: ["tail-late"] });
    expect(result).not.toHaveProperty("record_ids");
    expect(result.trace).toHaveLength(6);
  });

  it("does not conflate global unvisited sources with a non-total order over the closed pool", () => {
    const captured = input(); captured.unvisited_sources = true;
    const result = orderNativeRouteAccess(captured);
    expect(result.status).toBe("ordered");
    if (result.status !== "ordered") throw new Error("global residual must not invalidate closed pool order");
    expect(result.unvisited_sources).toBe(true);
    expect(result.record_ids).toEqual(["record-a", "record-b", "record-c", "record-d", "tail-early", "tail-late"]);
    expect(result).not.toHaveProperty("complete");
    expect(result).not.toHaveProperty("receipt");
  });

  it("permutes an unranked catalog and a valid empty pool without inventing lane positions", () => {
    const captured = { lanes: lanes([]), pool: [pool("late", 90), pool("early", 4)],
      acquired_root_keys: ["unused-acquired-root"], associations: [], unvisited_sources: true };
    expect(orderNativeRouteAccess(captured)).toMatchObject({ status: "ordered", record_ids: ["early", "late"], trace: [] });
    expect(orderNativeRouteAccess({ ...captured, pool: [] })).toMatchObject({ status: "ordered", record_ids: [], trace: [] });
  });

  it.each(["record", "root", "reference", "mismatch", "missing"])("rejects %s nonmembership rather than expanding the catalog", mode => {
    const captured = input();
    if (mode === "record") captured.associations[0]!.record_id = "new-record";
    if (mode === "root") captured.acquired_root_keys = ["root-b", "root-c", "root-d"];
    if (mode === "reference") captured.associations[0]!.occurrence_reference = "unseen-occurrence";
    if (mode === "mismatch") captured.associations[0]!.root_key = "root-b";
    if (mode === "missing") captured.associations.pop();
    expect(() => orderNativeRouteAccess(captured)).toThrow(/membership|association/u);
  });

  it("rejects ambiguous associations, repeated pool identities and ambiguous catalog positions", () => {
    const duplicateAssociation = input(); duplicateAssociation.associations.push({ ...duplicateAssociation.associations[0]! });
    expect(() => orderNativeRouteAccess(duplicateAssociation)).toThrow(/ambiguous/u);
    const splitRoot = input(); splitRoot.associations[3]!.record_id = "tail-early";
    expect(() => orderNativeRouteAccess(splitRoot)).toThrow(/ambiguous/u);
    const duplicatePool = input(); duplicatePool.pool.push(pool("record-a", 92));
    expect(() => orderNativeRouteAccess(duplicatePool)).toThrow(/membership/u);
    const duplicatePosition = input(); duplicatePosition.pool[0] = pool("tail-late", 3);
    expect(() => orderNativeRouteAccess(duplicatePosition)).toThrow(/position/u);
    const duplicateRoot = input(); duplicateRoot.acquired_root_keys.push("root-a");
    expect(() => orderNativeRouteAccess(duplicateRoot)).toThrow(/membership/u);
  });

  it("copies membership, associations and factual hits without freezing or retaining caller objects", () => {
    const captured = input(), hit = { status: "unavailable" as const, reason: "unmeasured_lexical_range" };
    captured.lanes[0] = { lane: "original-lexical", state: "exact-captured", scope: "captured-page",
      occurrences: [{ ...occurrence("ol-a", "root-a", 2), hit }, occurrence("ol-b", "root-b", 22)] };
    const result = orderNativeRouteAccess(captured);
    captured.pool.reverse(); captured.acquired_root_keys.reverse(); captured.associations[0]!.record_id = "changed";
    hit.reason = "changed";
    expect(Object.isFrozen(captured)).toBe(false);
    expect(Object.isFrozen(captured.pool)).toBe(false);
    expect(Object.isFrozen(hit)).toBe(false);
    expect(result.pool_record_ids).toEqual(["tail-late", "record-c", "record-b", "tail-early", "record-d", "record-a"]);
    expect(result.acquired_root_keys).toEqual(["root-c", "root-a", "root-d", "root-b"]);
    expect(result.trace[0]!.occurrence.hit).toEqual({ status: "unavailable", reason: "unmeasured_lexical_range" });
    expect(result.trace[0]!.record_id).toBe("record-a");
  });

  it("preserves non-tied choices under opaque root, record and occurrence identity renaming", () => {
    const original = orderNativeRouteAccess(input());
    const captured = input();
    const rename = (id: string) => `opaque-${[...id].reverse().join("")}`;
    captured.pool = captured.pool.map(row => ({ ...row, record_id: rename(row.record_id) }));
    captured.acquired_root_keys = captured.acquired_root_keys.map(rename);
    captured.associations = captured.associations.map(row => ({ occurrence_reference: rename(row.occurrence_reference),
      root_key: rename(row.root_key), record_id: rename(row.record_id) }));
    captured.lanes = captured.lanes.map(lane => lane.state === "exact-captured" ? { ...lane,
      occurrences: lane.occurrences.map(row => ({ ...row, root_key: rename(row.root_key), reference: rename(row.reference) })) } : lane);
    const renamed = orderNativeRouteAccess(captured);
    expect(original.status).toBe("ordered"); expect(renamed.status).toBe("ordered");
    if (original.status !== "ordered" || renamed.status !== "ordered") throw new Error("expected permutations");
    expect(renamed.record_ids).toEqual(original.record_ids.map(rename));
    expect(renamed.trace.map(row => [row.lane, row.occurrence.native_rank, row.decision]))
      .toEqual(original.trace.map(row => [row.lane, row.occurrence.native_rank, row.decision]));
  });
});
