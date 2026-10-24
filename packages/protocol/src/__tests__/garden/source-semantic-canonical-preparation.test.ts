import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import * as protocol from "../../index.js";
import { canonicalJson, canonicalJsonChunks } from "../../recall/selection/capture/canonical-json.js";
import { SourceSemanticResourceLedger, SourceSemanticResourceExhausted } from "../../garden/source-semantic-resources.js";
import { captureSourcePhaseFixture, sourcePhaseFixture } from "./source-semantic-canonical.test-support.js";

const AMPLE = { work_units: 1_000_000, memory_bytes: 4_000_000 };
class Charges extends SourceSemanticResourceLedger {
  readonly rows: { phase?: string; work: number; bytes: number }[] = [];
  override charge(work: number, bytes: number, phase?: string) {
    super.charge(work, bytes, phase); this.rows.push({ phase, work, bytes });
  }
  bytesFor(phase: string) { return this.rows.filter(row => row.phase === phase).reduce((sum, row) => sum + row.bytes, 0); }
}
function prepare(pair: ReturnType<typeof captureSourcePhaseFixture>, meter = new Charges(AMPLE)) {
  return protocol.prepareSourceSemanticCanonicalSubtreesForRequest(pair.phases, pair.borrowPreparation, pair.borrowAcquisition, meter);
}
function finishQuote(prepared: protocol.PreparedSourceSemanticCanonicalSubtrees, value: unknown,
  execution = new Charges(AMPLE), planning = new Charges(AMPLE)) {
  const sizes = [...prepared.quote(value, execution, planning)];
  return { sizes, execution, planning };
}
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// Independent legacy-shaped oracle: chunks preserve the established non-JSON
// undefined behavior; default sort is UTF-16, with no production encoder calls.
function referenceTokens(value: unknown): { scalar: boolean; text: string }[] {
  const scalar = (value: unknown) => ({ scalar: true, text: JSON.stringify(value) ?? "undefined" });
  const token = (text: string) => ({ scalar: false, text });
  if (Array.isArray(value)) return [token("["), ...value.flatMap((child, index) => [
    ...(index ? [token(",")] : []), ...(child === undefined ? [] : referenceTokens(child))]), token("]")];
  if (value !== null && typeof value === "object") return [token("{"), ...Object.keys(value).sort().flatMap((key, index) => [
    ...(index ? [token(",")] : []), scalar(key), token(":"), ...referenceTokens((value as Record<string, unknown>)[key])]), token("}")];
  return [scalar(value)];
}

it("exports only the named request source APIs, not the superseded public quotation entry", () => {
  expect(protocol).not.toHaveProperty("quoteCanonicalJsonChunks");
  expect(protocol.capturePackSourceSemanticPreparationForRequest).toBeTypeOf("function");
  expect(protocol.capturePackSourceSemanticAcquisitionForRequest).toBeTypeOf("function");
});

it("hands off the actual frozen capture and compact result only after packing succeeds", () => {
  const value = sourcePhaseFixture(), meter = new Charges(AMPLE);
  const consume = vi.fn((capture: protocol.SourceSemanticQueryPreparation, compact: protocol.SourceSemanticCompactPreparation) => {
    expect(Object.isFrozen(capture.selected?.profile)).toBe(true);
    expect(Object.isFrozen(compact)).toBe(true);
    expect(meter.rows.at(-1)?.phase).toBe("source phase packed preparation allocation");
  });
  const compact = protocol.capturePackSourceSemanticPreparationForRequest(value.preparation, meter, consume);
  expect(consume).toHaveBeenCalledTimes(1);
  expect(consume.mock.calls[0]![1]).toBe(compact);
  expect(consume.mock.calls[0]![0]).not.toBe(value.preparation);
  const publicMeter = new Charges(AMPLE);
  const publicCompact = protocol.packSourceSemanticQueryPreparation(protocol.captureSourceSemanticQueryPreparation(value.preparation, publicMeter), publicMeter);
  expect(compact).toEqual(publicCompact);
  expect(publicMeter.spentBytes - meter.spentBytes).toBe(16);
  expect(publicMeter.spentWork - meter.spentWork).toBe(1);
  expect(meter.bytesFor("source phase capture ownership")).toBe(0);
  const beforeFailure = new Charges({ ...AMPLE, memory_bytes: meter.spentBytes - 1 });
  const failed = vi.fn();
  expect(() => protocol.capturePackSourceSemanticPreparationForRequest(value.preparation, beforeFailure, failed))
    .toThrow(SourceSemanticResourceExhausted);
  expect(failed).not.toHaveBeenCalled();
  expect(beforeFailure.spentBytes).toBeGreaterThan(0);
  expect(() => protocol.capturePackSourceSemanticAcquisitionForRequest({ invalid: true }, new Charges(AMPLE), failed)).toThrow();
  expect(failed).not.toHaveBeenCalled();
});

