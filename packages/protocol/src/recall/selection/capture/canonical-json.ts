import { compareCodeUnits } from "../../field-contract/canonical-identity.js";

type Meter = { charge(work: number, bytes: number, phase?: string): void };

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right));
    return `{${entries.map(([key, child]) =>
      `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The same canonical preimage, streamed without allocating enclosing JSON strings. */
export function* canonicalJsonChunks(value: unknown, meter?: Meter): Generator<string> {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("canonical preimage has no root string");
  }
  yield* canonicalChunks(value, meter);
}

function* canonicalChunks(value: unknown, meter?: Meter): Generator<string> {
  meter?.charge(1, 64, "canonical identity traversal");
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index) yield ",";
      // Match Array.map(...).join: undefined and holes contribute an empty slot.
      const child = value[index];
      if (child !== undefined && typeof child !== "function" && typeof child !== "symbol") yield* canonicalChunks(child, meter);
    }
    yield "]";
  } else if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    meter?.charge(keys.length, 64 + keys.length * 16, "canonical identity key ordering");
    keys.sort((left, right) => {
      meter?.charge(1, 0, "canonical identity key comparison");
      return compareCodeUnits(left, right);
    });
    yield "{";
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      if (index) yield ",";
      yield encodedScalar(key, meter);
      yield ":";
      yield* canonicalChunks((value as Record<string, unknown>)[key], meter);
    }
    yield "}";
  } else {
    yield encodedScalar(value, meter);
  }
}

function encodedScalar(value: unknown, meter?: Meter): string {
  const encoded = JSON.stringify(value) ?? "undefined";
  // Own the UTF-16 scalar; the hash consumer accounts for its native UTF-8 handoff.
  meter?.charge(1, 24 + 2 * encoded.length, "canonical identity scalar encoding");
  return encoded;
}
