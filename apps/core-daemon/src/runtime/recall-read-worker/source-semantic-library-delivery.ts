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

/** Freeze membership, witness packages and support reservations before exposing any page. */
export function prepareLibraryDelivery(base: PlanBase, candidates: readonly SourceSemanticLibraryPackage[],
  request: Request, meter: SourceSemanticReadBudget): LibraryDeliveryPlan {
  const pages: SourceSemanticLibraryPackage[][] = [];
  const pageAccess: SourceSemanticAccessReceipt[] = [];
  let remaining = [...candidates], offset = 0, incomplete = false;
  while (remaining.length > 0) {
    try {
      const accessByPage = new Map<string, SourceSemanticAccessReceipt>();
      const selected = selectSourceSemanticLibraryPage({ candidates: remaining, meter, fits: page => {
        const access = libraryAccessReceipt(base.pool, base.discovery.examined_source_interpretation_ids,
          page.flatMap(row => row.entry.target.kind === "source_evidence" ? [row.entry.target.root_id] : []), meter);
        const result = pageResult(base, page, offset, true, request, meter, true, access);
        const encoded = encodeSourceSemanticLibraryResponse(result);
        meter.retain(encoded, "candidate delivery encoding");
        const bytes = Buffer.byteLength(JSON.stringify(encoded));
        meter.charge(1, bytes * 2, "candidate delivery bytes");
        const fits = bytes <= request.output_byte_limit && "results" in encoded
          && encoded.results !== undefined && encoded.results.every(row => row.budget_state.within_budget);
        if (fits) accessByPage.set(pageKey(page), access);
        return fits;
      } });
      if (selected.length === 0) { incomplete = true; break; }
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
  const frozenPages = pages.length === 0 ? [[]] : pages;
  const page_access = pages.length === 0
    ? [libraryAccessReceipt(base.pool, base.discovery.examined_source_interpretation_ids, [], meter)]
    : pageAccess;
  const { pool: _pool, ...frozenBase } = base;
  return { ...frozenBase, pages: frozenPages, page_access,
    coverage: incomplete ? { ...base.coverage, payload: "truncated" } : base.coverage,
    discovery: incomplete ? { ...base.discovery, truncated: true, open_residuals: true } : base.discovery };
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
  meter.retain(encodeSourceSemanticLibraryResponse(result), "library public serialization");
  const final = { ...result, work: workOf(meter) };
  if (Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(final))) > request.output_byte_limit) {
    throw new CoreError("VALIDATION", "output budget cannot retain reserved source support");
  }
  return final;
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
  const source_disclosures = Object.fromEntries(page.map(row => [indexEntryCacheKey(row.entry), {
    ...row.source_disclosure,
    proof_use: row.proofs.length > 0
      ? { kind: "conditional_support" as const, qualification: "not_world_claim" as const }
      : { kind: "source_only" as const, qualification: "not_current_proof" as const }
  }]));
  const discovery = { ...base.discovery, access };
  const work = reserveWork ? { native_work: request.budget.work_units, logical_work: request.budget.work_units,
    native_bytes: request.budget.memory_bytes, logical_memory_bytes: request.budget.memory_bytes, rss_bytes: Number.MAX_SAFE_INTEGER } : workOf(meter);
  const result = SourceSemanticWorkerResultSchema.parse({ kind: "recall", request_budget: request.budget,
    request_identity: base.public_request_identity,
    query_semantics_status: base.query_semantics_status,
    delivery_id: preparedDeliveryId(base.public_request_identity, index), protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
    total_count: index.entries.length, index, page_purpose: "membership", order: SOURCE_SEMANTIC_LIBRARY_ORDER,
    discovery, slot_qualifiers: slotQualifiersFor(index, proofs).map((row, position) => ({ ...row,
      payload_support: page[position]!.payload_support, selection_basis: page[position]!.selection_basis })),
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
function root(row: SourceSemanticLibraryPackage): string {
  if (row.entry.target.kind !== "source_evidence") throw new CoreError("OBLIGATION_VIOLATION", "library package has no source root");
  return sourceGoldRootIdentity(row.entry.target);
}
function pageKey(page: readonly SourceSemanticLibraryPackage[]): string {
  return JSON.stringify(page.map(row => indexEntryCacheKey(row.entry)));
}
