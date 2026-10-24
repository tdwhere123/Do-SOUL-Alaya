import {
  ORDINARY_NATIVE_FIELD_RESULT_VERSION, SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION,
  SourceSemanticFieldLibraryContinuationSchema,
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
  canonicalJson, indexEntryCacheKey, qualifySourceDisclosure, sourceGoldRootIdentity,
  sourceSemanticProofQualifier, type InformationIndex, type MemorySearchResult, type RequestBudget,
  type SourceDisclosure, type SourceEvidenceTarget, type SourceSemanticExecution,
  type SourceSemanticLibraryDiscovery, type SourceSemanticLibrarySlotQualifier,
  type SourceSemanticLibraryUnprovedComputation, type SourceSemanticQueryStatus,
  type SourceSemanticResourceLedger, type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import {
  CoreError, encodeIndexResults, frameEncodedIndex, preparedDeliveryId,
  RecallEnvelopeFraming, recallFramingInterruption, recallPageResourceRefusal,
  type RecallPageSourceMetadata
} from "@do-soul/alaya-core";
import { workOf } from "./source-semantic-discovery.js";
import { proofSupportFor, type SourceQueryProofObservation } from "./source-query-proof-observation.js";

export type FieldLibraryResult = Extract<SourceSemanticWorkerResult,
  { protocol_version: typeof SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION }>;
type Delivery = Readonly<Omit<FieldLibraryResult, "kind" | "previews" | "preparation_id" | "field_execution_receipt">>;

/** Library payload allowance of the shared page codec; the byte ceiling stays the
 * request's own `output_byte_limit`. */
export const LIBRARY_PAYLOAD_TOKENS = 2_000;

export type LibraryFieldPage = Readonly<{
  index: InformationIndex; previews: ReadonlyMap<string, string>;
  metadata: Readonly<Record<string, RecallPageSourceMetadata[string]>>;
}>;

export type LibraryFieldContext = Readonly<{
  request_identity: string;
  query_semantics_status: SourceSemanticQueryStatus;
  query_complete: boolean;
  observation: SourceQueryProofObservation;
  requested_interpretations: readonly string[];
  nominated: () => readonly SourceEvidenceTarget[];
  request_budget: RequestBudget;
  output_byte_limit: number;
  as_of: string;
  meter: SourceSemanticResourceLedger;
  /** Native source discovery this request actually observed; undefined on a frozen page. */
  native_complete: () => boolean | undefined;
  native_truncated: () => boolean | undefined;
  /** The prepared pool's own unvisited-source/interpretation state. */
  pool_open?: boolean;
  execution: (meter: SourceSemanticResourceLedger) => SourceSemanticExecution;
}>;

/** The library surface's only page codec. Membership, ranking and visible
 * intervals stay with the shared field projection; this adds the Q/H/C premise
 * to a source slot only when the delivered interval exposes its own text.
 *
 * A fit attempt may measure an envelope that the shared codec truncated; only a
 * delivered page must preserve the fitted membership exactly.
 */
export function libraryFieldDelivery(page: LibraryFieldPage, context: LibraryFieldContext,
  work: ReturnType<typeof workOf>, exactMembership = true): Delivery {
  const results = encodeIndexResults(page.index, page.previews, LIBRARY_PAYLOAD_TOKENS, page.metadata);
  if (exactMembership && results.length !== page.index.entries.length) {
    throw new CoreError("OBLIGATION_VIOLATION", "library page codec dropped fitted membership",
      { details: { encoded: results.length, fitted: page.index.entries.length } });
  }
  const framed = frameEncodedIndex(page.index, results);
  if (framed.result_version !== ORDINARY_NATIVE_FIELD_RESULT_VERSION) {
    throw new CoreError("OBLIGATION_VIOLATION", "library page is not an ordinary field result");
  }
  // The field continuation is the only shape a field page may expose; parse the
  // shared codec cursor into that authority instead of widening it with a cast.
  const continuation = framed.continuation === null || framed.continuation === undefined ? null
    : SourceSemanticFieldLibraryContinuationSchema.parse(framed.continuation);
  const index = { ...framed, result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION, continuation };
  const qualifiers: SourceSemanticLibrarySlotQualifier[] = [];
  const proofs = new Map<string, SourceQueryProofObservation["proofs"][number]>();
  const sourceDisclosures: Record<string, SourceDisclosure> = {};
  const deliveredRoots = new Set<string>();
  for (const [position, entry] of index.entries.entries()) {
    const result = results[position];
    if (entry.target.kind !== "source_evidence" || result === undefined) continue;
    const root = sourceGoldRootIdentity(entry.target);
    const span = entry.target.span;
    deliveredRoots.add(deliveredRoot(entry.target));
    const attached = proofSupportFor(context.observation.support, root)
      .filter(row => exposes(span, row));
    if (attached.length === 0) {
      qualifiers.push({ index: position, evidence_kind: "source_evidence" });
      sourceDisclosures[indexEntryCacheKey(entry)] = disclosed(result, "source_only");
      continue;
    }
    for (const row of attached) {
      qualifiers.push(sourceSemanticProofQualifier(row.proof, position));
      proofs.set(canonicalJson(row.proof), row.proof);
    }
    sourceDisclosures[indexEntryCacheKey(entry)] = disclosed(result, "conditional_support");
  }
  context.meter.charge(1, (index.entries.length + 1) * 32, "library field qualification");
  const unproved = context.observation.unproved.filter(row => deliveredRoots.has(
    `${row.source_record.workspace_id}\0${row.source_record.identity}\0${row.source_record.source_version}\0${row.source_record.content_digest}`));
  const native = context.native_complete(), truncated = context.native_truncated();
  // Discovery residual is examination/prepared-pool state. Page transport or payload
  // truncation does not make an already examined premise set undiscovered, and a
  // bounded native frontier's "partial" completion is not the pool's discovery state.
  const open = context.observation.compute_open || context.observation.interpretation_truncated
    || context.observation.examined.length < context.requested_interpretations.length
    || context.pool_open === true
    || (context.pool_open === undefined
      ? native === false || truncated === true || (native === undefined && index.entries.length === 0)
      : false);
  const payloadComplete = index.completeness.payload === "complete"
    && index.completeness.transport === "complete";
  const named = context.requested_interpretations;
  const underived = context.query_semantics_status.status === "unavailable";
  return {
    delivery_id: preparedDeliveryId(context.request_identity, index),
    request_identity: context.request_identity,
    query_semantics_status: context.query_semantics_status,
    protocol_version: SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION,
    total_count: index.entries.length,
    index,
    results,
    ...(index.page_purpose === undefined ? {} : { page_purpose: index.page_purpose }),
    discovery: discoveryOf(context, deliveredRoots, open),
    order: { enumeration_policy: "native_query", tie_policy: "canonical_identity",
      occupancy: "tagged_target_identity", occupancy_prefix: index.entries.length,
      page_budget: index.representation.page_budget },
    slot_qualifiers: qualifiers,
    source_disclosures: sourceDisclosures,
    ...(proofs.size === 0 ? {} : { proofs: [...proofs.values()] }),
    ...(unproved.length === 0 ? {} : { unproved_computations: unproved }),
    request_budget: context.request_budget,
    coverage: {
      discovery: open ? "truncated" : "complete",
      source_interpretation: named.length === 0 ? "unexercised" : "open",
      query_semantics: underived ? "unexercised" : context.query_complete ? "complete" : "open",
      semantic_correspondence: context.observation.examined.length === 0 ? "unexercised" : "open",
      conditional_computation: underived ? "unexercised" : context.observation.compute_open ? "open"
        : context.observation.executed_count === 0 ? "unexercised" : "complete",
      payload: payloadComplete ? "complete" : "truncated"
    },
    work,
    execution: context.execution(context.meter)
  };
}

/** The pre-observation control fit cannot price native evidence that did not yet
 * exist. Refit the complete library surface from its own protected finalization
 * allowance before publishing a lease or acknowledging the Core preparation. */
export function fitFinalLibraryFieldDelivery(page: LibraryFieldPage, context: LibraryFieldContext): Delivery {
  const framing = new RecallEnvelopeFraming(context.meter);
  try {
    framing.begin();
    for (const _entry of page.index.entries) framing.entry();
    framing.enterCodec();
    const delivery = libraryFieldDelivery(page, context, reservedLibraryWork(context.request_budget));
    const bytes = framing.measure(libraryFitEnvelope(delivery));
    if (bytes > context.output_byte_limit) throw recallPageResourceRefusal({
      message: "Library output budget cannot carry its final public envelope",
      available_bytes: context.output_byte_limit, required_bytes: bytes
    });
    return delivery;
  } catch (error) {
    if (framing.interrupted) throw recallFramingInterruption("work");
    throw error;
  }
}

/** The worker result keeps previews and its preparation handle private; the
 * public envelope is exactly the fitted delivery plus the operation tag. */
export function libraryWorkerResult(delivery: Delivery, previews: ReadonlyMap<string, string>,
  preparationId: string | undefined, receipt: unknown): FieldLibraryResult {
  return {
    kind: "recall", ...delivery, previews: Object.fromEntries(previews),
    ...(preparationId === undefined ? {} : { preparation_id: preparationId }),
    field_execution_receipt: receipt
  };
}

/** Byte-identical public envelope for both the fit decision and the response. */
export function libraryFitEnvelope(delivery: Delivery): unknown {
  return { operation: "recall", ...delivery };
}

/** Reserved maximum keeps the fit independent of costs that are only final after
 * delivery; the delivered envelope reports actual work and is never larger. */
export function reservedLibraryWork(request_budget: RequestBudget): ReturnType<typeof workOf> {
  return { native_work: request_budget.work_units, index_work: request_budget.work_units,
    native_accounting: "complete", logical_work: request_budget.work_units,
    native_bytes: request_budget.memory_bytes, logical_memory_bytes: request_budget.memory_bytes,
    rss_bytes: Number.MAX_SAFE_INTEGER };
}

function discoveryOf(context: LibraryFieldContext, deliveredRoots: ReadonlySet<string>,
  open: boolean): SourceSemanticLibraryDiscovery {
  const examined = context.observation.examined;
  return {
    eligible_source_count: Math.max(context.nominated().length, deliveredRoots.size),
    // The field nominates through the source index; it pages no library catalog.
    visited_source_pages: 0,
    visited_source_interpretation_pages: 0,
    visited_source_interpretation_descriptors: context.requested_interpretations.length,
    candidate_prefix: context.requested_interpretations.slice(0, 64),
    examined_source_interpretation_ids: examined,
    unexamined_source_interpretation_count:
      Math.max(0, context.requested_interpretations.length - examined.length),
    omitted_duplicate_bindings: context.observation.duplicate_bindings,
    examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
    open_residuals: open,
    truncated: open
  };
}

function deliveredRoot(target: SourceEvidenceTarget): string {
  return `${target.workspace_id}\0${target.root_id}\0${target.source_version}\0${target.content_digest}`;
}

/** Visible interval of the delivered slot must contain the proof's own text. */
function exposes(span: { content_start: number; content_end: number; content_complete: boolean;
  retained_extent?: string } | undefined, support: SourceQueryProofObservation["support"][number]): boolean {
  if (span === undefined || span.retained_extent !== "body") return false;
  // The fallback requires the real body extent, not the producer's completeness Boolean.
  if (!support.complete) return span.content_start === 0 && span.content_end >= support.end_byte;
  return span.content_start <= support.start_byte && span.content_end >= support.end_byte;
}

function disclosed(result: MemorySearchResult | undefined,
  use: "source_only" | "conditional_support"): SourceDisclosure {
  const disclosure = result?.source_disclosure;
  if (disclosure === undefined) throw new CoreError("OBLIGATION_VIOLATION",
    "library source slot has no disclosure from the shared codec");
  return qualifySourceDisclosure(disclosure, use, false);
}
