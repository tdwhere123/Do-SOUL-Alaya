import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  const safe = installProviderFreeBoundary(), strict = installStrictProviderFreeBoundary();
  return { safe, strict };
});
afterAll(() => { isolation.strict.restore(); isolation.safe.restore(); });

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceSemanticResourceLedger, SourceSemanticResourceExhausted } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact, withBoundedArtifactReadMeter } from "../../../runs/extraction/cache-audit/bounded-artifact-reader.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(isolation.safe.violations).toEqual([]); expect(isolation.strict.forbidden).toEqual([]);
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "proposal-cache-read-budget-")); roots.push(root);
  const path = join(root, "retained.json"), text = JSON.stringify({ retained: "actual UTF-8 知识" });
  writeFileSync(path, text);
  return { text, read: () => readBoundedCanonicalUtf8Artifact({ path, maxBytes: 1024, label: "retained test raw" }) };
}

it("debits the opened physical UTF-8 byte length and shared decoded-retention cost", () => {
  const f = fixture(), budget = { work_units: 10_000, memory_bytes: 100_000 };
  const meter = new SourceSemanticResourceLedger(budget);
  expect(withBoundedArtifactReadMeter(meter, f.read)).toBe(f.text);
  const decoded = SourceSemanticResourceLedger.measureRetain(f.text, budget);
  expect(meter.spentWork).toBe(1 + decoded.work_units);
  expect(meter.spentBytes).toBe(Buffer.byteLength(f.text, "utf8") + decoded.memory_bytes);
});

it("rejects an oversized opened file before allocation and keeps exhaustion through cache error wrapping", () => {
  const f = fixture(), meter = new SourceSemanticResourceLedger({ work_units: 10_000,
    memory_bytes: Buffer.byteLength(f.text, "utf8") - 1 });
  expect(() => withBoundedArtifactReadMeter(meter, () => {
    try { f.read(); } catch { throw new Error("cache identity admission failed"); }
  })).toThrow(SourceSemanticResourceExhausted);
  expect(meter.spentBytes).toBe(0);
  expect(f.read()).toBe(f.text); // An exhausted parent cannot poison a later, independent read.
});

it("does not turn a swallowed read-budget failure into a valid empty cache result", () => {
  const f = fixture(), meter = new SourceSemanticResourceLedger({ work_units: 10_000, memory_bytes: 1 });
  expect(() => withBoundedArtifactReadMeter(meter, () => {
    try { return f.read(); } catch { return []; }
  })).toThrow(SourceSemanticResourceExhausted);
});
