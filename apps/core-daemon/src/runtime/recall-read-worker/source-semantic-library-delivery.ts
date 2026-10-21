import { qualifySourceDisclosure, sourceDisclosure, SourceSemanticWorkerResultSchema, SourceSemanticComparisonWorkerResultSchema, SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
  SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, indexEntryCacheKey, sourceSemanticExecution, type SourceSemanticReadableExecution, type SourceSemanticAccessProfile, type SourceSemanticCoverage, type SourceSemanticQueryStatus, type SourceSemanticLibraryDiscovery,
  type SourceSemanticReadableAccessReceipt, type SourceSemanticLibraryUnprovedComputation,
  type SourceSemanticReadableWorkerRequest as SourceSemanticWorkerRequest, type SourceSemanticWorkerResult, type SourceSemanticReadableWorkerResult } from "@do-soul/alaya-protocol";
import { CoreError, assembleSourceSemanticLibraryIndex, encodeSourceSemanticLibraryResponse,
  preparedDeliveryId, selectSourceSemanticLibraryPage, improveSourceSemanticLibraryPage, sealIssuedContinuation, slotQualifiersFor,
  sourceGoldRootIdentity, SOURCE_SEMANTIC_LIBRARY_ORDER, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { workOf, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { libraryAccessReceipt, type SourceSemanticReadableAccessPool as SourceSemanticAccessPool } from "./source-semantic-candidate-access.js";
import { issueSemanticLease, sourceSemanticLifetimeNow, sourceSemanticRevision } from "./source-semantic-leases.js";
import { prepareLibraryPackagePairs } from "./source-semantic-library-packages.js";
import { prepareSourceRecallDelivery, packSourceRecallTimes, sourceRecallPageAt, type SourceRecallMember } from "./source-recall-delivery.js";

type Request = Extract<SourceSemanticWorkerRequest, { kind: "recall" }>;
type Recall = Extract<SourceSemanticReadableWorkerResult, { kind: "recall" }>;
export type LibraryDeliveryPlan = Readonly<{
  query_id: string; snapshot_id: string; interpretation_id: string; as_of: string; expires_at: string;
  profile?: SourceSemanticAccessProfile;
  retainedWitness?: import("@do-soul/alaya-protocol").SourceSemanticRetainedNominationWitness;
  query_semantics_status: SourceSemanticQueryStatus;
  authorized: readonly string[] | null; request_identity: string; public_request_identity: string;
  discovery: SourceSemanticLibraryDiscovery; coverage: SourceSemanticCoverage;
  unproved_computations: readonly SourceSemanticLibraryUnprovedComputation[];
  pages: readonly (readonly SourceSemanticLibraryPackage[])[]; page_access: readonly SourceSemanticReadableAccessReceipt[];
}>;
type PlanBase = Omit<LibraryDeliveryPlan, "pages" | "page_access"> & Readonly<{ pool: SourceSemanticAccessPool }>;
export type LibraryPageSelector = typeof selectSourceSemanticLibraryPage;

/** Materialization/projection adapter. The neutral phase owns every membership and fit decision. */
export function prepareLibraryDelivery(base: PlanBase, candidates: readonly SourceSemanticLibraryPackage[],
  request: Request, meter: SourceSemanticReadBudget, order: "field" | "source_access" = "field",
  selectPage: LibraryPageSelector = selectSourceSemanticLibraryPage,
  initialExecution: SourceSemanticReadableExecution = sourceSemanticExecution()): LibraryDeliveryPlan {
  const continuationExecution = sourceSemanticExecution();
  // These are the canonical arrays retained by the lease. No ordinal plan survives this call.
  const pages: SourceSemanticLibraryPackage[][] = [], pageAccess: SourceSemanticReadableAccessReceipt[] = [];
  let pair: SourceSemanticLibraryPackage | undefined;
  const get = (member: number): SourceSemanticLibraryPackage => member === candidates.length ? pair!
    : member >= 0 ? candidates[member]!
    : pages[Math.floor((-member - 1) / SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET)]![(-member - 1) % SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET]!;
  const materialize = (page: readonly SourceRecallMember[]) => page.map(choice => {
    const row = get(choice.member);
    return choice.selection_basis === undefined || choice.selection_basis === row.selection_basis ? row
      : { ...row, selection_basis: choice.selection_basis };
  });
  // Membership references are scoped to the current Core call; they never retain a package table.
  const sameMember = (left: SourceSemanticLibraryPackage, right: SourceSemanticLibraryPackage) =>
    left.entry === right.entry && left.entries === right.entries && left.explanations === right.explanations
      && left.proofs === right.proofs && left.preview === right.preview && left.source_disclosure === right.source_disclosure
      && left.payload_support === right.payload_support && left.access_position === right.access_position;
  const bind = (rows: readonly SourceSemanticLibraryPackage[], memberAt: (position: number) => number,
    additional?: number) => (page: readonly SourceSemanticLibraryPackage[]): SourceRecallMember[] => page.map(row => {
      const index = rows.findIndex(value => sameMember(value, row));
      const member = index >= 0 ? memberAt(index) : additional !== undefined && sameMember(get(additional), row) ? additional : undefined;
      if (member === undefined) throw new CoreError("OBLIGATION_VIOLATION", "selection introduced an unknown library member");
      return { member, selection_basis: row.selection_basis };
    });
  let lastResult: Recall | undefined, lastAccess: SourceSemanticReadableAccessReceipt | undefined;
  let lastRows: readonly SourceSemanticLibraryPackage[] | undefined;
  const incomplete = prepareSourceRecallDelivery({ meter, count: candidates.length, byteLimit: request.output_byte_limit,
    initialExecutionDiffers: initialExecution !== continuationExecution, order,
    improve: order === "field" && selectPage === selectSourceSemanticLibraryPage,
    root: member => root(get(member)), target: member => get(member).entry.target,
    supportCount: member => get(member).proofs.length, accessPosition: member => get(member).access_position,
    pageKey: page => JSON.stringify(page.map(row => indexEntryCacheKey(get(row.member).entry))),
    select: input => {
      const rows = input.candidates.map(get), choices = bind(rows, position => input.candidates[position]!);
      return choices(selectPage({ candidates: rows, meter, order,
        ...(input.fitsStandalone === undefined ? {} : { fitsStandalone: (row, precedingSlots) => input.fitsStandalone!(choices([row])[0]!, precedingSlots) }),
        fits: page => input.fits(choices(page)) }));
    },
    improvePage: (position, candidate, fits) => {
      const rows = pages[position]!, additional = get(candidate);
      const choices = bind(rows, slot => -1 - position * SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET - slot, candidate);
      return choices(improveSourceSemanticLibraryPage({ page: rows, candidates: [additional], meter,
        fits: proposed => fits(choices(proposed)) }));
    },
    pairs: function* (position) {
      try {
        for (const candidate of prepareLibraryPackagePairs(candidates, pages[position]!, meter)) {
          pair = candidate; yield candidates.length;
        }
      } finally { pair = undefined; }
    },
    encode: (page, offset, more, partial) => {
      const rows = partial ? lastRows! : materialize(page);
      lastRows = rows;
      meter.observer?.event("encoding_attempt", meter.phase, () => partial
        ? { offset, more, variant: "partial_payload", targets: rows.map(row => row.entry.target) }
        : { offset, more, targets: rows.map(row => row.entry.target), proof_counts: rows.map(row => row.proofs.length) });
      if (!partial) {
        lastAccess = libraryAccessReceipt(base.pool, base.discovery.examined_source_interpretation_ids,
          rows.flatMap(row => row.entry.target.kind === "source_evidence" ? [row.entry.target.root_id] : []), meter);
        lastResult = pageResult(base, rows, offset, more, request, meter, true, lastAccess,
          offset === 0 ? initialExecution : continuationExecution);
      }
      if (lastResult === undefined || lastAccess === undefined) throw new CoreError("OBLIGATION_VIOLATION", "partial encoding has no complete envelope");
      meter.observer?.facts.encodingInvocation(meter.phase, partial ? "candidate_partial_page" : "candidate_page");
      const encoded = encodeSourceSemanticLibraryResponse(partial ? { ...lastResult, coverage: { ...lastResult.coverage, payload: "truncated" } } : lastResult);
      meter.retain(encoded, partial ? "candidate partial delivery encoding" : "candidate delivery encoding");
      const json = JSON.stringify(encoded), bytes = Buffer.byteLength(json);
      meter.observer?.facts.encoding(meter.phase, partial ? "candidate_partial_page" : "candidate_page", json,
        "results" in encoded ? encoded.results?.map(row => row.content_preview) ?? [] : []);
      meter.charge(1, bytes * 2, partial ? "candidate partial delivery bytes" : "candidate delivery bytes");
      return { access: lastAccess, bytes, withinBudget: "results" in encoded && encoded.results !== undefined && encoded.results.every(row => row.budget_state.within_budget),
        payloadGrowth: Math.max(0, JSON.stringify("truncated").length - JSON.stringify(lastResult.coverage.payload).length) };
    },
    finishEncoding: () => { lastResult = undefined; lastAccess = undefined; lastRows = undefined; },
    append: (page, access) => { pages.push(materialize(page)); pageAccess.push(access); },
    replace: (position, page, access) => { pages[position] = materialize(page); pageAccess[position] = access; },
    pageCount: () => pages.length, pageLength: position => pages[position]!.length
  });
  const frozenPages = pages.length === 0 ? [[]] : pages;
  const page_access = pages.length === 0 ? [libraryAccessReceipt(base.pool, base.discovery.examined_source_interpretation_ids, [], meter)] : pageAccess;
  meter.observer?.event("frozen_membership", meter.phase, () => ({ incomplete,
    pages: frozenPages.map((page, position) => ({ position, targets: page.map(row => row.entry.target) })) }));
  const { pool: _pool, ...frozenBase } = base;
  const plan = { ...frozenBase, pages: frozenPages, page_access,
    ...(base.pool.retainedWitness === undefined ? {} : { retainedWitness: base.pool.retainedWitness }),
    coverage: incomplete ? { ...base.coverage, payload: "truncated" as const } : base.coverage,
    discovery: incomplete ? { ...base.discovery, truncated: true, open_residuals: true } : base.discovery };
  meter.observer?.facts.plan(plan, base.pool);
  return plan;
}

/** Continuations reuse the frozen plan; no source access, solver replay or re-selection occurs. */
export function deliverFrozenLibraryPage(runtime: RecallReadWorkerRuntime,
  payload: Omit<SourceSemanticWorkerPayload, "comparison"> & { comparison?: never }, meter: SourceSemanticReadBudget,
  request: Request, plan: LibraryDeliveryPlan, offset: number): Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
export function deliverFrozenLibraryPage(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  meter: SourceSemanticReadBudget, request: Request, plan: LibraryDeliveryPlan, offset: number): Recall;
export function deliverFrozenLibraryPage(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  meter: SourceSemanticReadBudget, request: Request, plan: LibraryDeliveryPlan, offset: number): Recall {
  const result = fitFrozenLibraryPage(meter, request, plan, offset);
  if (result.index.continuation !== null) {
    const continuation = result.index.continuation;
    issueSemanticLease(runtime, { kind: "library", workspace_id: payload.workspace_id,
      lifetime_now: sourceSemanticLifetimeNow(payload), principal: payload.principal ?? "", as_of: plan.as_of,
      authorized: plan.authorized, expires_at: plan.expires_at, revision: sourceSemanticRevision(runtime),
      ...(plan.profile === undefined ? {} : { profile: plan.profile }),
      continuation, request_identity: plan.request_identity, library_plan: plan }, meter, continuation.continuation_id);
  }
  meter.observer?.event("delivered_membership", meter.phase, () => ({ offset,
    targets: result.index.entries.map(row => row.target), continuation: result.index.continuation !== null }));
  return { ...result, work: workOf(meter) };
}
function fitFrozenLibraryPage(meter: SourceSemanticReadBudget, request: Request, plan: LibraryDeliveryPlan, offset: number): Recall {
  const pageIndex = sourceRecallPageAt(plan.pages.length, position => plan.pages[position]!.length, offset);
  const page = plan.pages[pageIndex]!;
  const result = pageResult(plan, page, offset, pageIndex + 1 < plan.pages.length, request, meter, false,
    plan.page_access[pageIndex]!, sourceSemanticExecution(meter.preparation, meter.acquisition, meter));
  meter.observer?.event("encoding_attempt", "final_delivery", () => ({ offset, targets: page.map(row => row.entry.target) }));
  meter.observer?.facts.encodingInvocation("final_delivery", "base_page");
  const baseEncoded = encodeSourceSemanticLibraryResponse(result);
  meter.observer?.event("encoded_membership", "final_delivery", () => ({ offset,
    results: "results" in baseEncoded ? baseEncoded.results?.map(row => ({ target: row.target, preview_bytes: Buffer.byteLength(row.content_preview), within_budget: row.budget_state.within_budget })) ?? null : null }));
  meter.retain(baseEncoded, "library public serialization");
  const encodedJson = JSON.stringify(baseEncoded);
  const reservedBytes = Buffer.byteLength(encodedJson)
    + Buffer.byteLength(JSON.stringify(reservedLibraryWork(request))) - Buffer.byteLength(JSON.stringify(result.work));
  meter.observer?.facts.encoding("final_delivery", "base_page", encodedJson,
    "results" in baseEncoded ? baseEncoded.results?.map(row => row.content_preview) ?? [] : []);
  meter.observer?.event("encoding_result", "final_delivery", () => ({ offset, bytes: reservedBytes,
    byte_limit: request.output_byte_limit, fits: reservedBytes <= request.output_byte_limit }));
  if (reservedBytes > request.output_byte_limit) throw new CoreError("VALIDATION", "output budget cannot retain reserved source support");
  let final: Recall = result;
  packSourceRecallTimes({ meter, byteLimit: request.output_byte_limit, reservedBytes, count: page.length,
    time: position => sourceDisclosure(page[position]!.source_disclosure).source_time,
    disclosure: position => final.source_disclosures[indexEntryCacheKey(page[position]!.entry)],
    apply: (position, disclosure) => {
      final = { ...final, source_disclosures: { ...final.source_disclosures, [indexEntryCacheKey(page[position]!.entry)]: disclosure } };
    },
    encodingInvocation: () => { meter.observer?.facts.encodingInvocation("final_delivery", "source_time_after"); },
    encoding: (variant, json) => { meter.observer?.facts.encoding("final_delivery", variant, json, []); }
  });
  return { ...final, work: workOf(meter) };
}
function pageResult(base: Omit<LibraryDeliveryPlan, "pages" | "page_access">, page: readonly SourceSemanticLibraryPackage[], offset: number, more: boolean,
  request: Request, meter: SourceSemanticReadBudget, reserveWork: boolean, access: SourceSemanticReadableAccessReceipt, execution: SourceSemanticReadableExecution): Recall {
  const assembled = assembleSourceSemanticLibraryIndex({ ...base, authorized_scopes: base.authorized,
    result_version: base.profile?.result_version,
    source_entries: page.map(row => row.entry), proof_groups: page.filter(row => row.proofs.length > 0),
    selected_entries: page.map(row => row.entry), root_order: page.map(root), truncated: base.discovery.truncated,
    open_residuals: base.discovery.open_residuals, more_roots: more, emitted_offset: offset });
  const index = assembled.index.continuation === null ? assembled.index : { ...assembled.index, continuation: sealIssuedContinuation(assembled.index.continuation) };
  const proofs = page.flatMap(row => row.proofs);
  const deliveredSources = new Set(page.flatMap(row => row.entry.target.kind === "source_evidence"
    ? [`${row.entry.target.workspace_id}\0${row.entry.target.root_id}\0${row.entry.target.source_version}\0${row.entry.target.content_digest}`] : []));
  meter.charge(base.unproved_computations.length + page.length, 0, "library unproved computation page selection");
  const unproved = base.unproved_computations.filter(row => deliveredSources.has(`${row.source_record.workspace_id}\0${row.source_record.identity}\0${row.source_record.source_version}\0${row.source_record.content_digest}`));
  const previews = Object.fromEntries(page.map(row => [indexEntryCacheKey(row.entry), row.preview]));
  const source_disclosures = Object.fromEntries(page.map(row => {
    const wire = qualifySourceDisclosure(row.source_disclosure, row.proofs.length > 0 ? "conditional_support" : "source_only", false);
    meter.retain(wire, "library disclosure codec allocation"); return [indexEntryCacheKey(row.entry), wire];
  }));
  const result = (base.profile === undefined ? SourceSemanticWorkerResultSchema : SourceSemanticComparisonWorkerResultSchema).parse({ kind: "recall", request_budget: request.budget, execution,
    request_identity: base.public_request_identity, query_semantics_status: base.query_semantics_status,
    delivery_id: preparedDeliveryId(base.public_request_identity, index), protocol_version: base.profile?.protocol_version ?? SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
    total_count: index.entries.length, index, page_purpose: "membership", order: SOURCE_SEMANTIC_LIBRARY_ORDER,
    discovery: { ...base.discovery, access }, slot_qualifiers: slotQualifiersFor(index, proofs).map(row => ({ ...row,
      payload_support: page[row.index]!.payload_support, selection_basis: page[row.index]!.selection_basis })),
    ...(proofs.length === 0 ? {} : { proofs }), ...(unproved.length === 0 ? {} : { unproved_computations: unproved }),
    previews, source_disclosures, work: reserveWork ? reservedLibraryWork(request) : workOf(meter),
    coverage: { ...base.coverage, conditional_computation: base.query_semantics_status.status === "unavailable" ? "unexercised" : base.coverage.conditional_computation,
      payload: page.some(row => row.entry.target.kind === "source_evidence" && !row.entry.target.span?.content_complete) ? "truncated" : base.coverage.payload }
  });
  if (result.kind !== "recall") throw new CoreError("OBLIGATION_VIOLATION", "library delivery result kind changed");
  return result;
}
function reservedLibraryWork(request: Request) {
  return { native_work: request.budget.work_units, index_work: request.budget.work_units, native_accounting: "partial" as const,
    logical_work: request.budget.work_units, native_bytes: request.budget.memory_bytes, logical_memory_bytes: request.budget.memory_bytes, rss_bytes: Number.MAX_SAFE_INTEGER };
}
function root(row: SourceSemanticLibraryPackage): string {
  if (row.entry.target.kind !== "source_evidence") throw new CoreError("OBLIGATION_VIOLATION", "library package has no source root");
  return sourceGoldRootIdentity(row.entry.target);
}
