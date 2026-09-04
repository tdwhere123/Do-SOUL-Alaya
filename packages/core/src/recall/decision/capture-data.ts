import { types as nodeTypes } from "node:util";
import { compareText } from "../../shared/compare-text.js";
import { ShadowContractError } from "./contract-primitives.js";

export function captureData<T>(value: T, ancestors: WeakSet<object> = new WeakSet()): T {
  if (value === undefined || value === null || typeof value === "string" ||
      typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ShadowContractError("captured data must be finite");
    return value;
  }
  if (typeof value !== "object") {
    throw new ShadowContractError("captured data must be plain immutable data");
  }
  if (nodeTypes.isProxy(value)) {
    throw new ShadowContractError("captured data cannot use proxies");
  }
  if (ancestors.has(value)) throw new ShadowContractError("captured data must be acyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return captureArray(value, ancestors) as T;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ShadowContractError("captured data must be a plain record");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new ShadowContractError("captured data must not contain symbol fields");
    }
    return Object.freeze(Object.fromEntries(Object.keys(value).sort(compareText).map((key) =>
      [key, captureData(ownDataValue(value, key), ancestors)]))) as T;
  } finally {
    ancestors.delete(value);
  }
}

function captureArray(
  value: readonly unknown[],
  ancestors: WeakSet<object>
): readonly unknown[] {
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new ShadowContractError("captured data arrays must be dense without extra fields");
  }
  return Object.freeze(value.map((_, index) =>
    captureData(ownDataValue(value, index), ancestors)));
}

function ownDataValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new ShadowContractError("captured data cannot use getters");
  }
  return descriptor.value;
}
