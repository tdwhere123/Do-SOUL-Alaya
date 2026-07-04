import { expect } from "vitest";

export function expectFrozenPropertyWriteThrows(
  value: object,
  property: string,
  nextValue: unknown
): void {
  expect(() => {
    Object.assign(value, { [property]: nextValue });
  }).toThrow(TypeError);
}
