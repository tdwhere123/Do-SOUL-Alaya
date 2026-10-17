import { expect } from "vitest";

type Spy = {
  mock: {
    calls: unknown[][];
    invocationCallOrder: number[];
  };
};

function lastBefore(events: { phase: string | undefined; order: number }[], order: number) {
  let phase: string | undefined;
  for (const event of events) if (event.order < order) phase = event.phase;
  return phase;
}

/** Pages after an identity's metadata probe are observation extents, not earlier index windows. */
export function sourceObservationOrder(input: {
  bodies: Spy; headers: Spy; reserve?: Spy; charge?: Spy;
}) {
  const reserveEvents = (input.reserve?.mock.calls ?? []).map((args, index) => ({
    phase: args[2] as string | undefined, order: input.reserve!.mock.invocationCallOrder[index]!
  }));
  const chargeEvents = (input.charge?.mock.calls ?? []).map((args, index) => ({
    phase: args[2] as string | undefined, order: input.charge!.mock.invocationCallOrder[index]!
  }));
  const pages = input.bodies.mock.calls.map((args, index) => {
    const order = input.bodies.mock.invocationCallOrder[index]!;
    return {
      identity: args[1] as string, maxBytes: args[2] as number,
      offset: (args[3] as number | undefined) ?? 0, order,
      reservePhase: lastBefore(reserveEvents, order), chargePhase: lastBefore(chargeEvents, order)
    };
  });
  const metadata = pages.filter(row => row.maxBytes === 1 && row.offset === 0);
  const started = new Map<string, number>();
  for (const row of metadata) if (!started.has(row.identity)) started.set(row.identity, row.order);
  const extents = pages.filter(row => {
    const begin = started.get(row.identity);
    return row.maxBytes > 1 && begin !== undefined && row.order > begin;
  });
  const census = censusSeam(input.headers, input.reserve);
  const before = extents.filter(row => census !== undefined && row.order < census);
  const after = extents.filter(row => census !== undefined && row.order > census);
  // Observation extents name "access source extent". After-census 4096 reads with the
  // ledger default are Field stored-record interpretation loads, not observation rereads.
  const observation = extents.filter(row => row.reservePhase === "access source extent");
  const bodySpans = extents.map(row => `${row.identity}:${row.offset}:${row.maxBytes}`);
  const observationSpans = observation.map(row => `${row.identity}:${row.offset}:${row.maxBytes}`);
  const firstSpans = before.map(row => `${row.identity}:${row.offset}:${row.maxBytes}`);
  const offsetKeys = observation.map(row => `${row.identity}:${row.offset}`);
  const scoring = (input.charge?.mock.calls ?? []).flatMap((args, index) => {
    const phase = args[2];
    if (phase !== "access source assembly" && phase !== "access text normalization and scoring") return [];
    return [input.charge!.mock.invocationCallOrder[index]!];
  });
  return {
    metadataReads: metadata.length,
    metadataBeforeCensus: metadata[0] !== undefined && census !== undefined && metadata[0].order < census,
    firstExtentBeforeCensus: before.length,
    firstExtentOffsets: before.map(row => row.offset),
    furtherBodyAfterCensus: after.length,
    bodySpans, uniqueBodySpans: new Set(bodySpans).size === bodySpans.length,
    observationSpans, uniqueObservationSpans: new Set(observationSpans).size === observationSpans.length,
    uniqueFirstExtents: new Set(firstSpans).size === firstSpans.length,
    uniqueOffsets: new Set(offsetKeys).size === offsetKeys.length,
    scoringBeforeCensus: scoring.filter(order => census !== undefined && order < census).length,
    scoringAfterCensus: scoring.filter(order => census !== undefined && order > census).length,
    censusOrder: census,
    pageTrace: pages.map(row => ({
      identity: row.identity, maxBytes: row.maxBytes, offset: row.offset, order: row.order,
      reservePhase: row.reservePhase, chargePhase: row.chargePhase,
      relative: census === undefined ? "uncensused" : row.order < census ? "before-census" : "after-census"
    }))
  };
}

function censusSeam(headers: Spy, reserve?: Spy): number | undefined {
  const headerRead = headers.mock.invocationCallOrder[0];
  const reserveIndex = reserve?.mock.calls.findIndex(args => args[2] === "interpretation access header page") ?? -1;
  const headerReserve = reserveIndex >= 0 ? reserve!.mock.invocationCallOrder[reserveIndex] : undefined;
  if (headerRead === undefined) return headerReserve;
  if (headerReserve === undefined) return headerRead;
  return Math.min(headerRead, headerReserve);
}

/** Funded prefetch: one offset-0 native extent before census; scoring only after promotion. */
export function expectFundedExtentThenCensus(order: ReturnType<typeof sourceObservationOrder>) {
  expect(order.metadataBeforeCensus).toBe(true);
  expect(order.firstExtentBeforeCensus).toBe(1);
  expect(order.firstExtentOffsets).toEqual([0]);
  expect(order.uniqueFirstExtents).toBe(true);
  expect(order.uniqueObservationSpans).toBe(true);
  expect(new Set(order.firstExtentOffsets).size).toBe(order.firstExtentOffsets.length);
  expect(order.scoringBeforeCensus).toBe(0);
  expect(order.scoringAfterCensus).toBeGreaterThan(0);
}

/** Census refusal after the guaranteed first extent: same seam, no later body, assembly, or scoring. */
export function expectFirstExtentThenCensusRefusal(order: ReturnType<typeof sourceObservationOrder>) {
  expect(order.metadataReads).toBe(1);
  expect(order.metadataBeforeCensus).toBe(true);
  expect(order.firstExtentBeforeCensus).toBe(1);
  expect(order.firstExtentOffsets).toEqual([0]);
  expect(order.furtherBodyAfterCensus).toBe(0);
  expect(order.uniqueOffsets).toBe(true);
  expect(order.scoringBeforeCensus).toBe(0);
  expect(order.scoringAfterCensus).toBe(0);
}