it("retains an acquisition capture without adding a second capture or ownership entry", () => {
  const value = sourcePhaseFixture().acquisition;
  const actual = new Charges(AMPLE), ordinary = new Charges(AMPLE), consume = vi.fn();
  const packed = protocol.capturePackSourceSemanticAcquisitionForRequest(value, actual, consume);
  expect(packed).toEqual(protocol.packSourceSemanticAcquisition(value, ordinary));
  expect(actual.spentBytes).toBe(ordinary.spentBytes);
  expect(actual.spentWork).toBe(ordinary.spentWork);
  expect(consume.mock.calls[0]![1]).toBe(packed);
  expect(consume.mock.calls[0]![0]).not.toBe(value);
  expect(Object.isFrozen(consume.mock.calls[0]![0].result.nominations[0].source.target)).toBe(true);
});

it.each(["absent", "undefined", "present"] as const)("preserves expanded bytes/hash with supplemental %s and isolates caller mutation", form => {
  const original = sourcePhaseFixture();
  const value = form === "present" ? original : {
    preparation: { ...original.preparation, supplemental: undefined },
    acquisition: { ...original.acquisition, supplemental: undefined }
  };
  if (form === "absent") { delete value.preparation.supplemental; delete value.acquisition.supplemental; }
  const pair = captureSourcePhaseFixture(new Charges(AMPLE), value), prepared = prepare(pair);
  try {
    const ordinary = protocol.sourceSemanticAccessPhases({ phases: pair.phases });
    const expanded = prepared.accessPhases({ phases: pair.phases }, new Charges(AMPLE));
    expect(expanded.preparation === pair.preparation).toBe(form !== "undefined");
    expect(expanded.acquisition === pair.acquisition).toBe(form !== "undefined");
    const expected = referenceTokens(ordinary).map(row => row.text).join("");
    original.preparation.selected.profile.model_id = "caller mutation";
    original.acquisition.result.nominations[0]!.source.target.root_id = "changed";
    const quote = finishQuote(prepared, expanded);
    const chunks = [...prepared.chunks(expanded, new Charges(AMPLE))];
    expect(chunks.join("")).toBe(expected);
    expect(hash(chunks.join(""))).toBe(hash(expected));
    expect(quote.sizes).toEqual(chunks.map(chunk => Buffer.byteLength(chunk, "utf8")));
  } finally { prepared.close(); }
});

