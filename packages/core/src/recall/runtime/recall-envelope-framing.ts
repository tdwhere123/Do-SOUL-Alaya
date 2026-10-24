import { types } from "node:util";
import { SourceSemanticResourceLedger, SourceSemanticResourceExhausted } from "@do-soul/alaya-protocol";

/** Logical codec work, not an RSS or wall-clock guarantee. A codec is a trusted
 * synchronous port: its invocation is paid before entry, including a thrown call.
 * The returned JSON data is scanned incrementally; no unbounded stringify or
 * producer-supplied byte count can spend work before the ledger admits it.
 */
export class RecallEnvelopeFraming {
  private bytes = 0;
  private admittedWork = 0;
  private work = 0;
  private readonly ancestors = new Set<object>();
  private refused = false;

  get interrupted(): boolean { return this.refused; }
  get measuredBytes(): number { return this.bytes; }

  constructor(private readonly meter: SourceSemanticResourceLedger) {}

  static readonly minimumWork = 2;

  begin(): void { this.charge(1, "public result encoding"); }
  entry(): void { this.charge(1, "public result row"); }
  enterCodec(): void { this.charge(1, "public envelope codec invocation"); }

  private charge(work: number, phase: string): void {
    try { this.meter.charge(work, 0, phase); }
    catch (error) {
      if (error instanceof SourceSemanticResourceExhausted) this.refused = true;
      throw error;
    }
  }

  measure(value: unknown): number {
    if (omitted(value)) throw new TypeError("Recall page codec returned no JSON envelope");
    this.value(value);
    return this.bytes;
  }

  private account(work: number): void {
    const required = this.work + work;
    const units = Math.ceil(Math.max(0, required - this.admittedWork) / 1024);
    if (units > 0) {
      this.charge(units, "public envelope JSON traversal and bytes");
      this.admittedWork += units * 1024;
    }
    this.work = required;
  }

  private emit(bytes: number): void {
    this.account(bytes);
    this.bytes += bytes;
  }

  private string(value: string): void {
    this.emit(1);
    for (let offset = 0; offset < value.length; offset++) {
      const code = value.charCodeAt(offset);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) this.emit(2);
      else if (code < 32) this.emit(6);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(offset + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { this.emit(4); offset++; }
        else this.emit(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) this.emit(6);
      else this.emit(code < 0x80 ? 1 : code < 0x800 ? 2 : 3);
    }
    this.emit(1);
  }

  private value(value: unknown): void {
    this.account(1);
    if (typeof value === "string") { this.string(value); return; }
    if (value === null || omitted(value)) { this.emit(4); return; }
    if (typeof value === "boolean") { this.emit(value ? 4 : 5); return; }
    if (typeof value === "number") { this.emit(JSON.stringify(value).length); return; }
    if (typeof value !== "object") throw new TypeError("Recall page codec returned non-JSON data");
    if (types.isProxy(value)) throw new TypeError("Recall page codec returned a proxy");
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    const serializer = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (serializer !== undefined && (!("value" in serializer) || typeof serializer.value === "function")) {
      throw new TypeError("Recall page codec must return data, not a serializer");
    }
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
      throw new TypeError("Recall page codec must return plain JSON data");
    }
    if (this.ancestors.has(value)) throw new TypeError("Recall page codec returned circular data");
    this.emit(1);
    this.ancestors.add(value);
    try {
      if (array) {
        for (let index = 0; index < value.length; index++) {
          if (index > 0) this.emit(1);
          this.value(dataProperty(value, String(index)));
        }
      } else {
        let count = 0;
        for (const key in value) {
          this.account(1);
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          const child = dataProperty(value, key);
          if (omitted(child)) continue;
          if (count++ > 0) this.emit(1);
          this.string(key); this.emit(1); this.value(child);
        }
      }
    } finally { this.ancestors.delete(value); }
    this.emit(1);
  }
}

function omitted(value: unknown): boolean {
  return value === undefined || typeof value === "symbol";
}

function dataProperty(value: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (property !== undefined && !("value" in property)) throw new TypeError("Recall page codec returned an accessor");
  return property?.value;
}
