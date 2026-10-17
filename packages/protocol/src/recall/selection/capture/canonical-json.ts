import { compareCodeUnits } from "../../field-contract/canonical-identity.js";

type Meter = { charge(work: number, bytes: number, phase?: string): void };
const codeUnitLength = (codeUnits: number): number => codeUnits;

export function canonicalJson(value: unknown): string {
  // Preserve the legacy root omission; streaming/quotation require a real preimage.
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return JSON.stringify(value);
  return [...canonicalJsonChunks(value)].join("");
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
  return scalarSize(value, meter, codeUnitLength);
}

function scalarSize<T>(value: unknown, meter: Meter | undefined,
  sized: (codeUnits: number, utf8Bytes: number) => T): T {
  if (typeof value === "string") return quotedStringSize(value, meter, sized);
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    // Safe integers are decimal (never exponential) in JSON. Count digits without
    // allocating the common phase-code/counter scalars; division avoids log10 rounding.
    meter?.charge(1, 0, "canonical size integer scan");
    let digits = value < 0 ? 2 : 1, magnitude = Math.abs(value);
    while (magnitude >= 10) { magnitude = Math.floor(magnitude / 10); digits++; }
    return sized(digits, digits);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    // Other binary64 JSON is at most 32 code units. Admit this small scalar before
    // encoding; large strings never enter JSON.stringify on the size-only path.
    meter?.charge(1, 24 + 2 * 32, "canonical size numeric encoding");
    const length = JSON.stringify(value).length;
    return sized(length, length);
  }
  const length = value === null || value === true ? 4 : value === false ? 5 : 9;
  return sized(length, length);
}

function quotedStringLength(value: string, meter?: Meter): number {
  return quotedStringSize(value, meter, codeUnitLength);
}

/** Shared size authority for JSON escaping and UTF-8; never builds the encoded string. */
function quotedStringSize<T>(value: string, meter: Meter | undefined,
  sized: (codeUnits: number, utf8Bytes: number) => T): T {
  meter?.charge(1, 0, "canonical size string scan");
  let length = 2, bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
      length += 2; bytes += 2;
    } else if (code < 32) { length += 6; bytes += 6; }
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { index++; length += 2; bytes += 4; }
      else { length += 6; bytes += 6; }
    } else if (code >= 0xdc00 && code <= 0xdfff) { length += 6; bytes += 6; }
    else { length++; bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3; }
  }
  return sized(length, bytes);
}

/** The same canonical preimage, streamed without allocating enclosing JSON strings. */
export function* canonicalJsonChunks(value: unknown, meter?: Meter): Generator<string> {
  assertRoot(value);
  yield* canonicalChunks(value, scalar => encodedScalar(scalar, meter), token => token, meter, new Set());
}

/** Quote future chunks by UTF-8 length. Ordinary structure is mirrored into the
 * execution price; matched subtree structure belongs only to planning. Scalars
 * are scanned now, while real encoding allocations remain future obligations. */
function* quoteCanonicalJsonChunks(value: unknown, execution: Meter, planner: Meter,
  prepared: CanonicalJsonSubtrees): Generator<number> {
  assertRoot(value);
  planner?.charge(1, 64, "canonical identity quotation frames");
  const traversal: Meter = { charge(work, bytes, phase) {
    planner?.charge(work, bytes, phase);
    execution.charge(work, bytes, phase);
  } };
  const sized = (codeUnits: number, utf8Bytes: number) => {
    chargeScalarEncoding(codeUnits, execution);
    return utf8Bytes;
  };
  const scalar = (value: unknown) => {
    prepared.assertQuoting(); return scalarSize(value, planner, sized);
  };
  yield* canonicalChunks(value, scalar, token => {
    prepared.assertQuoting(); return token.length;
  }, traversal, new Set(), prepared, planner, execution);
}

function assertRoot(value: unknown): void {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("canonical preimage has no root string");
  }
}

/** Dispatch before allocating a recursive generator. A matched replay must not
 * instantiate even the eliminated subtree root's structural frame. */
function canonicalChunks<T>(value: unknown, scalar: (value: unknown) => T, token: (value: string) => T,
  meter: Meter | undefined, ancestors: Set<object>, prepared?: CanonicalJsonSubtrees,
  planner?: Meter, execution?: Meter): Generator<T> {
  const plan = value !== null && typeof value === "object" ? prepared?.match(value, meter) : undefined;
  if (plan === undefined) return canonicalStructureChunks(value, scalar, token, meter, ancestors, prepared, planner, execution);
  if (planner === undefined) return plan.replay(scalar, token, meter!);
  execution!.charge(1, 64, "canonical prepared replay frame");
  return plan.record(scalar, token, planner, execution!, ancestors);
}

