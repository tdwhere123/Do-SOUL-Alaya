import { SourceSemanticResourceExhausted, encodeSourceDisclosure, sourceDisclosure,
  type SourceDisclosure, type SourceDisclosureSemantic, type IndexEntry, type SourceSemanticAccessReceipt } from "@do-soul/alaya-protocol";
import { CoreError } from "@do-soul/alaya-core";
import type { SourceRecallAccessMeter } from "./source-recall-access.js";

/** A member ordinal and its native selection reason, not a materialization payload. */
export type SourceRecallMember = Readonly<{ member: number;
  selection_basis?: "direct_answer" | "new_input" | "additional_witness" | "source_access" }>;
type Reservation = Readonly<{ access: SourceSemanticAccessReceipt; fits: boolean }>;
type Select = Readonly<{ candidates: readonly number[];
  fits: (page: readonly SourceRecallMember[]) => boolean;
  fitsStandalone?: (candidate: SourceRecallMember, precedingSlots: number) => boolean }>;
type SourceRecallDelivery = Readonly<{
  meter: SourceRecallAccessMeter; count: number; byteLimit: number; initialExecutionDiffers: boolean;
  order: "field" | "source_access"; improve: boolean;
  root: (member: number) => string; target: (member: number) => IndexEntry["target"];
  supportCount: (member: number) => number; accessPosition: (member: number) => number; pageKey: (page: readonly SourceRecallMember[]) => string;
  /** Bound to the existing Core gateways by the library adapter, not a caller ranking policy. */
  select: (input: Select) => readonly SourceRecallMember[];
  improvePage: (position: number, candidate: number,
    fits: (page: readonly SourceRecallMember[]) => boolean) => readonly SourceRecallMember[];
  pairs: (position: number) => Generator<number>;
  encode: (page: readonly SourceRecallMember[], offset: number, more: boolean, partial: boolean) => Readonly<{
    access: SourceSemanticAccessReceipt; bytes: number; withinBudget: boolean; payloadGrowth: number }>;
  finishEncoding: () => void;
  // The adapter owns the ONLY canonical page arrays. Views below are synchronous ordinal borrows.
  append: (page: readonly SourceRecallMember[], access: SourceSemanticAccessReceipt) => void;
  replace: (position: number, page: readonly SourceRecallMember[], access: SourceSemanticAccessReceipt) => void;
  pageCount: () => number; pageLength: (position: number) => number;
}>;

