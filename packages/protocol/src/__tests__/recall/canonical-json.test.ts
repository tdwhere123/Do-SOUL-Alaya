import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, canonicalJsonChunks, canonicalJsonLength, CanonicalJsonSubtrees } from "../../recall/selection/capture/canonical-json.js";
import { SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
import { sourceTextDigest } from "../../relations/relation-assertion.js";

function quoteUnpreparedChunks(value: unknown, execution: SourceSemanticResourceLedger,
  planner: Pick<SourceSemanticResourceLedger, "charge"> = { charge() {} }) {
  return new CanonicalJsonSubtrees(undefined, undefined, planner).quote(value, execution, planner);
}

const MIXED_KEYS = { a: 1, B: 2, "": 0 } as const;
const MIXED_KEYS_CANONICAL = '{"":0,"B":2,"a":1}';

describe("canonicalJson", () => {
  it("sorts object keys by UTF-16 code units and quotes keys", () => {
    expect(canonicalJson(MIXED_KEYS)).toBe(MIXED_KEYS_CANONICAL);
    expect(canonicalJson({ B: 2, a: 1, "": 0 })).toBe(MIXED_KEYS_CANONICAL);
  });

  it("streams the identical preimage, including escaped text and undefined slots", () => {
    const value = { z: [undefined, "原文🙂\n", null, -0], a: { absent: undefined, quoted: '"\\' } };
    const chunks = [...canonicalJsonChunks(value)];
    expect(chunks.join("")).toBe(canonicalJson(value));
    expect(() => [...canonicalJsonChunks(undefined)]).toThrow(/no root string/u);
    const hash = createHash("sha256");
    for (const chunk of chunks) hash.update(chunk, "utf8");
    expect(hash.digest("hex")).toBe(sha256(canonicalJson(value)));
    expect(() => [...canonicalJsonChunks(value, { charge() { throw new Error("budget exhausted"); } })])
      .toThrow("budget exhausted");
  });

  it("sizes canonical text exactly without serializing string bodies", () => {
    const text = Array.from({ length: 65_536 }, (_, code) => String.fromCharCode(code)).join("");
    const values = [text, "\ud800", "\udfff", "\ud800x\udfff", "\ud800\udfff", "\udfff\ud800",
      ...[0, -0, 9, 10, -99, 999_999_999_999_999, 1_000_000_000_000_000, Number.MAX_SAFE_INTEGER,
        -Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, Number.MIN_VALUE, NaN],
      { z: [undefined, , Symbol("omitted"), () => undefined, "原文🙂\n", null, -0, Infinity, 1e-7, 1e21],
        a: { absent: undefined, quoted: '"\\', omitted: () => undefined } }];
    for (const value of values) {
      const expected = canonicalJson(value).length;
      const stringify = vi.spyOn(JSON, "stringify");
      const charges: number[] = [];
      const length = canonicalJsonLength(value, { charge(_work, bytes) { charges.push(bytes); } });
      const serialized = stringify.mock.calls.map(([value]) => value);
      stringify.mockRestore();
      expect(length).toBe(expected);
      expect(serialized.every(value => typeof value === "number")).toBe(true);
      expect(charges.reduce((sum, bytes) => sum + bytes, 0)).toBe(serialized.length * 88);
    }
    expect(() => canonicalJsonLength(undefined)).toThrow(/no root string/u);
    expect(() => canonicalJsonLength(1, { charge() { throw new Error("size exhausted"); } })).toThrow("size exhausted");
  });

  it("quotes identical chunk boundaries and escaping without encoding string scalars", () => {
    const text = Array.from({ length: 65_536 }, (_, code) => String.fromCharCode(code)).join("");
    const value = { z: [undefined, , Symbol("omitted"), () => undefined, text, "\ud800", "\udfff", "\ud800x\udfff", "\ud800\udfff", "\udfff\ud800"],
      a: { absent: undefined, quoted: '"\\', negativeZero: -0, finite: 1e-7, nan: NaN, infinity: Infinity } };
    const chunks = [...canonicalJsonChunks(value)];
    const execution = new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 4_000_000 });
    const planning = new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 4_000_000 });
    const stringify = vi.spyOn(JSON, "stringify");
    let sizes: number[], serialized: unknown[];
    try {
      sizes = [...quoteUnpreparedChunks(value, execution, planning)];
      serialized = stringify.mock.calls.map(([value]) => value);
    } finally { stringify.mockRestore(); }
    expect(sizes).toEqual(chunks.map(chunk => Buffer.byteLength(chunk, "utf8")));
    expect(serialized.every(value => typeof value === "number")).toBe(true);
    expect(execution.spentBytes).toBeGreaterThan(planning.spentBytes + text.length);
  });

  it("rejects cycles and unencodable scalars in execution and cost-only quotation", () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    for (const value of [undefined, Symbol("root"), () => undefined, 1n, { nested: 1n }, cycle]) {
      const execution = new SourceSemanticResourceLedger({ work_units: 10_000, memory_bytes: 1_000_000 });
      expect(() => [...canonicalJsonChunks(value)]).toThrow(TypeError);
      expect(() => [...quoteUnpreparedChunks(value, execution)]).toThrow(TypeError);
    }
    const shared = { text: "borrowed" };
    const value = [shared, shared];
    const execution = new SourceSemanticResourceLedger({ work_units: 10_000, memory_bytes: 1_000_000 });
    expect([...quoteUnpreparedChunks(value, execution)])
      .toEqual([...canonicalJsonChunks(value)].map(chunk => Buffer.byteLength(chunk, "utf8")));
  });

  it.each([
    [undefined, undefined], [Symbol("root"), undefined], [() => undefined, undefined],
    [null, "null"], [-0, "0"], [NaN, "null"], [Infinity, "null"], [true, "true"], [false, "false"],
    [1e21, "1e+21"], [[, undefined, () => undefined, Symbol("slot")], "[,,,]"],
    [{ z: undefined, a: "x", f: () => undefined, s: Symbol("value") },
      '{"a":"x","f":undefined,"s":undefined,"z":undefined}'],
    [{ "2": "two", "10": "ten" }, '{"10":"ten","2":"two"}'],
    [{ "\ue000": 1, "\ud800\udc00": 2 }, '{"𐀀":2,"":1}'],
    ["\ud800", '"\\ud800"'], ["\udc00", '"\\udc00"'], ["汉🙂\n", '"汉🙂\\n"'],
    ['\u0000"\\', '"\\u0000\\"\\\\"'], [{ b: [true, false], a: {} }, '{"a":{},"b":[true,false]}'],
    [Object.assign(Object.create({ inherited: 7 }), { b: 2, a: 1 }), '{"a":1,"b":2}'],
    [new Date(0), "{}"], [new Number(5), "{}"], [new String("ab"), '{"0":"a","1":"b"}']
  ])("preserves legacy eager bytes for independent example %#", (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
    if (expected !== undefined) expect([...canonicalJsonChunks(value)].join("")).toBe(expected);
  });

  it("preserves root function toJSON while omitting function array slots", () => {
    const callable = Object.assign(() => undefined, { toJSON: () => 7 });
    expect(canonicalJson(callable)).toBe("7");
    expect(canonicalJson([callable])).toBe("[]");
    expect(canonicalJson({ callable })).toBe('{"callable":7}');
    expect(() => [...canonicalJsonChunks(callable)]).toThrow("canonical preimage has no root string");
  });

  it("reads sorted keys once and preserves getter mutation and live array length", () => {
    for (const encode of [canonicalJson, (value: unknown) => [...canonicalJsonChunks(value)].join("")]) {
      const accesses: string[] = [];
      const value: Record<string, unknown> = { get z() { accesses.push("z"); return 2; },
        get a() { accesses.push("a"); delete value.b; value.newKey = 3; return 1; }, b: 4 };
      expect(encode(value)).toBe('{"a":1,"b":undefined,"z":2}');
      expect(accesses).toEqual(["a", "z"]);
      const array = [0, 2, 3];
      Object.defineProperty(array, 0, { get() { array.length = 1; return 1; } });
      expect(encode(array)).toBe("[1]");
      const grown = [0];
      Object.defineProperty(grown, 0, { get() { grown[1] = 2; return 1; } });
      expect(encode(grown)).toBe("[1,2]");
    }
  });

  it("uses indexed array reads, including inherited slots, rather than a custom iterator", () => {
    for (const encode of [canonicalJson, (value: unknown) => [...canonicalJsonChunks(value)].join("")]) {
      const reads: PropertyKey[] = [], array = [1, , 3];
      Object.setPrototypeOf(array, Object.create(Array.prototype, { 1: { value: 2 } }));
      array[Symbol.iterator] = () => { throw new Error("iterator must not run"); };
      const proxy = new Proxy(array, { get(target, key, receiver) {
        reads.push(key); return Reflect.get(target, key, receiver);
      } });
      expect(encode(proxy)).toBe("[1,2,3]");
      expect(reads).toEqual(["length", "0", "length", "1", "length", "2", "length"]);

      const nanLengthProxy = new Proxy([], {
        get(_, key) {
          if (key === "length") return NaN;
          throw new Error("unexpected read of " + String(key));
        }
      });
      expect(encode(nanLengthProxy)).toBe("[]");
    }

    const originalArrayProto = Object.getPrototypeOf(Array.prototype);
    const setTrapProxy = new Proxy(originalArrayProto ?? Object.prototype, {
      set() {
        throw new Error("inherited Array.prototype Proxy set trap must not run");
      }
    });
    Object.setPrototypeOf(Array.prototype, setTrapProxy);
    try {
      expect(canonicalJson([{ a: 1, b: [2, 3] }])).toBe('[{"a":1,"b":[2,3]}]');
    } finally {
      Object.setPrototypeOf(Array.prototype, originalArrayProto);
    }

    const originalIndex0Desc = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      set() {
        throw new Error("Array.prototype[0] setter must not run");
      }
    });
    try {
      expect(canonicalJson([{ nested: [10] }])).toBe('[{"nested":[10]}]');
    } finally {
      if (originalIndex0Desc !== undefined) {
        Object.defineProperty(Array.prototype, "0", originalIndex0Desc);
      } else {
        delete (Array.prototype as unknown as Record<string, unknown>)["0"];
      }
    }

    const originalProtoSetDesc = Object.getOwnPropertyDescriptor(Object.prototype, "set");
    let serialized: string;
    Object.defineProperty(Object.prototype, "set", {
      value: undefined,
      configurable: true,
      writable: true
    });
    try {
      serialized = canonicalJson({ x: 1 });
    } finally {
      if (originalProtoSetDesc !== undefined) {
        Object.defineProperty(Object.prototype, "set", originalProtoSetDesc);
      } else {
        delete (Object.prototype as unknown as Record<string, unknown>).set;
      }
    }
    expect(serialized).toBe('{"x":1}');

    const originalProtoTextDesc = Object.getOwnPropertyDescriptor(Object.prototype, "text");
    let textTrapSerialized: string;
    Object.defineProperty(Object.prototype, "text", {
      configurable: true,
      set() {
        throw new Error("Object.prototype.text setter must not run");
      }
    });
    try {
      textTrapSerialized = canonicalJson([{ nested: [10], x: 1 }]);
    } finally {
      if (originalProtoTextDesc !== undefined) {
        Object.defineProperty(Object.prototype, "text", originalProtoTextDesc);
      } else {
        delete (Object.prototype as unknown as Record<string, unknown>).text;
      }
    }
    expect(textTrapSerialized).toBe('[{"nested":[10],"x":1}]');
  });

  it("accepts shared objects but preserves cycle, BigInt and getter failures", () => {
    const shared = { n: 1 }, failure = new RangeError("getter failed");
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const encode of [canonicalJson, (value: unknown) => [...canonicalJsonChunks(value)].join("")]) {
      expect(encode({ a: shared, b: shared })).toBe('{"a":{"n":1},"b":{"n":1}}');
      expect(() => encode(cycle)).toThrow(new TypeError("circular canonical preimage"));
      expect(() => encode(1n)).toThrow(new TypeError("Do not know how to serialize a BigInt"));
      expect(() => encode({ nested: 1n })).toThrow(new TypeError("Do not know how to serialize a BigInt"));
      expect(() => encode({ get a() { throw failure; } })).toThrow(failure);
      // A failed traversal must not poison a later invocation's ancestor set.
      expect(encode(shared)).toBe('{"n":1}');
    }
  });

  it("keeps streaming getters lazy through key/colon chunks and early return", () => {
    const accesses: string[] = [];
    const value = { get a() { accesses.push("a"); return { get b() { accesses.push("b"); return 1; } }; },
      get z() { accesses.push("z"); throw new Error("unvisited"); } };
    const stream = canonicalJsonChunks(value);
    expect(accesses).toEqual([]);
    for (const chunk of ["{", '"a"', ":"]) expect(stream.next()).toEqual({ value: chunk, done: false });
    expect(accesses).toEqual([]);
    expect(stream.next().value).toBe("{");
    expect(accesses).toEqual(["a"]);
    for (const chunk of ['"b"', ":"]) expect(stream.next().value).toBe(chunk);
    expect(accesses).toEqual(["a"]);
    expect(stream.next().value).toBe("1");
    expect(accesses).toEqual(["a", "b"]);
    stream.return(undefined);
    expect(accesses).toEqual(["a", "b"]);
  });

  it("retains independent streaming chunk and execution-charge inventories", () => {
    const value = { b: [undefined, 1], a: "x" };
    const expected = ["{", '"a"', ":", '"x"', ",", '"b"', ":", "[", ",", "1", "]", "}"];
    const rows: unknown[] = [], meter = { charge(work: number, bytes: number, phase?: string) {
      rows.push([work, bytes, phase]);
    } };
    expect([...canonicalJsonChunks(value, meter)]).toEqual(expected);
    expect(rows).toEqual([
      [1, 64, "canonical identity traversal"], [2, 96, "canonical identity key ordering"],
      [1, 0, "canonical identity key comparison"], [1, 30, "canonical identity scalar encoding"],
      [1, 0, "canonical identity traversal"], [1, 30, "canonical identity scalar encoding"],
      [1, 30, "canonical identity scalar encoding"], [1, 64, "canonical identity traversal"],
      [1, 0, "canonical identity traversal"], [1, 26, "canonical identity scalar encoding"]
    ]);
    const execution = new SourceSemanticResourceLedger({ work_units: 11, memory_bytes: 340 });
    expect([...quoteUnpreparedChunks(value, execution)]).toEqual(expected.map(chunk => Buffer.byteLength(chunk)));
    expect(execution.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
    const actual = new SourceSemanticResourceLedger({ work_units: 11, memory_bytes: 340 });
    expect([...canonicalJsonChunks(value, actual)]).toEqual(expected);
    expect(actual.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
    for (const budget of [{ work_units: 10, memory_bytes: 340 }, { work_units: 11, memory_bytes: 339 }]) {
      expect(() => [...canonicalJsonChunks(value, new SourceSemanticResourceLedger(budget))]).toThrow();
      expect(() => [...quoteUnpreparedChunks(value, new SourceSemanticResourceLedger(budget))]).toThrow();
    }
    expect(canonicalJson(value)).toBe('{"a":"x","b":[,1]}');
    expect(sha256(canonicalJson(value))).toBe(sha256('{"a":"x","b":[,1]}'));
  });

  it("is independent of process locale", () => {
    const distModule = fileURLToPath(
      new URL("../../../dist/recall/selection/capture/canonical-json.js", import.meta.url)
    );
    expect(fs.existsSync(distModule), "protocol dist must be built before locale identity check")
      .toBe(true);
    const moduleUrl = pathToFileURL(distModule).href;
    const script = `import { canonicalJson } from ${JSON.stringify(moduleUrl)};
process.stdout.write(canonicalJson({ a: 1, B: 2, "": 0 }));`;
    const fromC = canonicalizeInLocale("C", script);
    const fromUs = canonicalizeInLocale("en_US.UTF-8", script);
    expect(fromC).toBe(MIXED_KEYS_CANONICAL);
    expect(fromUs).toBe(MIXED_KEYS_CANONICAL);
  });

  it("handles deeply nested arrays and objects iteratively without overflowing the call stack", () => {
    let deepArray: unknown = 1;
    let deepObject: Record<string, unknown> = { b: 2, a: undefined };
    for (let depth = 1; depth < 8192; depth++) {
      deepArray = [undefined, deepArray];
      deepObject = { z: deepObject, a: depth === 1 ? [, 1] : null };
    }
    expect(canonicalJson(deepArray)).toBe("[,".repeat(8191) + "1" + "]".repeat(8191));
    expect(canonicalJsonLength(deepArray)).toBe(canonicalJson(deepArray).length);
    expect([...canonicalJsonChunks(deepArray)].join("")).toBe(canonicalJson(deepArray));
    const encodedObject = canonicalJson(deepObject);
    expect(canonicalJsonLength(deepObject)).toBe(encodedObject.length);
    expect(encodedObject.startsWith('{"a":null,"z":{"a":null,"z":')).toBe(true);
    expect(encodedObject.endsWith('{"a":[,1],"z":{"a":undefined,"b":2}}' + "}".repeat(8190))).toBe(true);
    expect([...canonicalJsonChunks(deepObject)].join("")).toBe(encodedObject);
    expect(() => canonicalJson(null)).not.toThrow();
    const deepCycle: unknown[] = [];
    let cursor = deepCycle;
    for (let depth = 0; depth < 8192; depth++) {
      const next: unknown[] = [];
      cursor.push(next);
      cursor = next;
    }
    cursor.push(deepCycle);
    expect(() => canonicalJson(deepCycle)).toThrow(new TypeError("circular canonical preimage"));
    expect(() => [...canonicalJsonChunks(deepCycle)]).toThrow(new TypeError("circular canonical preimage"));
  });

  it("keeps CanonicalJsonSubtrees quotation and replay immune to Array.prototype[0] and Object.prototype.next setters across block boundaries", () => {
    const subtree = Array.from({ length: 150 }, (_, index) => index);
    const outer = { subtree };
    const expected = canonicalJson(outer);
    const planner = new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 4_000_000 });
    const execution = new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 4_000_000 });
    const replayMeter = new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 4_000_000 });
    const prepared = new CanonicalJsonSubtrees(subtree, undefined, planner);
    const originalIndex0Desc = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    const originalProtoNextDesc = Object.getOwnPropertyDescriptor(Object.prototype, "next");
    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      set() {
        throw new Error("Array.prototype[0] setter must not run");
      }
    });
    Object.defineProperty(Object.prototype, "next", {
      configurable: true,
      set() {
        throw new Error("Object.prototype.next setter must not run");
      }
    });
    let quotedCount = 0;
    let replayed = "";
    try {
      for (const _ of prepared.quote(outer, execution, planner)) {
        quotedCount += 1;
      }
      for (const chunk of prepared.chunks(outer, replayMeter)) {
        replayed += chunk;
      }
    } finally {
      if (originalIndex0Desc !== undefined) {
        Object.defineProperty(Array.prototype, "0", originalIndex0Desc);
      } else {
        delete (Array.prototype as unknown as Record<string, unknown>)["0"];
      }
      if (originalProtoNextDesc !== undefined) {
        Object.defineProperty(Object.prototype, "next", originalProtoNextDesc);
      } else {
        delete (Object.prototype as Record<string, unknown>).next;
      }
    }
    expect(quotedCount).toBeGreaterThan(256);
    expect(replayed).toBe(expected);

    const fractionalSubtree = Array.from({ length: 150 }, (_, index) => index + 0.5);
    const fractionalOuter = { fractionalSubtree };
    const fractionalPlanner = new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 4_000_000 });
    const fractionalExec = new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 4_000_000 });
    const fractionalReplay = new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 4_000_000 });
    const preparedFractional = new CanonicalJsonSubtrees(fractionalSubtree, undefined, fractionalPlanner);
    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      set() {
        throw new Error("Array.prototype[0] setter must not run");
      }
    });
    let fractionalOut = "";
    try {
      for (const _ of preparedFractional.quote(fractionalOuter, fractionalExec, fractionalPlanner)) {
        // quote across >128 fractional scalars
      }
      for (const chunk of preparedFractional.chunks(fractionalOuter, fractionalReplay)) {
        fractionalOut += chunk;
      }
    } finally {
      if (originalIndex0Desc !== undefined) {
        Object.defineProperty(Array.prototype, "0", originalIndex0Desc);
      } else {
        delete (Array.prototype as unknown as Record<string, unknown>)["0"];
      }
    }
    expect(fractionalOut).toBe(canonicalJson(fractionalOuter));
  });

  it("flattens V8 ConsString output in canonicalJson without retaining excess heap", () => {
    const distModule = fileURLToPath(
      new URL("../../../dist/recall/selection/capture/canonical-json.js", import.meta.url)
    );
    expect(fs.existsSync(distModule), "protocol dist must be built before heap retention check").toBe(true);
    const moduleUrl = pathToFileURL(distModule).href;
    const script = `import { getHeapStatistics } from "node:v8";
import { canonicalJson } from ${JSON.stringify(moduleUrl)};
let arr = Array.from({ length: 250_000 }, (_, i) => i);
void canonicalJson([1, 2, 3]);
globalThis.gc();
globalThis.gc();
const before = getHeapStatistics().used_heap_size;
const out = canonicalJson(arr);
arr = null;
globalThis.gc();
globalThis.gc();
const retained = getHeapStatistics().used_heap_size - before;
process.stdout.write(JSON.stringify({ len: out.length, retained }));`;
    const raw = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(raw) as { len: number; retained: number };
    expect(parsed.len).toBeGreaterThan(1_500_000);
    // Unflattened ConsString retains ~16+ MB for 250k elements; flattened SeqOneByteString is ~1.7 MB.
    expect(parsed.retained).toBeLessThan(6 * 1024 * 1024);
  });
});

describe("sourceTextDigest", () => {
  it("prefixes SHA-256 of the source text and preserves null", () => {
    expect(sourceTextDigest(null, sha256)).toBeNull();
    expect(sourceTextDigest("hello", sha256)).toBe(`sha256:${sha256("hello")}`);
  });
});

function canonicalizeInLocale(locale: string, script: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: locale, LANG: locale, LC_COLLATE: locale }
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
