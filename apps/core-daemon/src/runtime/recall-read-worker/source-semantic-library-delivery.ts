import { SourceSemanticResourceExhausted, SourceSemanticWorkerResultSchema, SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
  indexEntryCacheKey, type SourceSemanticCoverage, type SourceSemanticQueryStatus, type SourceSemanticLibraryDiscovery,
  type SourceSemanticAccessReceipt,
  type SourceSemanticLibraryUnprovedComputation,
  type SourceSemanticWorkerRequest, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { CoreError, assembleSourceSemanticLibraryIndex, encodeSourceSemanticLibraryResponse,
  preparedDeliveryId, selectSourceSemanticLibraryPage, sealIssuedContinuation, slotQualifiersFor,
  sourceGoldRootIdentity, SOURCE_SEMANTIC_LIBRARY_ORDER, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { workOf, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { libraryAccessReceipt, type SourceSemanticAccessPool } from "./source-semantic-candidate-access.js";
import { issueSemanticLease, sourceSemanticLifetimeNow, sourceSemanticRevision } from "./source-semantic-leases.js";

type Request = Extract<SourceSemanticWorkerRequest, { kind: "recall" }>;
type Recall = Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
export type LibraryDeliveryPlan = Readonly<{
  query_id: string; snapshot_id: string; interpretation_id: string; as_of: string; expires_at: string;
  query_semantics_status: SourceSemanticQueryStatus;
  // Continuation identity retains exact wire inputs; public identity binds the resolved request.
  authorized: readonly string[] | null; request_identity: string; public_request_identity: string;
  discovery: SourceSemanticLibraryDiscovery; coverage: SourceSemanticCoverage;
  unproved_computations: readonly SourceSemanticLibraryUnprovedComputation[];
  pages: readonly (readonly SourceSemanticLibraryPackage[])[];
  page_access: readonly SourceSemanticAccessReceipt[];
}>;
type PlanBase = Omit<LibraryDeliveryPlan, "pages" | "page_access"> & Readonly<{ pool: SourceSemanticAccessPool }>;
export type LibraryPageSelector = typeof selectSourceSemanticLibraryPage;

/** Freeze membership, witness packages and support reservations before exposing any page. */
export function prepareLibraryDelivery(base: PlanBase, candidates: readonly SourceSemanticLibraryPackage[],
  request: Request, meter: SourceSemanticReadBudget, order: "field" | "source_access" = "field",
  selectPage: LibraryPageSelector = selectSourceSemanticLibraryPage): LibraryDeliveryPlan {
  const pages: SourceSemanticLibraryPackage[][] = [];
  const pageAccess: SourceSemanticAccessReceipt[] = [];
  let remaining = [...candidates], offset = 0, incomplete = false;
  const reservePage = (page: readonly SourceSemanticLibraryPackage[], emittedOffset: number, more: boolean) => {
    const access = libraryAccessReceipt(base.pool, base.discovery.examined_source_interpretation_ids,
      page.flatMap(row => row.entry.target.kind === "source_evidence" ? [row.entry.target.root_id] : []), meter);
    const result = pageResult(base, page, emittedOffset, more, request, meter, true, access);
    const encoded = encodeSourceSemanticLibraryResponse(result);
    meter.retain(encoded, "candidate delivery encoding");
    const bytes = Buffer.byteLength(JSON.stringify(encoded));
    meter.charge(1, bytes * 2, "candidate delivery bytes");
    let fits = bytes <= request.output_byte_limit && "results" in encoded
      && encoded.results !== undefined && encoded.results.every(row => row.budget_state.within_budget);
    // An unfittable later root marks payload truncated. Bound that field's
    // growth cheaply, then use the shared encoder at an exact byte boundary;
    // it also owns the resulting index payload state. Other incomplete flags
    // and index states only shorten their encoding.
    const payloadGrowth = Math.max(0, JSON.stringify("truncated").length - JSON.stringify(result.coverage.payload).length);
    if (fits && bytes + payloadGrowth > request.output_byte_limit) {
      const partial = encodeSourceSemanticLibraryResponse({ ...result, coverage: { ...result.coverage, payload: "truncated" } });
      meter.retain(partial, "candidate partial delivery encoding");
      const partialBytes = Buffer.byteLength(JSON.stringify(partial));
      meter.charge(1, partialBytes * 2, "candidate partial delivery bytes");
      fits = partialBytes <= request.output_byte_limit;
    }
    return { access, fits };
  };
  let finalPage: readonly SourceSemanticLibraryPackage[] = [], finalAccess: SourceSemanticAccessReceipt | undefined;
  while (remaining.length > 0) {
    try {
      const accessByPage = new Map<string, SourceSemanticAccessReceipt>();
      meter.charge(remaining.length, remaining.length * 16, "library page root census");
      const remainingRootCount = new Set(remaining.map(root)).size;
      const selected = selectPage({ candidates: remaining, meter, order,
        fitsStandalone: (candidate, precedingSlots) => {
          if (reservePage([candidate], offset + precedingSlots,
            finalPage.length > 0 || remainingRootCount > precedingSlots + 1).fits) return true;
          // Until the final membership is reserved, do not consume a raw twin
          // whose complete proof can use that smaller envelope after other roots.
          return finalPage.length === 0 && reservePage([candidate], 0, false).fits;
        },
        fits: page => {
          const reserved = reservePage(page, offset, finalPage.length > 0 || remainingRootCount > page.length);
          if (reserved.fits) accessByPage.set(pageKey(page), reserved.access);
          return reserved.fits;
        }
      });
      if (selected.length === 0) {
        if (finalPage.length === 0) {
          const final = reserveFinalProofPage(remaining, meter, order, selectPage, reservePage);
          if (final.page.length > 0) {
            finalPage = final.page; finalAccess = final.access;
            const roots = new Set(finalPage.map(root));
            remaining = remaining.filter(row => !roots.has(root(row)));
            continue;
          }
        }
        incomplete = true; break;
      }
      const access = accessByPage.get(pageKey(selected));
      if (access === undefined) throw new CoreError("OBLIGATION_VIOLATION", "selected library page has no reserved access receipt");
      pages.push([...selected]); offset += selected.length;
      pageAccess.push(access);
      const roots = new Set(selected.map(root));
      remaining = remaining.filter(row => !roots.has(root(row)));
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      incomplete = true; break;
    }
  }
  if (finalPage.length > 0) {
    if (finalAccess === undefined) throw new CoreError("OBLIGATION_VIOLATION", "final library page has no reserved access receipt");
    pages.push([...finalPage]); pageAccess.push(finalAccess);
  }
  const frozenPages = pages.length === 0 ? [[]] : pages;
  const page_access = pages.length === 0
    ? [libraryAccessReceipt(base.pool, base.discovery.examined_source_interpretation_ids, [], meter)]
    : pageAccess;
  const { pool: _pool, ...frozenBase } = base;
  return { ...frozenBase, pages: frozenPages, page_access,
    coverage: incomplete ? { ...base.coverage, payload: "truncated" } : base.coverage,
    discovery: incomplete ? { ...base.discovery, truncated: true, open_residuals: true } : base.discovery };
}

type PageReservation = Readonly<{ access: SourceSemanticAccessReceipt; fits: boolean }>;

/**
 * A stalled page has no fitting singleton in its continuing envelope. Reserve
 * one actual final membership, whose continuation-free encoding has no cursor
 * or offset overhead, then give other roots only earlier continuing pages.
 * Conflicting final-only roots may fall back to raw support or remain truncated.
 * Earlier pages never change; at most one metered final selection breaks the
 * stall, not a subset/permutation search or a replan of exposed membership.
 */
function reserveFinalProofPage(candidates: readonly SourceSemanticLibraryPackage[], meter: SourceSemanticReadBudget,
  order: "field" | "source_access", selectPage: LibraryPageSelector,
  reserve: (page: readonly SourceSemanticLibraryPackage[], offset: number, more: boolean) => PageReservation
): Readonly<{ page: readonly SourceSemanticLibraryPackage[]; access?: SourceSemanticAccessReceipt }> {
  meter.charge(candidates.length, candidates.length * 8, "final proof candidates");
  const proofs = candidates.filter(row => row.proofs.length > 0);
  if (proofs.length === 0) return { page: [] };
  const accessByPage = new Map<string, SourceSemanticAccessReceipt>();
  const selected = selectPage({ candidates: proofs, meter, order, fits: page => {
    const reserved = reserve(page, 0, false);
    if (reserved.fits) accessByPage.set(pageKey(page), reserved.access);
    return reserved.fits;
  } });
  if (selected.length > 0) {
    const access = accessByPage.get(pageKey(selected));
    if (access === undefined) throw new CoreError("OBLIGATION_VIOLATION", "final proof selection has no reserved access receipt");
    return { page: selected, access };
  }
  return { page: [] };
}

/** Continuations reuse the frozen plan; no source access, solver replay or re-selection occurs. */
export function deliverFrozenLibraryPage(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  meter: SourceSemanticReadBudget, request: Request, plan: LibraryDeliveryPlan, offset: number): Recall {
  let position = 0;
  const pageIndex = plan.pages.findIndex(page => { const matches = position === offset; position += page.length; return matches; });
  if (pageIndex < 0) throw new CoreError("VALIDATION", "library continuation offset is not a frozen page boundary");
  const page = plan.pages[pageIndex]!;
  const result = pageResult(plan, page, offset, pageIndex + 1 < plan.pages.length, request, meter, false,
    plan.page_access[pageIndex]!);
  if (result.index.continuation !== null) {
    const continuation = result.index.continuation;
    issueSemanticLease(runtime, { kind: "library", workspace_id: payload.workspace_id,
      lifetime_now: sourceSemanticLifetimeNow(payload), principal: payload.principal ?? "", as_of: plan.as_of,
      authorized: plan.authorized, expires_at: plan.expires_at, revision: sourceSemanticRevision(runtime),
      continuation, request_identity: plan.request_identity, library_plan: plan }, meter, continuation.continuation_id);
  }
  const baseEncoded = encodeSourceSemanticLibraryResponse(result);
  meter.retain(baseEncoded, "library public serialization");
  // The reserved work receipt is an upper bound on the eventual metered receipt.
  let reservedBytes = Buffer.byteLength(JSON.stringify(baseEncoded))
    + Buffer.byteLength(JSON.stringify(reservedWork(request))) - Buffer.byteLength(JSON.stringify(result.work));
  if (reservedBytes > request.output_byte_limit) {
    throw new CoreError("VALIDATION", "output budget cannot retain reserved source support");
  }
  let final: Recall = result;
  // Source time occurs once in the disclosure map and once in the public result.
  // Charge each bounded formatting attempt before measuring it, even when it
  // cannot fit. Previously reserved roots, previews and proofs remain intact.
  for (const row of page) {
    const source_time = row.source_disclosure.source_time;
    if (source_time === undefined) continue;
    // ISO times are bounded to 64 ASCII characters by the disclosure schema;
    // this covers escaped JSON, both public copies and transient formatting.
    const timeSizeBound = source_time.kind === "known" ? source_time.at.length * 6 + 96 : 128;
    try { meter.charge(1, timeSizeBound * 4, "optional source time packing"); }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      break;
    }
    const addedBytes = 2 * Buffer.byteLength(`,"source_time":${JSON.stringify(source_time)}`);
    if (reservedBytes + addedBytes > request.output_byte_limit) continue;
    const key = indexEntryCacheKey(row.entry);
    const disclosure = final.source_disclosures[key];
    if (disclosure === undefined) throw new CoreError("OBLIGATION_VIOLATION", "selected library source lacks disclosure");
    final = { ...final, source_disclosures: {
      ...final.source_disclosures, [key]: { ...disclosure, source_time }
    } };
    reservedBytes += addedBytes;
  }
  return { ...final, work: workOf(meter) };
}

function pageResult(base: Omit<LibraryDeliveryPlan, "pages" | "page_access">, page: readonly SourceSemanticLibraryPackage[], offset: number, more: boolean,
  request: Request, meter: SourceSemanticReadBudget, reserveWork: boolean, access: SourceSemanticAccessReceipt): Recall {
  const assembled = assembleSourceSemanticLibraryIndex({ ...base, authorized_scopes: base.authorized,
    source_entries: page.map(row => row.entry), proof_groups: page.filter(row => row.proofs.length > 0),
    selected_entries: page.map(row => row.entry), root_order: page.map(root),
    truncated: base.discovery.truncated, open_residuals: base.discovery.open_residuals, more_roots: more, emitted_offset: offset });
  const index = assembled.index.continuation === null ? assembled.index : {
    ...assembled.index, continuation: sealIssuedContinuation(assembled.index.continuation)
  };
  const proofs = page.flatMap(row => row.proofs);
  const deliveredSources = new Set(page.flatMap(row => row.entry.target.kind === "source_evidence"
    ? [`${row.entry.target.workspace_id}\0${row.entry.target.root_id}\0${row.entry.target.source_version}\0${row.entry.target.content_digest}`] : []));
  meter.charge(base.unproved_computations.length + page.length, 0, "library unproved computation page selection");
  const unproved = base.unproved_computations.filter(row => deliveredSources.has(
    `${row.source_record.workspace_id}\0${row.source_record.identity}\0${row.source_record.source_version}\0${row.source_record.content_digest}`));
  const previews = Object.fromEntries(page.map(row => [indexEntryCacheKey(row.entry), row.preview]));
  const source_disclosures = Object.fromEntries(page.map(row => {
    const { source_time: _source_time, ...disclosure } = row.source_disclosure;
    return [indexEntryCacheKey(row.entry), {
      ...disclosure,
      proof_use: row.proofs.length > 0
        ? { kind: "conditional_support" as const, qualification: "not_world_claim" as const }
        : { kind: "source_only" as const, qualification: "not_current_proof" as const }
    }];
  }));
  const discovery = { ...base.discovery, access };
  const work = reserveWork ? reservedWork(request) : workOf(meter);
  const result = SourceSemanticWorkerResultSchema.parse({ kind: "recall", request_budget: request.budget,
    request_identity: base.public_request_identity,
    query_semantics_status: base.query_semantics_status,
    delivery_id: preparedDeliveryId(base.public_request_identity, index), protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
    total_count: index.entries.length, index, page_purpose: "membership", order: SOURCE_SEMANTIC_LIBRARY_ORDER,
    discovery, slot_qualifiers: slotQualifiersFor(index, proofs).map(row => ({ ...row,
      payload_support: page[row.index]!.payload_support, selection_basis: page[row.index]!.selection_basis })),
    ...(proofs.length === 0 ? {} : { proofs }),
    ...(unproved.length === 0 ? {} : { unproved_computations: unproved }), previews, source_disclosures, work,
    coverage: { ...base.coverage, conditional_computation: base.query_semantics_status.status === "unavailable" ? "unexercised"
      : base.coverage.conditional_computation,
      payload: page.some(row => row.entry.target.kind === "source_evidence" && !row.entry.target.span?.content_complete)
        ? "truncated" : base.coverage.payload }
  });
  if (result.kind !== "recall") throw new CoreError("OBLIGATION_VIOLATION", "library delivery result kind changed");
  return result;
}
function reservedWork(request: Request) {
  return { native_work: request.budget.work_units, logical_work: request.budget.work_units,
    native_bytes: request.budget.memory_bytes, logical_memory_bytes: request.budget.memory_bytes,
    rss_bytes: Number.MAX_SAFE_INTEGER };
}
function root(row: SourceSemanticLibraryPackage): string {
  if (row.entry.target.kind !== "source_evidence") throw new CoreError("OBLIGATION_VIOLATION", "library package has no source root");
  return sourceGoldRootIdentity(row.entry.target);
}
function pageKey(page: readonly SourceSemanticLibraryPackage[]): string {
  return JSON.stringify(page.map(row => indexEntryCacheKey(row.entry)));
}
