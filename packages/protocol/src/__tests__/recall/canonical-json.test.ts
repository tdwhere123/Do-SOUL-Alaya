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
