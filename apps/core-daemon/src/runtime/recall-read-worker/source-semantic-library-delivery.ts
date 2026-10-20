import { qualifySourceDisclosure, sourceDisclosure, SourceSemanticWorkerResultSchema, SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
  SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, indexEntryCacheKey, sourceSemanticExecution, type SourceSemanticExecution, type SourceSemanticCoverage, type SourceSemanticQueryStatus, type SourceSemanticLibraryDiscovery,
  type SourceSemanticAccessReceipt, type SourceSemanticLibraryUnprovedComputation, type SourceSemanticResourceBudget,
  type SourceSemanticWorkerRequest, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { CoreError, assembleSourceSemanticLibraryIndex, createSourceSemanticLibraryEncoding,
  type SourceSemanticLibraryEncoding,
  preparedDeliveryId, selectSourceSemanticLibraryPage, improveSourceSemanticLibraryPage, sealIssuedContinuation, slotQualifiersFor,
  sourceGoldRootIdentity, SOURCE_SEMANTIC_LIBRARY_ORDER, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { workOf, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { libraryAccessReceipt, type SourceSemanticAccessPool } from "./source-semantic-candidate-access.js";
import { issueSemanticLease, sourceSemanticLifetimeNow, sourceSemanticRevision } from "./source-semantic-leases.js";
import { prepareLibraryPackagePairs } from "./source-semantic-library-packages.js";
import { prepareSourceRecallDelivery, packSourceRecallTimes, sourceRecallPageAt, type SourceRecallMember } from "./source-recall-delivery.js";

type Request = Extract<SourceSemanticWorkerRequest, { kind: "recall" }>;
type Recall = Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
export type LibraryDeliveryPlan = Readonly<{
  query_id: string; snapshot_id: string; interpretation_id: string; as_of: string; expires_at: string;
  query_semantics_status: SourceSemanticQueryStatus;
  authorized: readonly string[] | null; request_identity: string; public_request_identity: string;
  discovery: SourceSemanticLibraryDiscovery; coverage: SourceSemanticCoverage;
  unproved_computations: readonly SourceSemanticLibraryUnprovedComputation[];
  pages: readonly (readonly SourceSemanticLibraryPackage[])[]; page_access: readonly SourceSemanticAccessReceipt[];
}>;
type PlanBase = Omit<LibraryDeliveryPlan, "pages" | "page_access"> & Readonly<{ pool: SourceSemanticAccessPool }>;
export type LibraryPageSelector = typeof selectSourceSemanticLibraryPage;

/** Only the Core owner's executed capture price defines this future allowance.
 * Parent remaining minus this child's creation allowance is already available after
 * absorption. Hold only the uncovered part. A same-meter caller has no such headroom. */
class LibraryCaptureCompletion {
  private readonly releases: (() => void)[] = [];
  private held = { work_units: 0, memory_bytes: 0 };
  constructor(private readonly parentHeadroom: SourceSemanticResourceBudget) {}
  protect(meter: SourceSemanticReadBudget, cost: SourceSemanticResourceBudget): void {
    const uncovered = { work_units: Math.max(0, cost.work_units - this.parentHeadroom.work_units),
      memory_bytes: Math.max(0, cost.memory_bytes - this.parentHeadroom.memory_bytes) };
    const increment = { work_units: Math.max(0, uncovered.work_units - this.held.work_units),
      memory_bytes: Math.max(0, uncovered.memory_bytes - this.held.memory_bytes) };
    if (increment.work_units === 0 && increment.memory_bytes === 0) return;
    meter.charge(1, 24, "library encoding completion hold record");
    this.releases.push(meter.hold(increment));
    this.held = { work_units: this.held.work_units + increment.work_units,
      memory_bytes: this.held.memory_bytes + increment.memory_bytes };
  }
  close(): void { for (const release of this.releases) release(); }
}

/** Materialization/projection adapter. The neutral phase owns every membership and fit decision.
 * An optional selection child is absorbed before parent-funded finalization can spend. */
export function prepareLibraryDelivery(base: PlanBase, candidates: readonly SourceSemanticLibraryPackage[],
  request: Request, finalization: SourceSemanticReadBudget, order: "field" | "source_access" = "field",
  selectPage: LibraryPageSelector = selectSourceSemanticLibraryPage,
  initialExecution: SourceSemanticExecution = sourceSemanticExecution(), selection?: SourceSemanticReadBudget): LibraryDeliveryPlan {
  const meter = selection ?? finalization;
  const parentRemaining = finalization.remaining(), childRemaining = meter.remaining();
  const completion = new LibraryCaptureCompletion({
    work_units: Math.max(0, parentRemaining.work_units - childRemaining.work_units),
    memory_bytes: Math.max(0, parentRemaining.memory_bytes - childRemaining.memory_bytes) });
  const continuationExecution = sourceSemanticExecution();
  // These are the canonical arrays retained by the lease. No ordinal plan survives this call.
  const pages: SourceSemanticLibraryPackage[][] = [], pageAccess: SourceSemanticAccessReceipt[] = [];
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
  let lastResult: Recall | undefined, lastAccess: SourceSemanticAccessReceipt | undefined;
  let lastRows: readonly SourceSemanticLibraryPackage[] | undefined;
  let encoding: SourceSemanticLibraryEncoding | undefined, incomplete: boolean;
  let rawPage: ReturnType<typeof createRawPageEncoder> | undefined;
  try { incomplete = prepareSourceRecallDelivery({ meter, count: candidates.length, byteLimit: request.output_byte_limit,
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
      if (!partial) {
        lastAccess = libraryAccessReceipt(base.pool, base.discovery.examined_source_interpretation_ids,
          rows.flatMap(row => row.entry.target.kind === "source_evidence" ? [row.entry.target.root_id] : []), meter);
      }
      if (lastAccess === undefined) throw new CoreError("OBLIGATION_VIOLATION", "encoding has no access receipt");
      if (selectPage === selectSourceSemanticLibraryPage && base.unproved_computations.length === 0
        && lastAccess.interpretation_candidates.length === 0
        && lastAccess.source_candidates.every(source => rows.some(row => row.entry.target.kind === "source_evidence" && row.entry.target.root_id === source.record_id))
        && rows.every(row => row.proofs.length === 0 && row.entry.target.kind === "source_evidence"
          && row.entry.interpretation_node === undefined && row.entry.explanation_ids.length === 0)) {
        encoding ??= createSourceSemanticLibraryEncoding(meter);
        rawPage ??= createRawPageEncoder(base, request, meter, encoding, initialExecution, continuationExecution);
        meter.observer?.facts.encodingInvocation(meter.phase, partial ? "candidate_partial_quote" : "candidate_quote");
        meter.charge(page.length, page.length * 8, "library encoding raw member keys");
        const quoted = rawPage(rows, page.map(choice => get(choice.member)), offset, more, partial, lastAccess);
        if (quoted !== null) {
          if (quoted.bytes <= request.output_byte_limit && quoted.withinBudget) completion.protect(meter, quoted.capture);
          return { encoding: "completion_quote", access: lastAccess, ...quoted };
        }
      }
      if (!partial) lastResult = pageResult(base, rows, offset, more, request, meter, true, lastAccess,
        offset === 0 ? initialExecution : continuationExecution);
      if (lastResult === undefined) throw new CoreError("OBLIGATION_VIOLATION", "partial encoding has no complete envelope");
      const result = partial ? { ...lastResult, coverage: { ...lastResult.coverage, payload: "truncated" as const } } : lastResult;
      encoding ??= createSourceSemanticLibraryEncoding(meter);
      const quoted = encodeCompletePage(encoding, result, rows, meter, offset, more, partial);
      if (quoted.bytes <= request.output_byte_limit && quoted.withinBudget) completion.protect(meter, quoted.capture);
      return { encoding: "complete_envelope", access: lastAccess, ...quoted,
        payloadGrowth: Math.max(0, JSON.stringify("truncated").length - JSON.stringify(lastResult.coverage.payload).length) };
    },
    finishEncoding: () => { lastResult = undefined; lastAccess = undefined; lastRows = undefined; },
    append: (page, access) => { pages.push(materialize(page)); pageAccess.push(access); },
    replace: (position, page, access) => { pages[position] = materialize(page); pageAccess[position] = access; },
    pageCount: () => pages.length, pageLength: position => pages[position]!.length
  }); } finally {
    encoding?.close();
    // Future captures are held, not spent. Release before the parent absorbs this
    // selection child and performs the accepted page's actual final materialization.
    completion.close();
    if (selection !== undefined) finalization.absorb(selection);
  }
  const frozenPages = pages.length === 0 ? [[]] : pages;
  // Failed candidate traces remain spent in selection. The distinct empty trace
  // executes only after that debit reaches the parent; no child capacity is reused.
  const page_access = pages.length === 0
    ? [libraryAccessReceipt(base.pool, base.discovery.examined_source_interpretation_ids, [], finalization)] : pageAccess;
  meter.observer?.event("frozen_membership", meter.phase, () => ({ incomplete,
    pages: frozenPages.map((page, position) => ({ position, targets: page.map(row => row.entry.target) })) }));
  const { pool: _pool, ...frozenBase } = base;
  const plan = { ...frozenBase, pages: frozenPages, page_access,
    coverage: incomplete ? { ...base.coverage, payload: "truncated" as const } : base.coverage,
    discovery: incomplete ? { ...base.discovery, truncated: true, open_residuals: true } : base.discovery };
  meter.observer?.facts.plan(plan, base.pool);
  return plan;
}

/** Unsupported/proof shapes keep actual complete materialization, retention and encoding. */
function encodeCompletePage(encoding: SourceSemanticLibraryEncoding, result: Recall, rows: readonly SourceSemanticLibraryPackage[],
  meter: SourceSemanticReadBudget, offset: number, more: boolean, partial: boolean) {
  meter.observer?.event("encoding_attempt", meter.phase, () => partial
    ? { offset, more, variant: "partial_payload", targets: rows.map(row => row.entry.target) }
    : { offset, more, targets: rows.map(row => row.entry.target), proof_counts: rows.map(row => row.proofs.length) });
  meter.observer?.facts.encodingInvocation(meter.phase, partial ? "candidate_partial_page" : "candidate_page");
  const { response: encoded, capture } = encoding.materialize(result);
  meter.retain(encoded, partial ? "candidate partial delivery encoding" : "candidate delivery encoding");
  const json = JSON.stringify(encoded), bytes = Buffer.byteLength(json);
  meter.observer?.facts.encoding(meter.phase, partial ? "candidate_partial_page" : "candidate_page", json,
    "results" in encoded ? encoded.results?.map(row => row.content_preview) ?? [] : []);
  meter.charge(1, bytes * 2, partial ? "candidate partial delivery bytes" : "candidate delivery bytes");
  return { capture, bytes, withinBudget: "results" in encoded && encoded.results !== undefined
    && encoded.results.every(row => row.budget_state.within_budget) };
}

/** Continuations reuse the frozen plan; no source access, solver replay or re-selection occurs. */
export function deliverFrozenLibraryPage(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  meter: SourceSemanticReadBudget, request: Request, plan: LibraryDeliveryPlan, offset: number): Recall {
  const result = fitFrozenLibraryPage(meter, request, plan, offset);
  if (result.index.continuation !== null) {
    const continuation = result.index.continuation;
    issueSemanticLease(runtime, { kind: "library", workspace_id: payload.workspace_id,
      lifetime_now: sourceSemanticLifetimeNow(payload), principal: payload.principal ?? "", as_of: plan.as_of,
      authorized: plan.authorized, expires_at: plan.expires_at, revision: sourceSemanticRevision(runtime),
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
  const encoding = createSourceSemanticLibraryEncoding(meter);
  let baseEncoded: ReturnType<SourceSemanticLibraryEncoding["materialize"]>["response"];
  try { baseEncoded = encoding.materialize(result).response; } finally { encoding.close(); }
  meter.observer?.event("encoded_membership", "final_delivery", () => ({ offset,
    results: "results" in baseEncoded ? baseEncoded.results?.map(row => ({ target: row.target, preview_bytes: Buffer.byteLength(row.content_preview), within_budget: row.budget_state.within_budget })) ?? null : null }));
  meter.retain(baseEncoded, "library public serialization");
  if (!("results" in baseEncoded) || baseEncoded.results === undefined
    || baseEncoded.results.some(row => !row.budget_state.within_budget)) {
    throw new CoreError("VALIDATION", "final source support failed payload admission");
  }
  const encodedJson = JSON.stringify(baseEncoded);
  const encodedBytes = Buffer.byteLength(encodedJson);
  const reservedBytes = encodedBytes
    + Buffer.byteLength(JSON.stringify(reservedLibraryWork(request))) - Buffer.byteLength(JSON.stringify(result.work));
  meter.observer?.facts.encoding("final_delivery", "base_page", encodedJson,
    "results" in baseEncoded ? baseEncoded.results?.map(row => row.content_preview) ?? [] : []);
  meter.observer?.event("encoding_result", "final_delivery", () => ({ offset, bytes: reservedBytes, encoded_bytes: encodedBytes,
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
function pageIndex(base: Omit<LibraryDeliveryPlan, "pages" | "page_access">, page: readonly SourceSemanticLibraryPackage[], offset: number, more: boolean) {
  const assembled = assembleSourceSemanticLibraryIndex({ ...base, authorized_scopes: base.authorized,
    source_entries: page.map(row => row.entry), proof_groups: page.filter(row => row.proofs.length > 0),
    selected_entries: page.map(row => row.entry), root_order: page.map(root), truncated: base.discovery.truncated,
    open_residuals: base.discovery.open_residuals, more_roots: more, emitted_offset: offset });
  const index = assembled.index.continuation === null ? assembled.index : { ...assembled.index, continuation: sealIssuedContinuation(assembled.index.continuation) };
  return index;
}
function pageDisclosure(row: SourceSemanticLibraryPackage, meter: SourceSemanticReadBudget) {
  const wire = qualifySourceDisclosure(row.source_disclosure, row.proofs.length > 0 ? "conditional_support" : "source_only", false);
  meter.retain(wire, "library disclosure codec allocation"); return wire;
}
function pageCoverage(base: Omit<LibraryDeliveryPlan, "pages" | "page_access">, page: readonly SourceSemanticLibraryPackage[]) {
  return { ...base.coverage, conditional_computation: base.query_semantics_status.status === "unavailable" ? "unexercised" as const : base.coverage.conditional_computation,
    payload: page.some(row => row.entry.target.kind === "source_evidence" && !row.entry.target.span?.content_complete) ? "truncated" as const : base.coverage.payload };
}
function createRawPageEncoder(base: PlanBase, request: Request, meter: SourceSemanticReadBudget,
  encoding: SourceSemanticLibraryEncoding, initialExecution: SourceSemanticExecution, continuationExecution: SourceSemanticExecution) {
  type Raw = NonNullable<ReturnType<SourceSemanticLibraryEncoding["prepareRaw"]>>;
  meter.charge(1, 64, "library encoding raw member reference table");
  const members = new Map<SourceSemanticLibraryPackage, Raw["members"][number]>();
  let raw: Raw | undefined, initialOffset = 0;
  return (page: readonly SourceSemanticLibraryPackage[], keys: readonly SourceSemanticLibraryPackage[],
    offset: number, more: boolean, partial: boolean, access: SourceSemanticAccessReceipt) => {
    if (raw === undefined) {
      const result = pageResult(base, page, offset, more, request, meter, true, access,
        offset === 0 ? initialExecution : continuationExecution);
      meter.observer?.facts.encodingInvocation(meter.phase, "candidate_initial_projection");
      raw = encoding.prepareRaw(result, continuationExecution) ?? undefined;
      if (raw === undefined) return null;
      initialOffset = offset;
      for (const [position, row] of page.entries()) {
        meter.charge(1, 16, "library encoding raw member reference"); members.set(keys[position]!, raw.members[position]!);
        meter.observer?.facts.encodingInvocation(meter.phase, "raw_component_projection");
      }
      if (!partial) return raw.initial;
    }
    // A session first captured on a continuation cannot stand in for an active
    // initial execution. That rare revisit keeps the complete authoritative path.
    if (initialOffset !== 0 && offset === 0) return null;
    const handles = page.map((row, position) => {
      meter.charge(1, 0, "library encoding raw member reference lookup");
      let member = members.get(keys[position]!);
      if (member === undefined) {
        member = raw!.member({ entry: row.entry, preview: row.preview, source_disclosure: pageDisclosure(row, meter),
          source_access: access.source_candidates.find(source => row.entry.target.kind === "source_evidence" && source.record_id === row.entry.target.root_id) }) ?? undefined;
        if (member === undefined) throw new CoreError("OBLIGATION_VIOLATION", "raw encoding rejected a source-only member");
        meter.observer?.facts.encodingInvocation(meter.phase, "raw_component_projection");
        meter.charge(1, 16, "library encoding raw member reference"); members.set(keys[position]!, member);
      }
      return member;
    });
    // Empty membership borrows the actual Core index constructor without repeatedly
    // parsing every member; emitted_offset still names the real page boundary.
    const { entries: _entries, ...index } = pageIndex(base, [], offset + page.length, more);
    return raw.quote({ index: { completeness: index.completeness, continuation: index.continuation, order_status: index.order_status },
      access: { source_order: access.source_candidates.map(source => page.findIndex(row => row.entry.target.kind === "source_evidence"
        && row.entry.target.root_id === source.record_id)), trace: access.trace },
      slot_qualifiers: pageSlots({ ...index, entries: page.map(row => row.entry) }, [], page),
      payload: partial ? "truncated" : pageCoverage(base, page).payload, execution: offset === 0 ? "initial" : "continuation" }, handles);
  };
}
function pageSlots(index: Parameters<typeof slotQualifiersFor>[0], proofs: NonNullable<Recall["proofs"]>, page: readonly SourceSemanticLibraryPackage[]) {
  return slotQualifiersFor(index, proofs).map(row => ({ ...row,
    payload_support: page[row.index]!.payload_support, selection_basis: page[row.index]!.selection_basis }));
}
function pageResult(base: Omit<LibraryDeliveryPlan, "pages" | "page_access">, page: readonly SourceSemanticLibraryPackage[], offset: number, more: boolean,
  request: Request, meter: SourceSemanticReadBudget, reserveWork: boolean, access: SourceSemanticAccessReceipt, execution: SourceSemanticExecution): Recall {
  const index = pageIndex(base, page, offset, more);
  const proofs = page.flatMap(row => row.proofs);
  const deliveredSources = new Set(page.flatMap(row => row.entry.target.kind === "source_evidence"
    ? [`${row.entry.target.workspace_id}\0${row.entry.target.root_id}\0${row.entry.target.source_version}\0${row.entry.target.content_digest}`] : []));
  meter.charge(base.unproved_computations.length + page.length, 0, "library unproved computation page selection");
  const unproved = base.unproved_computations.filter(row => deliveredSources.has(`${row.source_record.workspace_id}\0${row.source_record.identity}\0${row.source_record.source_version}\0${row.source_record.content_digest}`));
  const previews = Object.fromEntries(page.map(row => [indexEntryCacheKey(row.entry), row.preview]));
  const source_disclosures = Object.fromEntries(page.map(row => [indexEntryCacheKey(row.entry), pageDisclosure(row, meter)]));
  const result = SourceSemanticWorkerResultSchema.parse({ kind: "recall", request_budget: request.budget, execution,
    request_identity: base.public_request_identity, query_semantics_status: base.query_semantics_status,
    delivery_id: preparedDeliveryId(base.public_request_identity, index), protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
    total_count: index.entries.length, index, page_purpose: "membership", order: SOURCE_SEMANTIC_LIBRARY_ORDER,
    discovery: { ...base.discovery, access }, slot_qualifiers: pageSlots(index, proofs, page),
    ...(proofs.length === 0 ? {} : { proofs }), ...(unproved.length === 0 ? {} : { unproved_computations: unproved }),
    previews, source_disclosures, work: reserveWork ? reservedLibraryWork(request) : workOf(meter),
    coverage: pageCoverage(base, page)
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