it("borrows short, zero-accounting and unknown-vector normal forms without changing canonical meaning", () => {
  const value = sourcePhaseFixture();
  const ordinary = protocol.unavailableSourceQueryPreparation("0", "not_requested");
  const acquisition = value.acquisition;
  const zero = { ...acquisition, supplemental: undefined, result: { ...acquisition.result,
    accounting: { attempted: -0, admitted: 0, duplicate: 0, rejected: 0, scope_denied: 0, native_unknown: 0,
      resource_refused: 0, stale: 0, nomination_limit: 0 },
    limitations: ["0", "1", "0", ""], vector: { ...acquisition.result.vector,
      state: { status: "unknown", reason: "1" }, input: { status: "unavailable", reason: "0" } } } };
  delete zero.supplemental;
  for (const input of [{ preparation: ordinary, acquisition: protocol.sourceSemanticAcquisitionNotRun("1") },
    { preparation: value.preparation, acquisition: zero }]) {
    const pair = captureSourcePhaseFixture(new Charges(AMPLE), input), prepared = prepare(pair);
    try {
      const expanded = prepared.accessPhases({ phases: pair.phases }, new Charges(AMPLE));
      expect(expanded.preparation).toBe(pair.preparation); expect(expanded.acquisition).toBe(pair.acquisition);
      finishQuote(prepared, expanded);
      expect([...prepared.chunks(expanded, new Charges(AMPLE))].join(""))
        .toBe(canonicalJson(protocol.sourceSemanticAccessPhases({ phases: pair.phases })));
    } finally { prepared.close(); }
  }
});

it("does not normalize an own undefined span on a retained nested target", () => {
  const value = sourcePhaseFixture();
  Object.assign(value.acquisition.result.nominations[0]!.source.target, { span: undefined });
  const pair = captureSourcePhaseFixture(new Charges(AMPLE), value), prepared = prepare(pair);
  try {
    const expanded = prepared.accessPhases({ phases: pair.phases }, new Charges(AMPLE));
    expect(expanded.acquisition).toBe(pair.acquisition);
    expect(Object.hasOwn(expanded.acquisition.result!.nominations[0]!.source.target, "span")).toBe(true);
    finishQuote(prepared, expanded);
    expect([...prepared.chunks(expanded, new Charges(AMPLE))].join(""))
      .toBe(canonicalJson(protocol.sourceSemanticAccessPhases({ phases: pair.phases })));
    expect(canonicalJson(expanded)).toContain('"span":undefined');
  } finally { prepared.close(); }
});

it("decodes unavailable ownership and rejects reference or owner replacement at binding", () => {
  const pair = captureSourcePhaseFixture(new Charges(AMPLE));
  const absent = protocol.prepareSourceSemanticCanonicalSubtreesForRequest(pair.phases, () => undefined, () => undefined, new Charges(AMPLE));
  const decoded = absent.accessPhases({ phases: pair.phases }, new Charges(AMPLE));
  expect(decoded.preparation).not.toBe(pair.preparation);
  finishQuote(absent, decoded);
  expect([...absent.chunks(decoded, new Charges(AMPLE))].join("")).toBe(canonicalJson(decoded));
  absent.close();
  const changedReference = prepare(pair);
  finishQuote(changedReference, changedReference.accessPhases({ phases: pair.phases }, new Charges(AMPLE)));
  expect(() => changedReference.accessPhases({ phases: [2, structuredClone(pair.phases[1]), pair.phases[2], null] }, new Charges(AMPLE)))
    .toThrow(/binding changed/u);
  expect(() => [...changedReference.chunks(decoded, new Charges(AMPLE))]).toThrow(/closed/u);
  const retired = prepare(pair);
  finishQuote(retired, retired.accessPhases({ phases: pair.phases }, new Charges(AMPLE)));
  pair.retire();
  expect(() => retired.accessPhases({ phases: pair.phases }, new Charges(AMPLE))).toThrow(/binding changed/u);
});