/** Exact admission, incumbent preservation, final-envelope deferral and frozen membership. */
export function prepareSourceRecallDelivery(input: SourceRecallDelivery): boolean {
  const { meter } = input;
  let remaining = Array.from({ length: input.count }, (_, i) => i), offset = 0, incomplete = false;
  const reserve = (page: readonly SourceRecallMember[], offset: number, more: boolean): Reservation => reservePage(input, page, offset, more);
  let finalPage: readonly SourceRecallMember[] = [], finalAccess: SourceSemanticAccessReceipt | undefined;
  while (remaining.length > 0) {
    try {
      const accessByPage = new Map<string, SourceSemanticAccessReceipt>();
      meter.charge(remaining.length, remaining.length * 16, "library page root census");
      const remainingRootCount = new Set(remaining.map(input.root)).size;
      let selected = select(input, { candidates: remaining,
        fitsStandalone: (candidate, precedingSlots) => {
          if (reserve([candidate], offset + precedingSlots, finalPage.length > 0 || remainingRootCount > precedingSlots + 1).fits) return true;
          return finalPage.length === 0 && reserve([candidate], offset, false).fits;
        },
        fits: page => {
          const reserved = reserve(page, offset, finalPage.length > 0 || remainingRootCount > page.length);
          if (reserved.fits) accessByPage.set(input.pageKey(page), reserved.access);
          return reserved.fits;
        }
      });
      const fallbackFinal = selected.length === 0 && finalPage.length === 0 ? reserveFinal(input, remaining, reserve, offset) : undefined;
      if (offset === 0 && input.initialExecutionDiffers && finalPage.length === 0
        && (selected.length === 0 || selected.some(row => input.supportCount(row.member) === 0))) {
        const deferred = reserveDeferred(input, remaining, selected, reserve, offset);
        if (deferred !== undefined) {
          selected = deferred.prefix; accessByPage.set(input.pageKey(selected), deferred.prefixAccess);
          finalPage = deferred.page; finalAccess = deferred.access; remaining = deferred.remaining;
        }
      }
      if (selected.length === 0) {
        if (fallbackFinal !== undefined && fallbackFinal.page.length > 0) {
          finalPage = fallbackFinal.page; finalAccess = fallbackFinal.access;
          const roots = new Set(finalPage.map(row => input.root(row.member)));
          remaining = remaining.filter(row => !roots.has(input.root(row))); continue;
        }
        incomplete = true; break;
      }
      const access = accessByPage.get(input.pageKey(selected));
      if (access === undefined) throw new CoreError("OBLIGATION_VIOLATION", "selected library page has no reserved access receipt");
      input.append(selected, access); offset += selected.length;
      const roots = new Set(selected.map(row => input.root(row.member)));
      remaining = remaining.filter(row => !roots.has(input.root(row)));
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      incomplete = true; break;
    }
  }
  if (finalPage.length > 0) {
    if (finalAccess === undefined) throw new CoreError("OBLIGATION_VIOLATION", "final library page has no reserved access receipt");
    input.append(finalPage, finalAccess);
  }
  if (input.improve) improveReserved(input, reserve);
  return incomplete;
}
function select(input: SourceRecallDelivery, selection: Select): readonly SourceRecallMember[] {
  const { meter } = input;
  meter.observer?.event("selection_attempt", meter.phase, () => ({ candidates: selection.candidates.map(row => ({
    target: input.target(row), access_position: input.accessPosition(row), proof_count: input.supportCount(row) })) }));
  try {
    const selected = input.select(selection);
    meter.observer?.event("selection_result", meter.phase, () => ({ targets: selected.map(row => input.target(row.member)), unselected_reason: "not_observed_inside_selector" }));
    return selected;
  } catch (error) {
    meter.observer?.event("selection_failure", meter.phase, () => ({ cause: error instanceof SourceSemanticResourceExhausted ? "resource_exhausted" : "unknown" }));
    throw error;
  }
}
function reservePage(input: SourceRecallDelivery, page: readonly SourceRecallMember[], offset: number, more: boolean): Reservation {
  try {
  const quoted = input.encode(page, offset, more, false);
  let fits = quoted.bytes <= input.byteLimit && quoted.withinBudget;
  if (fits && quoted.bytes + quoted.payloadGrowth > input.byteLimit) {
    const partial = input.encode(page, offset, more, true);
    fits = partial.bytes <= input.byteLimit;
    input.meter.observer?.event("encoding_result", input.meter.phase, () => ({ offset, variant: "partial_payload",
      fits, bytes: partial.bytes, byte_limit: input.byteLimit }));
  }
  input.meter.observer?.event("encoding_result", input.meter.phase, () => ({ offset, more, fits, bytes: quoted.bytes,
    byte_limit: input.byteLimit, targets: page.map(row => input.target(row.member)) }));
  return { access: quoted.access, fits };
  } finally { input.finishEncoding(); }
}
function reserveFinal(input: SourceRecallDelivery, candidates: readonly number[],
  reserve: (page: readonly SourceRecallMember[], offset: number, more: boolean) => Reservation, offset: number
): Readonly<{ page: readonly SourceRecallMember[]; access?: SourceSemanticAccessReceipt }> {
  input.meter.charge(candidates.length, candidates.length * 8, "final proof candidates");
  const proofs = candidates.filter(row => input.supportCount(row) > 0);
  if (proofs.length === 0) return { page: [] };
  const accessByPage = new Map<string, SourceSemanticAccessReceipt>();
  const selected = select(input, { candidates: proofs, fits: page => {
    const reserved = reserve(page, offset, false);
    if (reserved.fits) accessByPage.set(input.pageKey(page), reserved.access);
    return reserved.fits;
  } });
  if (selected.length === 0) return { page: [] };
  const access = accessByPage.get(input.pageKey(selected));
  if (access === undefined) throw new CoreError("OBLIGATION_VIOLATION", "final proof selection has no reserved access receipt");
  return { page: selected, access };
}
function reserveDeferred(input: SourceRecallDelivery, candidates: readonly number[], baseline: readonly SourceRecallMember[],
  reserve: (page: readonly SourceRecallMember[], offset: number, more: boolean) => Reservation, offset: number) {
  try {
    input.meter.charge(candidates.length + baseline.length, (candidates.length + baseline.length) * 24, "deferred final candidate references");
    const rawRoots = new Set(baseline.filter(row => input.supportCount(row.member) === 0).map(row => input.root(row.member)));
    const final = reserveFinal(input, baseline.length === 0 ? candidates : candidates.filter(row => rawRoots.has(input.root(row))), reserve, offset + 1);
    if (final.page.length === 0) return undefined;
    const finalRoots = new Set(final.page.map(row => input.root(row.member)));
    const remaining = candidates.filter(row => !finalRoots.has(input.root(row)));
    const accessByPage = new Map<string, SourceSemanticAccessReceipt>();
    const prefix = select(input, { candidates: remaining,
      fitsStandalone: (candidate, slots) => reserve([candidate], offset + slots, true).fits,
      fits: page => {
        const reserved = reserve(page, offset, true);
        if (reserved.fits) accessByPage.set(input.pageKey(page), reserved.access);
        return reserved.fits;
      }
    });
    if (prefix.length === 0) return undefined;
    const prefixAccess = accessByPage.get(input.pageKey(prefix));
    if (prefixAccess === undefined) throw new CoreError("OBLIGATION_VIOLATION", "deferred final prefix has no reserved access receipt");
    const confirmed = reserve(final.page, offset + prefix.length, false);
    return confirmed.fits ? { page: final.page, access: confirmed.access, prefix, prefixAccess, remaining } : undefined;
  } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; return undefined; }
}
function improveReserved(input: SourceRecallDelivery,
  reserve: (page: readonly SourceRecallMember[], offset: number, more: boolean) => Reservation): void {
  let offset = 0;
  try {
    for (let position = 0; position < input.pageCount(); position++) {
      for (const candidate of input.pairs(position)) {
        let replacementAccess: SourceSemanticAccessReceipt | undefined;
        input.meter.observer?.event("selection_attempt", input.meter.phase, () => ({ mode: "improve_reserved", position,
          candidates: [{ target: input.target(candidate), proof_count: input.supportCount(candidate) }] }));
        const improved = input.improvePage(position, candidate, page => {
          const reserved = reserve(page, offset, position + 1 < input.pageCount());
          if (reserved.fits) replacementAccess = reserved.access;
          return reserved.fits;
        });
        input.meter.observer?.event("selection_result", input.meter.phase, () => ({ mode: "improve_reserved", position,
          targets: improved.map(row => input.target(row.member)), replaced: replacementAccess !== undefined, unselected_reason: "not_observed_inside_selector" }));
        if (replacementAccess !== undefined) input.replace(position, improved, replacementAccess);
      }
      offset += input.pageLength(position);
    }
  } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; }
}
/** Optional source-time admission cannot displace an already reserved member or support package. */
export function packSourceRecallTimes(input: Readonly<{
  meter: SourceRecallAccessMeter; byteLimit: number; reservedBytes: number; count: number;
  time: (position: number) => SourceDisclosureSemantic["source_time"];
  disclosure: (position: number) => SourceDisclosure | undefined;
  apply: (position: number, disclosure: SourceDisclosure) => void;
  encodingInvocation: () => void; encoding: (variant: "source_time_before" | "source_time_after", json: string) => void;
}>): void {
  const { meter } = input;
  let reservedBytes = input.reservedBytes;
  for (let position = 0; position < input.count; position++) {
    const source_time = input.time(position);
    if (source_time === undefined) continue;
    const timeSizeBound = source_time.kind === "known" ? source_time.at.length * 6 + 96 : 128;
    try { meter.charge(1, timeSizeBound * 4, "optional source time packing"); }
    catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; break; }
    const disclosure = input.disclosure(position);
    if (disclosure === undefined) throw new CoreError("OBLIGATION_VIOLATION", "selected library source lacks disclosure");
    let withTime: SourceDisclosure, addedBytes: number;
    try {
      const semantic = { ...sourceDisclosure(disclosure), source_time };
      meter.retain(semantic, "optional source time semantic capture"); input.encodingInvocation();
      withTime = encodeSourceDisclosure(semantic);
      meter.retain(withTime, "optional source time codec allocation");
      const before = JSON.stringify(disclosure), after = JSON.stringify(withTime);
      input.encoding("source_time_before", before); input.encoding("source_time_after", after);
      meter.charge(1, (before.length + after.length) * 2, "optional source time codec encoding");
      addedBytes = 2 * (Buffer.byteLength(after) - Buffer.byteLength(before));
    } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; break; }
    if (reservedBytes + addedBytes > input.byteLimit) continue;
    input.apply(position, withTime); reservedBytes += addedBytes;
  }
}

/** Frozen continuation membership is checked without consulting any native reader. */
export function sourceRecallPageAt(count: number, length: (position: number) => number, offset: number): number {
  let position = 0;
  for (let index = 0; index < count; index++) { if (position === offset) return index; position += length(index); }
  throw new CoreError("VALIDATION", "library continuation offset is not a frozen page boundary");
}
