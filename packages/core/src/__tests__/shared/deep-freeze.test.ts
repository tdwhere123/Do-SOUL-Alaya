import { describe, expect, it } from "vitest";
import { deepFreeze } from "../../shared/deep-freeze.js";

describe("deepFreeze", () => {
  it("recursively freezes nested objects", () => {
    const value = deepFreeze({ outer: { inner: { leaf: 1 } } });

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.outer)).toBe(true);
    expect(Object.isFrozen(value.outer.inner)).toBe(true);
  });

  it("recursively freezes arrays and their elements", () => {
    const value = deepFreeze([{ a: 1 }, [2, 3]]);

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value[0])).toBe(true);
    expect(Object.isFrozen(value[1])).toBe(true);
  });

  it("returns primitives as-is", () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze("text")).toBe("text");
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
  });

  it("throws on mutation in strict mode after freezing", () => {
    const value = deepFreeze({ x: 0 });

    expect(() => {
      (value as { x: number }).x = 1;
    }).toThrow();
  });

  it("throws on mutation of a nested frozen property", () => {
    const value = deepFreeze({ outer: { inner: 0 } });

    expect(() => {
      (value.outer as { inner: number }).inner = 1;
    }).toThrow();
  });
});