it("never publishes partial instructions and rejects all operations after retirement", () => {
  const pair = captureSourcePhaseFixture(new Charges(AMPLE)), prepared = prepare(pair), planning = new Charges(AMPLE);
  const value = prepared.accessPhases({ phases: pair.phases }, planning);
  expect(() => [...prepared.chunks(value, planning)]).toThrow(/not sealed/u);
  const stream = prepared.quote(value, new Charges(AMPLE), planning)[Symbol.iterator]();
  for (let index = 0; index < 4; index++) stream.next();
  expect(planning.bytesFor("canonical prepared opcode block")).toBeGreaterThan(0);
  stream.return?.();
  expect(planning.spentBytes).toBeGreaterThan(0);
  expect(() => [...prepared.chunks(value, planning)]).toThrow(/not sealed/u);
  prepared.close(); prepared.close();
  expect(() => prepared.accessPhases({ phases: pair.phases }, planning)).toThrow(/closed/u);
  expect(() => [...prepared.quote(value, planning, planning)]).toThrow(/closed/u);
  expect(() => [...prepared.chunks(value, planning)]).toThrow(/closed/u);
  const refused = prepare(pair), spent = new Charges(AMPLE);
  expect(() => [...refused.quote(value, new Charges({ ...AMPLE, memory_bytes: 0 }), spent)])
    .toThrow(SourceSemanticResourceExhausted);
  expect(spent.spentBytes).toBeGreaterThan(0);
  expect(() => [...refused.chunks(value, spent)]).toThrow(/not sealed/u);
  refused.close();
});

it("prices fixed instruction blocks once, keeps first structure in planning only, and replays exact scalar/hash costs", () => {
  const pair = captureSourcePhaseFixture(new Charges(AMPLE)), planning = new Charges(AMPLE), prepared = prepare(pair, planning);
  const value = { preparation: pair.preparation, acquisition: pair.acquisition };
  const expected = referenceTokens(value), future = new Charges(AMPLE);
  const sizes = [...prepared.quote(value, future, planning)];
  expect(sizes).toEqual(expected.map(row => Buffer.byteLength(row.text)));
  // Independently counted phase inventories: 215/757 instructions, 101/325 scalars.
  // Four opcode blocks at 256+128+88 and four 129-slot reference arrays at 64+129*8.
  expect(planning.bytesFor("canonical prepared opcode block")).toBe(4 * 472);
  expect(planning.bytesFor("canonical prepared scalar block")).toBe(4 * 1096);
  // Six objects/one array in preparation, 34 objects/17 arrays in acquisition.
  // Scalar visits do not instantiate recursive generator frames.
  expect(planning.bytesFor("canonical identity traversal")).toBe((7 + 51 + 1) * 64);
  expect(planning.bytesFor("canonical identity key ordering")).toBe((6 + 34 + 1) * 64 + (53 + 175 + 2) * 16);
  expect(future.bytesFor("canonical identity traversal")).toBe(64);
  expect(future.bytesFor("canonical identity key ordering")).toBe(96);
  expect(future.bytesFor("canonical prepared replay frame")).toBe(128);
  const scalarBytes = expected.filter(row => row.scalar).reduce((sum, row) => sum + 24 + 2 * row.text.length, 0);
  expect(future.bytesFor("canonical identity scalar encoding")).toBe(scalarBytes);
  expect(planning.bytesFor("canonical identity scalar encoding")).toBe(0);
  // 7,600 Protocol overhead; daemon separately owns its 128-byte borrower allocation.
  expect(planning.spentBytes).toBe(7600 + 22592 - 198 * 64 + 160 + 64 + 176);
  const actual = new Charges({ work_units: future.spentWork, memory_bytes: future.spentBytes });
  const keys = vi.spyOn(Object, "keys"), encoding = vi.spyOn(JSON, "stringify");
  let chunks: string[];
  try {
    chunks = [...prepared.chunks(value, actual)];
    // Real replay performs only the outer key scan, but still encodes all 428
    // primitive occurrences. A counter-only discount or encoded cache fails here.
    expect(keys.mock.calls).toEqual([[value]]);
    expect(encoding).toHaveBeenCalledTimes(428);
  } finally { keys.mockRestore(); encoding.mockRestore(); }
  expect(chunks).toEqual(expected.map(row => row.text));
  expect(actual.spentBytes).toBe(future.spentBytes);
  expect(actual.spentWork).toBe(future.spentWork);
  expect(actual.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
  expect(actual.bytesFor("canonical prepared opcode block")).toBe(0);
  expect(actual.bytesFor("canonical identity scalar encoding")).toBe(scalarBytes);
  expect([...canonicalJsonChunks(value)]).toEqual(chunks);
  prepared.close();
});
