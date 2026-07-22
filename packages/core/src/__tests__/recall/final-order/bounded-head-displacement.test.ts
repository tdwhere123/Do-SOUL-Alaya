import { describe, expect, it } from "vitest";
import { orderWithBoundedHeadDisplacement } from "../../../recall/delivery/final-order/bounded-head-displacement.js";

const keyOf = (value: string) => value;

describe("bounded final head authority", () => {
  it("preserves public order until a head deadline forces promotion", () => {
    const ordered = orderWithBoundedHeadDisplacement({
      publicOrder: ["public-1", "public-2", "head-1", "public-4"],
      headRankByKey: new Map([
        ["head-1", 1],
        ["public-1", 2],
        ["public-2", 3],
        ["public-4", 4]
      ]),
      keyOf,
      maxDownwardDisplacement: 1,
      protectedRankLimit: 4
    });

    expect(ordered).toEqual(["public-1", "head-1", "public-2", "public-4"]);
  });

  it("keeps selected identity, cardinality, and every protected head deadline", () => {
    const publicOrder = ["d", "e", "c", "b", "a"];
    const headRanks = new Map(publicOrder.map((key, index) => [key, publicOrder.length - index]));
    const ordered = orderWithBoundedHeadDisplacement({
      publicOrder,
      headRankByKey: headRanks,
      keyOf,
      maxDownwardDisplacement: 2,
      protectedRankLimit: publicOrder.length
    });

    expect(ordered).toHaveLength(publicOrder.length);
    expect(new Set(ordered)).toEqual(new Set(publicOrder));
    for (const [index, key] of ordered.entries()) {
      expect(index + 1).toBeLessThanOrEqual((headRanks.get(key) ?? 0) + 2);
    }
  });

  it("leaves public order unchanged when no deadline is reached", () => {
    const publicOrder = ["a", "b", "c"];
    expect(orderWithBoundedHeadDisplacement({
      publicOrder,
      headRankByKey: new Map([["a", 1], ["b", 2], ["c", 3]]),
      keyOf,
      maxDownwardDisplacement: 2,
      protectedRankLimit: 3
    })).toEqual(publicOrder);
  });

  it("keeps candidates outside the protected head range in public order", () => {
    expect(orderWithBoundedHeadDisplacement({
      publicOrder: ["public-a", "public-b", "head-1"],
      headRankByKey: new Map([["public-a", 9], ["public-b", 8], ["head-1", 1]]),
      keyOf,
      maxDownwardDisplacement: 1,
      protectedRankLimit: 3
    })).toEqual(["public-a", "head-1", "public-b"]);
  });

  it("satisfies identity and deadline properties across every five-item public order", () => {
    const keys = ["a", "b", "c", "d", "e"];
    const headRanks = new Map(keys.map((key, index) => [key, index + 1]));
    for (const publicOrder of permutations(keys)) {
      for (let displacement = 0; displacement < keys.length; displacement += 1) {
        const params = {
          publicOrder,
          headRankByKey: headRanks,
          keyOf,
          maxDownwardDisplacement: displacement,
          protectedRankLimit: keys.length
        } as const;
        const first = orderWithBoundedHeadDisplacement(params);
        expect(orderWithBoundedHeadDisplacement(params)).toEqual(first);
        expect(new Set(first)).toEqual(new Set(keys));
        for (const [index, key] of first.entries()) {
          expect(index + 1).toBeLessThanOrEqual((headRanks.get(key) ?? 0) + displacement);
        }
      }
    }
  });

  it("rejects invalid bounds and duplicate candidate keys", () => {
    expect(() => orderWithBoundedHeadDisplacement({
      publicOrder: ["a"],
      headRankByKey: new Map([["a", 1]]),
      keyOf,
      maxDownwardDisplacement: -1,
      protectedRankLimit: 1
    })).toThrow(/maxDownwardDisplacement/);
    expect(() => orderWithBoundedHeadDisplacement({
      publicOrder: ["a", "a"],
      headRankByKey: new Map([["a", 1]]),
      keyOf,
      maxDownwardDisplacement: 1,
      protectedRankLimit: 2
    })).toThrow(/unique/);
  });
});

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)])
      .map((suffix) => [value, ...suffix])
  );
}
