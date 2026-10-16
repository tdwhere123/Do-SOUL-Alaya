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

/** Exact UTF-16 length of the canonical preimage, without encoding strings or sorting keys.
 * Size is order-independent; array omissions and object `undefined` keep canonicalJson's meaning. */
export function canonicalJsonLength(value: unknown, meter?: Meter): number {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("canonical preimage has no root string");
  }
  return canonicalLength(value, meter);
}

function canonicalLength(value: unknown, meter?: Meter): number {
  meter?.charge(1, 0, "canonical size traversal");
  if (Array.isArray(value)) {
    const count = value.length;
    let length = 2 + Math.max(0, count - 1);
    for (let index = 0; index < count; index++) {
      const child = value[index];
      if (child !== undefined && typeof child !== "function" && typeof child !== "symbol") length += canonicalLength(child, meter);
    }
    return length;
  }
  if (value !== null && typeof value === "object") {
    let length = 2, count = 0;
    // No ordered key/entry array is needed for a capacity-only scan.
    for (const key in value) if (Object.prototype.hasOwnProperty.call(value, key)) {
      length += (count++ === 0 ? 0 : 1) + quotedStringLength(key, meter) + 1
        + canonicalLength((value as Record<string, unknown>)[key], meter);
    }
    return length;
  }
  if (typeof value === "string") return quotedStringLength(value, meter);
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    // Safe integers are decimal (never exponential) in JSON. Count digits without
    // allocating the common phase-code/counter scalars; division avoids log10 rounding.
    meter?.charge(1, 0, "canonical size integer scan");
    let digits = value < 0 ? 2 : 1, magnitude = Math.abs(value);
    while (magnitude >= 10) { magnitude = Math.floor(magnitude / 10); digits++; }
    return digits;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    // Other binary64 JSON is at most 32 code units. Admit this small scalar before
    // encoding; large strings never enter JSON.stringify on the size-only path.
    meter?.charge(1, 24 + 2 * 32, "canonical size numeric encoding");
    return JSON.stringify(value).length;
  }
  return value === null || value === true ? 4 : value === false ? 5 : 9;
}

function quotedStringLength(value: string, meter?: Meter): number {
  meter?.charge(1, 0, "canonical size string scan");
  let length = value.length + 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) length++;
    else if (code < 32) length += 5;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
      else length += 5;
    } else if (code >= 0xdc00 && code <= 0xdfff) length += 5;
  }
  return length;
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
