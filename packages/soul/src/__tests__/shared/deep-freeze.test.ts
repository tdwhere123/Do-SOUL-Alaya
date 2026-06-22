import { describe, expect, it } from "vitest";
import { deepFreeze } from "../../shared/deep-freeze.js";

describe("deepFreeze", () => {
  it("recursively freezes nested objects", () => {
    const value = deepFreeze({ outer: { inner: { leaf: 1 } } });

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.outer)).toBe(true);
    expect(Object.isFrozen(value.outer.inner)).toBe(true);
  });

  it("freezes cyclic object graphs without overflowing the stack", () => {
    const value: { self?: unknown } = {};
    value.self = value;

    const frozen = deepFreeze(value);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen.self).toBe(frozen);
  });
});