/** Encoding and quotation share all ordering, omissions and chunk boundaries. */
function* canonicalStructureChunks<T>(value: unknown, scalar: (value: unknown) => T, token: (value: string) => T,
  meter: Meter | undefined, ancestors: Set<object>, prepared?: CanonicalJsonSubtrees,
  planner?: Meter, execution?: Meter): Generator<T> {
  // Includes the active generator frame and its ancestor bookkeeping.
  meter?.charge(1, 64, "canonical identity traversal");
  if (value === null || typeof value !== "object") { yield scalar(value); return; }
  if (ancestors.has(value)) throw new TypeError("circular canonical preimage");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield token("[");
      for (let index = 0; index < value.length; index++) {
        if (index) yield token(",");
        // Match Array.map(...).join: undefined and holes contribute an empty slot.
        const child = value[index];
        if (child !== undefined && typeof child !== "function" && typeof child !== "symbol") {
          yield* canonicalChunks(child, scalar, token, meter, ancestors, prepared, planner, execution);
        }
      }
      yield token("]");
    } else {
      const keys = Object.keys(value);
      meter?.charge(keys.length, 64 + keys.length * 16, "canonical identity key ordering");
      keys.sort((left, right) => {
        meter?.charge(1, 0, "canonical identity key comparison");
        return compareCodeUnits(left, right);
      });
      yield token("{");
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!;
        if (index) yield token(",");
        yield scalar(key);
        yield token(":");
        yield* canonicalChunks((value as Record<string, unknown>)[key], scalar, token, meter, ancestors, prepared, planner, execution);
      }
      yield token("}");
    }
  } finally { ancestors.delete(value); }
}

function chargeScalarEncoding(codeUnits: number, meter?: Meter): void {
  meter?.charge(1, 24 + 2 * codeUnits, "canonical identity scalar encoding");
}

function encodedScalar(value: unknown, meter?: Meter): string {
  const encoded = JSON.stringify(value) ?? "undefined";
  // Own the UTF-16 scalar; the hash consumer accounts for its native UTF-8 handoff.
  chargeScalarEncoding(encoded.length, meter);
  return encoded;
}

type Opcodes = { bytes: Uint8Array; used: number; next?: Opcodes };
type Scalars = unknown[];
const TOKENS = ["{", "}", "[", "]", ",", ":"] as const;
const BLOCK_BYTES = 256, SCALAR_SLOTS = 128;

/** Private instructions retain primitive references, never encoded strings or growing tables. */
class CanonicalSubtree {
  private head?: Opcodes;
  private tail?: Opcodes;
  private scalars?: Scalars;
  private scalarTail?: Scalars;
  private scalarOffset = SCALAR_SLOTS;
  private state: "new" | "recording" | "sealed" | "closed" = "new";
  constructor(public root: object | undefined, planner: Meter) {
    planner.charge(1, 128, "canonical prepared subtree record");
  }

  *record<T>(scalar: (value: unknown) => T, token: (value: string) => T, planner: Meter,
    execution: Meter, ancestors: Set<object>): Generator<T> {
    if (this.state === "sealed") { yield* this.replay(scalar, token, planner, execution); return; }
    if (this.state !== "new") throw new TypeError("canonical subtree is not recordable");
    this.state = "recording";
    planner.charge(3, 64 + 2 * 128, "canonical prepared recording frame and callbacks");
    try {
      yield* canonicalChunks(this.root, value => {
        this.writeScalar(value, planner); this.writeOpcode(0, planner);
        execution.charge(1, 0, "canonical prepared instruction replay");
        return scalar(value);
      }, value => {
        planner.charge(1, 0, "canonical prepared punctuation lookup");
        this.writeOpcode(TOKENS.indexOf(value as typeof TOKENS[number]) + 1, planner);
        execution.charge(1, 0, "canonical prepared instruction replay");
        return token(value);
      }, planner, ancestors);
      if (this.state !== "recording") throw new TypeError("canonical subtree is closed");
      this.state = "sealed";
    } finally { if (this.state !== "sealed") this.close(); }
  }

  *replay<T>(scalar: (value: unknown) => T, token: (value: string) => T, meter: Meter, execution?: Meter): Generator<T> {
    if (this.state !== "sealed") throw new TypeError("canonical subtree is not sealed");
    meter.charge(1, 64, "canonical prepared replay frame");
    let codes = this.head, scalars = this.scalars, offset = 0;
    while (codes !== undefined) {
      for (let index = 0; index < codes.used; index++) {
        if (this.state !== "sealed") throw new TypeError("canonical subtree is closed");
        meter.charge(1, 0, "canonical prepared instruction replay");
        execution?.charge(1, 0, "canonical prepared instruction replay");
        const opcode = codes.bytes[index]!;
        if (opcode === 0) {
          if (offset === SCALAR_SLOTS) { scalars = scalars![SCALAR_SLOTS] as Scalars; offset = 0; }
          yield scalar(scalars![offset++]);
        } else yield token(TOKENS[opcode - 1]!);
      }
      codes = codes.next;
    }
  }

