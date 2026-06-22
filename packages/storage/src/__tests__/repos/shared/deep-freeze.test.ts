import { describe, expect, it } from "vitest";
import { deepFreeze } from "../../../repos/shared/deep-freeze.js";

describe("deepFreeze", () => {
  it("recursively freezes nested objects and arrays", () => {
    const value = {
      content: "memory",
      nested: {
        count: 1
      },
      refs: [{ id: "e1" }, { id: "e2" }]
    };

    const frozen = deepFreeze(value);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nested)).toBe(true);
    expect(Object.isFrozen(frozen.refs)).toBe(true);
    expect(Object.isFrozen(frozen.refs[0])).toBe(true);

    expect(() => {
      (frozen as { content: string }).content = "updated";
    }).toThrow();
    expect(() => {
      (frozen.nested as { count: number }).count = 2;
    }).toThrow();
  });

  it("returns primitives unchanged", () => {
    expect(deepFreeze("memory")).toBe("memory");
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze(true)).toBe(true);
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
  });

  it("freezes cyclic object graphs without overflowing the stack", () => {
    const value: { self?: unknown } = {};
    value.self = value;

    const frozen = deepFreeze(value);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen.self).toBe(frozen);
  });
});
