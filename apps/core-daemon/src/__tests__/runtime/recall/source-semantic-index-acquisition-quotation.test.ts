import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { createSourceSemanticAccessPolicy, SourceIndexAcquisition } from "@do-soul/alaya-core";
import { SourceSemanticResourceExhausted } from "@do-soul/alaya-protocol";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { acquireSourceSemanticIndex } from "../../../runtime/recall-read-worker/source-semantic-index-acquisition.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { ORIGINAL, QUERY_BUDGET, RAW, WS, withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";

function runtime(database: RecallReadWorkerRuntime["database"]): RecallReadWorkerRuntime {
  return { database } as RecallReadWorkerRuntime;
}

it("reserves the core envelope-and-input quotation at the executed index boundary without billing it as spend", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal,
      remainingMs: () => 60_000 });
    const variants = [
      { navigation: ORIGINAL, vector: prepared.vector },
      { navigation: "港湾", vector: { status: "unavailable" as const, reason: "not_requested" } },
      { navigation: "ab", vector: { status: "unavailable" as const, reason: "not_requested" } }
    ] as const;
    expect(Buffer.byteLength("港湾", "utf8")).toBeGreaterThan("港湾".length);
    const utf8Quote = SourceIndexAcquisition.quoteEnvelopeAndInputCapture(
      { navigation: "港湾", vector: variants[1].vector, max_roots: 16 }, QUERY_BUDGET);
    const asciiQuote = SourceIndexAcquisition.quoteEnvelopeAndInputCapture(
      { navigation: "ab", vector: variants[2].vector, max_roots: 16 }, QUERY_BUDGET);
    expect(utf8Quote).toEqual(asciiQuote);

    for (const route of variants) {
      const quoted = SourceIndexAcquisition.quoteEnvelopeAndInputCapture(
        { navigation: route.navigation, vector: route.vector, max_roots: 16 }, QUERY_BUDGET);
      const meter = new SourceSemanticReadBudget(QUERY_BUDGET);
      const metadataMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
      const policy = createSourceSemanticAccessPolicy(route.navigation, undefined, "query-conditioned-v1", metadataMeter);
      const reserves: { work: number; bytes: number; phase: string }[] = [];
      const reserve = meter.reserve.bind(meter);
      vi.spyOn(meter, "reserve").mockImplementation(function (work, bytes, phase = "preparation") {
        reserves.push({ work, bytes, phase });
        return reserve(work, bytes, phase);
      });
      const charges: string[] = [];
      const charge = meter.charge.bind(meter);
      vi.spyOn(meter, "charge").mockImplementation(function (work, bytes, phase = "preparation") {
        charges.push(phase);
        return charge(work, bytes, phase);
      });
      const result = fixture.database.connection.transaction(() => acquireSourceSemanticIndex({
        runtime: runtime(fixture.database), workspace: WS, navigation: route.navigation, vector: route.vector,
        authorized: ["project"], meter, metadataMeter, canonicalBytes: Buffer.byteLength(RAW),
        sourceCost: policy.sourceCost
      }))();
      try {
        const envelope = reserves.filter(row => row.phase === "source acquisition envelope and input capture");
        expect(envelope).toEqual([{ work: quoted.work_units, bytes: quoted.memory_bytes,
          phase: "source acquisition envelope and input capture" }]);
        expect(charges).not.toContain("source acquisition result envelope");
        expect(result.phase.result).not.toBeNull();
        expect(result.phase.result!.resources.sql_internal_work).toBe("unknown");
        expect(result.phase.result!.resources.work).toBeGreaterThanOrEqual(quoted.work_units);
        expect(result.phase.status).not.toBe("not_run");
        if (route.vector.status === "available") {
          expect(result.phase.result!.resources.work).toBeGreaterThan(quoted.work_units);
          expect(result.phase.result!.vector.validation).toBe("validated");
        } else {
          expect(result.phase.result!.vector.input.status).toBe("unavailable");
        }
      } finally { result.releaseCanonical(); }
      vi.restoreAllMocks();
    }
  });
}, 60_000);

it("leaves acquisition unexecuted when remaining capacity cannot reserve the quoted envelope", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const vector = { status: "unavailable" as const, reason: "not_requested" };
    const quoted = SourceIndexAcquisition.quoteEnvelopeAndInputCapture(
      { navigation: ORIGINAL, vector, max_roots: 16 }, QUERY_BUDGET);
    const meter = new SourceSemanticReadBudget({ work_units: quoted.work_units, memory_bytes: quoted.memory_bytes });
    const metadataMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
    const policy = createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", metadataMeter);
    const result = fixture.database.connection.transaction(() => acquireSourceSemanticIndex({
      runtime: runtime(fixture.database), workspace: WS, navigation: ORIGINAL, vector,
      authorized: ["project"], meter, metadataMeter, canonicalBytes: Buffer.byteLength(RAW),
      sourceCost: policy.sourceCost
    }))();
    try {
      expect(result.phase.status).toBe("not_run");
      expect(result.phase.result).toBeNull();
      expect(result.nominations).toEqual([]);
      expect(result.phase.reason).not.toBeNull();
      expect(meter.indexWork).toBe(0);
    } finally { result.releaseCanonical(); }
    expect(() => new SourceSemanticReadBudget({ work_units: 0, memory_bytes: 0 })
      .reserve(quoted.work_units, quoted.memory_bytes, "source acquisition envelope and input capture"))
      .toThrow(SourceSemanticResourceExhausted);
  });
}, 60_000);