  private writeOpcode(opcode: number, planner: Meter): void {
    if (this.state !== "recording") throw new TypeError("canonical subtree is closed");
    planner.charge(1, 0, "canonical prepared instruction recording");
    if (this.tail === undefined || this.tail.used === BLOCK_BYTES) {
      // ArrayBuffer and typed-array headers, bytes, and the three-slot link record.
      planner.charge(1 + BLOCK_BYTES, BLOCK_BYTES + 128 + 64 + 3 * 8, "canonical prepared opcode block");
      const next: Opcodes = { bytes: new Uint8Array(BLOCK_BYTES), used: 0 };
      if (this.tail === undefined) this.head = next;
      else this.tail.next = next;
      this.tail = next;
    }
    this.tail.bytes[this.tail.used++] = opcode;
  }

  private writeScalar(value: unknown, planner: Meter): void {
    if (this.state !== "recording") throw new TypeError("canonical subtree is closed");
    if (this.scalarOffset === SCALAR_SLOTS) {
      // Reference-array slots, not identity-container slots or copied scalar bodies.
      planner.charge(1 + SCALAR_SLOTS + 1, 64 + (SCALAR_SLOTS + 1) * 8, "canonical prepared scalar block");
      const next: Scalars = new Array(SCALAR_SLOTS + 1).fill(undefined);
      if (this.scalarTail === undefined) this.scalars = next;
      else this.scalarTail[SCALAR_SLOTS] = next;
      this.scalarTail = next; this.scalarOffset = 0;
    }
    this.scalarTail![this.scalarOffset++] = value;
  }

  get sealed(): boolean { return this.state === "sealed"; }
  close(): void {
    this.state = "closed"; this.root = undefined;
    this.head = this.tail = undefined; this.scalars = this.scalarTail = undefined;
  }
}

/** Package-internal canonical owner. Only the source-phase adapter supplies owned roots.
 * The first traversal defines instructions; replay still encodes and hashes every scalar. */
export class CanonicalJsonSubtrees {
  private first?: CanonicalSubtree;
  private second?: CanonicalSubtree;
  private state: "new" | "quoting" | "sealed" | "closed" = "new";
  constructor(first: object | undefined, second: object | undefined, planner: Meter) {
    planner.charge(1, 128, "canonical prepared registry");
    try {
      if (first !== undefined) this.first = new CanonicalSubtree(first, planner);
      if (second !== undefined) this.second = new CanonicalSubtree(second, planner);
    } catch (error) { this.close(); throw error; }
  }

  match(value: object, meter?: Meter): CanonicalSubtree | undefined {
    if (this.first === undefined && this.second === undefined) return undefined;
    meter?.charge(2, 0, "canonical prepared root matching");
    return value === this.first?.root ? this.first : value === this.second?.root ? this.second : undefined;
  }

  *quote(value: unknown, execution: Meter, planner: Meter): Generator<number> {
    if (this.state !== "new") throw new TypeError("canonical preparation is not quotable");
    this.state = "quoting";
    try {
      planner.charge(1, 64, "canonical prepared quotation frame");
      yield* quoteCanonicalJsonChunks(value, execution, planner, this);
      this.assertQuoting();
      if (this.first !== undefined && !this.first.sealed || this.second !== undefined && !this.second.sealed) {
        throw new TypeError("canonical prepared subtree was not quoted");
      }
      this.state = "sealed";
    } finally { if (this.state !== "sealed") this.close(); }
  }

  *chunks(value: unknown, meter: Meter): Generator<string> {
    if (this.state !== "sealed") throw new TypeError("canonical preparation is not sealed");
    assertRoot(value);
    try {
      yield* canonicalChunks(value, scalar => {
        if (this.state !== "sealed") throw new TypeError("canonical preparation is closed");
        return encodedScalar(scalar, meter);
      }, token => {
        if (this.state !== "sealed") throw new TypeError("canonical preparation is closed");
        return token;
      }, meter, new Set(), this);
    } catch (error) { this.close(); throw error; }
  }

  assertQuoting(): void {
    if (this.state !== "quoting") throw new TypeError("canonical preparation is closed");
  }

  close(): void {
    this.state = "closed";
    this.first?.close(); this.second?.close(); this.first = this.second = undefined;
  }
}
