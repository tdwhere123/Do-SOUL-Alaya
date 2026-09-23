import { SourceSemanticResourceExhausted, SourceSemanticWorkerResultSchema, SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
  indexEntryCacheKey, type SourceSemanticCoverage, type SourceSemanticQueryStatus, type SourceSemanticLibraryDiscovery,
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
  authorized: readonly string[] | null; request_identity: string; public_request_identity: string; pool: SourceSemanticAccessPool;
  discovery: SourceSemanticLibraryDiscovery; coverage: SourceSemanticCoverage;
  pages: readonly (readonly SourceSemanticLibraryPackage[])[];
}>;
type PlanBase = Omit<LibraryDeliveryPlan, "pages">;

/** Freeze membership, witness packages and support reservations before exposing any page. */
export function prepareLibraryDelivery(base: PlanBase, candidates: readonly SourceSemanticLibraryPackage[],
  request: Request, meter: SourceSemanticReadBudget): LibraryDeliveryPlan {
  const pages: SourceSemanticLibraryPackage[][] = [];
  let remaining = [...candidates], offset = 0, incomplete = false;
  while (remaining.length > 0) {
    try {
      const selected = selectSourceSemanticLibraryPage({ candidates: remaining, meter, fits: page => {
        const result = pageResult(base, page, offset, true, request, meter, true);
        const encoded = encodeSourceSemanticLibraryResponse(result);
        meter.retain(encoded, "candidate delivery encoding");
        const bytes = Buffer.byteLength(JSON.stringify(encoded));
        meter.charge(1, bytes * 2, "candidate delivery bytes");
        return bytes <= request.output_byte_limit && "results" in encoded
          && encoded.results !== undefined && encoded.results.every(row => row.budget_state.within_budget);
      } });
      if (selected.length === 0) { incomplete = true; break; }
      pages.push([...selected]); offset += selected.length;
      const roots = new Set(selected.map(root));
      remaining = remaining.filter(row => !roots.has(root(row)));
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      incomplete = true; break;
    }
  }
  return { ...base, pages: pages.length === 0 ? [[]] : pages,
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
  const result = pageResult(plan, page, offset, pageIndex + 1 < plan.pages.length, request, meter, false);
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

function pageResult(base: PlanBase, page: readonly SourceSemanticLibraryPackage[], offset: number, more: boolean,
  request: Request, meter: SourceSemanticReadBudget, reserveWork: boolean): Recall {
  const assembled = assembleSourceSemanticLibraryIndex({ ...base, authorized_scopes: base.authorized,
    source_entries: page.map(row => row.entry), proof_groups: page.filter(row => row.proofs.length > 0),
    selected_entries: page.map(row => row.entry), root_order: page.map(root),
    truncated: base.discovery.truncated, open_residuals: base.discovery.open_residuals, more_roots: more, emitted_offset: offset });
  const index = assembled.index.continuation === null ? assembled.index : {
    ...assembled.index, continuation: sealIssuedContinuation(assembled.index.continuation)
  };
  const proofs = page.flatMap(row => row.proofs);
  const previews = Object.fromEntries(page.map(row => [indexEntryCacheKey(row.entry), row.preview]));
  const discovery = { ...base.discovery, access: libraryAccessReceipt(base.pool,
    base.discovery.examined_source_interpretation_ids, page.flatMap(row => row.entry.target.kind === "source_evidence" ? [row.entry.target.root_id] : []), meter) };
  const work = reserveWork ? { native_work: request.budget.work_units, logical_work: request.budget.work_units,
    native_bytes: request.budget.memory_bytes, logical_memory_bytes: request.budget.memory_bytes, rss_bytes: Number.MAX_SAFE_INTEGER } : workOf(meter);
  const result = SourceSemanticWorkerResultSchema.parse({ kind: "recall", request_budget: request.budget,
    request_identity: base.public_request_identity,
    query_semantics_status: base.query_semantics_status,
    delivery_id: preparedDeliveryId(base.public_request_identity, index), protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
    total_count: index.entries.length, index, page_purpose: "membership", order: SOURCE_SEMANTIC_LIBRARY_ORDER,
    discovery, slot_qualifiers: slotQualifiersFor(index, proofs).map((row, position) => ({ ...row,
      payload_support: page[position]!.payload_support, selection_basis: page[position]!.selection_basis })),
    ...(proofs.length === 0 ? {} : { proofs }), previews, work,
    coverage: { ...base.coverage, conditional_computation: base.query_semantics_status.status === "unavailable" ? "unexercised"
      : proofs.length > 0 && base.coverage.conditional_computation !== "open" ? "complete" : "open",
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
