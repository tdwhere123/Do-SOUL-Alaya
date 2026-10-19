import { createHash } from "node:crypto";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); });
import { CanonicalJsonSubtrees } from "../../../../protocol/src/recall/selection/capture/canonical-json.js";
import { canonicalJsonChunks, SourceSemanticResourceExhausted,
  SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { fieldContractSha256Chunks, quoteFieldContractSha256Chunks } from "../../shared/field-hash.js";

vi.mock("node:crypto", async importOriginal => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, createHash: vi.fn(original.createHash) };
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.clearAllMocks(); });

function quoteUnpreparedChunks(value: unknown, execution: SourceSemanticResourceLedger,
  planner: Pick<SourceSemanticResourceLedger, "charge"> = { charge() {} }) {
  return new CanonicalJsonSubtrees(undefined, undefined, planner).quote(value, execution, planner);
}

// Independent preimage: {"a":[,0,false],"z":"A\\n原🙂\\ud800"}.
// Five traversal frames (320), two ordered keys (96), five scalar encodings
// (30+26+34+30+52), and fourteen UTF-8 handoffs (39) cost 627 bytes.
const VALUE = { z: "A\n原🙂\ud800", a: [undefined, 0, false] };
const EXACT = { work_units: 27, memory_bytes: 627 };
const AMPLE = { work_units: 10_000, memory_bytes: 1_000_000 };

it("quotes exact canonical execution and hash handoffs without creating a hash or encoded strings", () => {
  const future = new SourceSemanticResourceLedger(EXACT), planning = new SourceSemanticResourceLedger(AMPLE);
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    quoteFieldContractSha256Chunks(quoteUnpreparedChunks(VALUE, future, planning), future, planning);
    expect(stringify).not.toHaveBeenCalled();
    expect(createHash).not.toHaveBeenCalled();
  } finally { stringify.mockRestore(); }
  expect(future.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
  // Ordinary traversal/key frames and quotation cost 480; the empty registry
  // and its quotation frame add 128+64, without changing future canonical costs.
  expect(planning.spentWork).toBe(29);
  expect(planning.spentBytes).toBe(672);
  const actual = new SourceSemanticResourceLedger(EXACT);
  expect(fieldContractSha256Chunks(canonicalJsonChunks(VALUE, actual), actual))
    .toBe("dc3bae5dafe47b6b8223f5edb376824c92a68fab7de2864cb13d68c1c858b0c6");
  expect(actual.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
});

it.each([{ ...EXACT, work_units: EXACT.work_units - 1 }, { ...EXACT, memory_bytes: EXACT.memory_bytes - 1 }])(
  "refuses adjacent insufficient execution budgets without pretending to finish", allowance => {
    const quote = new SourceSemanticResourceLedger(allowance), actual = new SourceSemanticResourceLedger(allowance);
    expect(() => quoteFieldContractSha256Chunks(quoteUnpreparedChunks(VALUE, quote), quote))
      .toThrow(SourceSemanticResourceExhausted);
    expect(() => fieldContractSha256Chunks(canonicalJsonChunks(VALUE, actual), actual))
      .toThrow(SourceSemanticResourceExhausted);
    for (const meter of [quote, actual]) {
      expect(meter.spentWork).toBeLessThanOrEqual(allowance.work_units);
      expect(meter.spentBytes).toBeLessThanOrEqual(allowance.memory_bytes);
    }
  });

it("keeps already executed quotation scans charged when a planning bound refuses", () => {
  const future = new SourceSemanticResourceLedger(AMPLE);
  const planning = new SourceSemanticResourceLedger({ work_units: 28, memory_bytes: 672 });
  expect(() => quoteFieldContractSha256Chunks(quoteUnpreparedChunks(VALUE, future, planning), future, planning))
    .toThrow(SourceSemanticResourceExhausted);
  expect(planning.spentWork).toBe(28);
  expect(planning.spentBytes).toBe(672);
  expect(createHash).not.toHaveBeenCalled();
});
