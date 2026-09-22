import {
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, SourceSemanticLibraryDeliverySchema,
  SourceSemanticResourceExhausted, SourceSemanticWorkerResultSchema, canonicalJson, indexEntryCacheKey,
  type Continuation, type IndexEntry, type InformationIndex, type SourceSemanticCorrespondence,
  type SourceSemanticCoverage, type SourceSemanticHandleDescriptor, type SourceSemanticLibraryDiscovery,
  type SourceSemanticLibraryProof, type SourceSemanticWorkerResult, type SourceSemanticWorkerWork, type RequestBudget, type SourceSemanticQuery, type SourceSemanticWorkerRequest
} from "@do-soul/alaya-protocol";
import {
  CoreError, OFFSET_CURSOR, admitSourceSemanticCorrespondence, admitSourceSemanticQuery,
  assembleSourceSemanticLibraryIndex, continuationCapabilityMatches, executeSourceSemanticInterpretation,
  fieldContractSha256, hydrateUtf8Chunk, issuedContinuationTampered, preparedDeliveryId, proofEntriesFromBranch, encodeSourceSemanticLibraryResponse,
  proofForLibraryEntry, sealIssuedContinuation, slotQualifiersFor, SOURCE_SEMANTIC_LIBRARY_ORDER,
  sourceGoldRootIdentity, sourceSemanticLibrarySourceEntry, sourceSemanticLibraryQueryIdentity, scopeSourceSemanticLibraryBranch
} from "@do-soul/alaya-core";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import type { SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import { admissionOf, discover, loadVerified, workOf } from "./source-semantic-discovery.js";
import {
  listEligibleSemanticSources, sourceSemanticReadStores, SourceSemanticReadBudget
} from "../field/source-semantic-read-stores.js";
import { issueSemanticLease, readSemanticLease, sourceSemanticLifetimeNow, sourceSemanticRevision } from "./source-semantic-leases.js";

const LIBRARY_PREVIEW_BYTES = 4_096;

/** Provider-free library recall: one query/scope, independent conditional computation, canonical occupancy delivery. */
export function runSourceSemanticLibraryRecall(
  runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget
): SourceSemanticWorkerResult {
  const request = payload.request;
  if (request.kind !== "recall") throw new CoreError("VALIDATION", "recall kind mismatch");
  meter.retain(request, "library request admission");
  const requestIdentity = fieldContractSha256(canonicalJson({ ...request, continuation: undefined }));
  const continuationLease = request.continuation === undefined ? undefined
    : readSemanticLease(runtime, payload, request.continuation.continuation_id, authorized, "library");
  if (continuationLease !== undefined && (continuationLease.request_identity !== requestIdentity
    || continuationLease.continuation === undefined || !continuationCapabilityMatches(request.continuation!)
    || canonicalJson(continuationLease.continuation) !== canonicalJson(request.continuation))) {
    throw new CoreError("VALIDATION", "library continuation request changed");
  }
  const currentClock = payload.as_of;
  payload = { ...payload, as_of: continuationLease?.as_of ?? payload.as_of };
  const lease = request.query_handle === undefined ? undefined : readSemanticLease(runtime, { ...payload, as_of: currentClock }, request.query_handle, authorized, "query");
  if (lease !== undefined && (request.original_query !== undefined && request.original_query !== lease.original_query
    || request.query_semantics !== undefined && canonicalJson(request.query_semantics) !== canonicalJson(lease.query_semantics))) {
    throw new CoreError("VALIDATION", "query handle cannot be retargeted", { details: { admission: "bound" } });
  }
  const original = lease?.original_query ?? request.original_query;
  const querySemantics = lease?.query_semantics ?? request.query_semantics;
  if (original === undefined || querySemantics === undefined) {
    throw new CoreError("VALIDATION", "recall lacks its prepared query semantics");
  }
  if (lease !== undefined) meter.retain(querySemantics, "leased query semantics admission");
  const admission = admitSourceSemanticQuery(querySemantics, original);
  if (admission.kind !== "admitted") {
    throw new CoreError("VALIDATION", admission.kind === "unsupported" ? "unsupported_producer" : "malformed_query");
  }
  // Keep a bounded finalization envelope outside exploration and native hydration.
  const exploration = new SourceSemanticReadBudget({
    work_units: Math.max(0, meter.work - Math.min(request.budget.finalization_reserve, Math.floor(meter.work / 4))),
    memory_bytes: meter.bytes - Math.min(Math.floor(meter.bytes / 4), request.output_byte_limit * 8 + 65536)
  });
  const sources = listEligibleSemanticSources(runtime.database, payload.workspace_id, exploration, authorized);
  const discovered = discoverLibraryDescriptors(runtime, payload, authorized, exploration, sources);
  const branches = executeLibraryBranches(runtime, payload, authorized, exploration, sources,
    discovered.descriptors, request, admission.query, original);
  meter.absorb(exploration);
  return deliverLibraryPage(runtime, payload, authorized, meter, request, admission.query_id, admission.query,
    sources, discovered, branches, original, requestIdentity, continuationLease?.continuation);
}

function discoverLibraryDescriptors(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, sources: ReturnType<typeof listEligibleSemanticSources>) {
  const current = new Map(sources.sources.map((row) => [row.source_id, row]));
  const descriptors: SourceSemanticHandleDescriptor[] = [];
  let after: string | null = null, interpretationPages = 0, interpretationOpen = false, interpretationTruncated = false;
  while (interpretationPages < 32) {
    let page: ReturnType<typeof discover>;
    try {
      page = discover(runtime, payload, authorized, meter, after, undefined, false);
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      interpretationOpen = true; interpretationTruncated = true; break;
    }
    interpretationPages += 1;
    descriptors.push(...page.candidates.filter((row) => {
      const source = current.get(row.source_id);
      return source !== undefined && source.source_version === row.source_version && source.content_digest === row.content_digest;
    }));
    interpretationOpen = interpretationOpen || page.open;
    interpretationTruncated = page.truncated;
    if (!page.truncated && !page.open) break;
    if (page.cursor === after || page.cursor === null) { interpretationOpen = true; break; }
    after = page.cursor;
  }
  return { descriptors, interpretationPages, interpretationOpen, interpretationTruncated };
}

function executeLibraryBranches(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  sources: ReturnType<typeof listEligibleSemanticSources>, descriptors: readonly SourceSemanticHandleDescriptor[],
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, query: SourceSemanticQuery, original: string) {
  const current = new Map(sources.sources.map((row) => [row.source_id, row]));
  let interpretationTruncated = false;
  const semantic_correspondences = semanticCorrespondencesByInterpretation(request.semantic_correspondences ?? []);
  const proofGroups: { entries: ReturnType<typeof proofEntriesFromBranch>["entries"];
    explanations: ReturnType<typeof proofEntriesFromBranch>["explanations"] }[] = [];
  const proofs: SourceSemanticLibraryProof[] = [];
  const examined: string[] = [];
  const provedRoots = new Set<string>();
  let pairs = 0, computeOpen = false;
  for (const descriptor of descriptors) {
    const currentSource = current.get(descriptor.source_id);
    if (currentSource === undefined) continue;
    if (descriptor.source_version !== currentSource.source_version
      || descriptor.content_digest !== currentSource.content_digest) continue;
    const prepared = semantic_correspondences.get(descriptor.interpretation_id) ?? [];
    if (prepared.length === 0) continue;
    for (const semantic_correspondence of prepared) {
      if (pairs >= SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP) break;
      pairs += 1;
      if (!examined.includes(descriptor.interpretation_id)) examined.push(descriptor.interpretation_id);
      try {
        const checked = loadVerified(runtime, payload.workspace_id, descriptor.interpretation_id, authorized, meter);
        const remaining = { ...request.budget, ...meter.remaining() };
        if (remaining.work_units < remaining.finalization_reserve + remaining.min_envelope) {
          computeOpen = true; interpretationTruncated = true; break;
        }
        const aligned = admitSourceSemanticCorrespondence({
          semantic_correspondence, source_interpretation: checked.bound.interpretation, query_semantics: query, original_query: original
        });
        if (aligned.kind !== "admitted") continue;
        const executed = executeSourceSemanticInterpretation({
          request: {
            contract: "source-interpretation-reasoning-v4", accepts_unreviewed_conditional_results: true,
            source_interpretation_id: aligned.interpretation_id, query_semantics_id: aligned.query_id, semantic_correspondence_id: aligned.semantic_correspondence_id,
            original_query: original, budget: remaining, output_byte_limit: request.output_byte_limit
          },
          source_interpretation: checked.bound, query_semantics: query, semantic_correspondence: semantic_correspondence, original_query: original,
          workspaceId: payload.workspace_id, scope: checked.stored.record.scope_class!,
          authorizedScopes: authorized, asOf: payload.as_of, sourceValidity: checked.stored.record,
          source_target: checked.bound.source_target
        });
        if (executed.result.resource_usage !== undefined) {
          meter.charge(executed.result.resource_usage.work_units, executed.result.resource_usage.memory_bytes, "library branch");
        }
        if (executed.result.outcome.status === "resource_exhausted") computeOpen = true;
        if (executed.index === null || (executed.result.answers ?? []).length === 0) {
          if (executed.result.outcome.status === "resource_exhausted") { computeOpen = true; }
          continue;
        }
        const scoped = scopeSourceSemanticLibraryBranch(executed.index, executed.result);
        const group = proofEntriesFromBranch(scoped.index, scoped.result);
        if (group.entries.length === 0) continue;
        const proof = { ...scoped.result, original_query: original, source_record: checked.stored.record, interpretation: aligned.interpretation,
          query: aligned.query, semantic_correspondence: aligned.semantic_correspondence, context: aligned.context };
        meter.retain([group, proof], "library branch retention");
        proofGroups.push(group);
        proofs.push(proof);
        for (const entry of group.entries) {
          if (entry.target.kind === "source_evidence") provedRoots.add(sourceGoldRootIdentity(entry.target));
        }
      } catch (error) {
        if (error instanceof SourceSemanticResourceExhausted) { computeOpen = true; break; }
        if (error instanceof CoreError) {
          const admission = admissionOf(error);
          if (admission === "filtered" || admission === "no_eligible_source" || error.code === "NOT_FOUND") continue;
        }
        throw error;
      }
    }
    if (pairs >= SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP) { interpretationTruncated = true; break; }
  }
  return { proofGroups, proofs, examined, provedRoots, pairs, computeOpen, interpretationTruncated };
}

function deliverLibraryPage(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, queryIdentity: string, query: SourceSemanticQuery,
  sources: ReturnType<typeof listEligibleSemanticSources>, discovered: ReturnType<typeof discoverLibraryDescriptors>,
  branches: ReturnType<typeof executeLibraryBranches>, original: string, requestIdentity: string,
  issued: Continuation | undefined): SourceSemanticWorkerResult {
  const { descriptors, interpretationPages, interpretationOpen } = discovered;
  const { proofGroups, proofs, examined, provedRoots, pairs, computeOpen } = branches;
  const interpretationTruncated = discovered.interpretationTruncated || branches.interpretationTruncated;
  const interpretationId = `sha256:${fieldContractSha256(canonicalJson({
    kind: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, query: original, query_semantics_id: queryIdentity, scopes: authorized
  }))}`;
  const queryId = sourceSemanticLibraryQueryIdentity(original);
  const snapshotId = `sha256:${fieldContractSha256(canonicalJson({
    workspace: payload.workspace_id, as_of: payload.as_of, scopes: authorized, revision: sourceSemanticRevision(runtime), requestIdentity,
    sources: sources.sources.map((row) => row.identity), semantic_correspondences: request.semantic_correspondences ?? []
  }))}`;
  const sourceEntries = sources.sources.flatMap((record) => {
    const entry = sourceSemanticLibrarySourceEntry({
      workspaceId: payload.workspace_id, root_id: record.identity, source_version: record.source_version,
      content_digest: record.content_digest, evidence_object_id: record.evidence_object_id,
      hypothesis_id: interpretationId
    });
    if (entry.target.kind !== "source_evidence") return [];
    return provedRoots.has(sourceGoldRootIdentity(entry.target)) ? [] : [entry];
  });
  const openResiduals = sources.open || sources.truncated || interpretationOpen || interpretationTruncated || computeOpen
    || pairs >= SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP;
  const offset = libraryPageOffset(request.continuation, issued, queryId, snapshotId, interpretationId);
  const requestDigest = fieldContractSha256(canonicalJson({
    budget: request.budget, output_byte_limit: request.output_byte_limit,
    cursor: request.continuation?.cursor ?? null
  }));
  const paging = {
    offset, expires_at: issued?.expires_at ?? new Date(Date.parse(sourceSemanticLifetimeNow(payload)) + 5 * 60_000).toISOString(),
    authorized_scopes: authorized
  };
  const assembled = assembleSourceSemanticLibraryIndex({
    query_id: queryId, snapshot_id: snapshotId, interpretation_id: interpretationId, as_of: payload.as_of,
    proof_groups: proofGroups, source_entries: sourceEntries, truncated: openResiduals, open_residuals: openResiduals,
    ...paging
  });
  meter.retain(assembled, "library index assembly");
  const previewBudget = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) });
  const previewed = previewsFor(runtime, payload, authorized, previewBudget, assembled.index);
  meter.absorb(previewBudget);
  const previews = previewed.previews;
  const deliveredProofs = assembled.index.entries.flatMap((entry) => {
    const proof = proofForLibraryEntry(entry, proofs);
    return proof === undefined ? [] : [proof];
  }).filter((proof, index, rows) => rows.findIndex((row) => row.semantic_correspondence_id === proof.semantic_correspondence_id && row.source_interpretation_id === proof.source_interpretation_id) === index);
  const coverage = {
    discovery: openResiduals ? "truncated" as const : "complete" as const,
    source_interpretation: descriptors.length === 0 ? "unexercised" as const : "open" as const,
    query_semantics: query.gaps.length === 0 ? "complete" as const : "open" as const,
    semantic_correspondence: examined.length === 0 ? "unexercised" as const : "open" as const,
    conditional_computation: computeOpen ? "open" as const : deliveredProofs.length > 0 ? "complete" as const : "open" as const,
    payload: previewed.truncated ? "truncated" as const : "complete" as const
  };
  const discovery = {
    eligible_source_count: sources.sources.length, visited_source_pages: sources.pages, visited_source_interpretation_pages: interpretationPages,
    visited_source_interpretation_descriptors: descriptors.length,
    candidate_prefix: descriptors.slice(0, 64).map((row) => row.interpretation_id),
    examined_source_interpretation_ids: examined, unexamined_source_interpretation_count: Math.max(0, descriptors.length - examined.length),
    omitted_duplicate_bindings: assembled.omitted_duplicate_bindings,
    examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
    open_residuals: openResiduals, truncated: openResiduals
  };
  return finalizeLibraryPage(runtime, payload, authorized, meter, request, assembled.index,
    previews, requestDigest, discovery, coverage, deliveredProofs, interpretationId, requestIdentity);
}

function finalizeLibraryPage(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, index: InformationIndex,
  previews: Map<string, string>, requestDigest: string, discovery: SourceSemanticLibraryDiscovery,
  coverage: SourceSemanticCoverage, deliveredProofs: readonly SourceSemanticLibraryProof[],
  interpretationId: string, requestIdentity: string): SourceSemanticWorkerResult {
  const previewRecord = Object.fromEntries(previews);
  const full = libraryRecallResult({
    index: index, requestDigest, discovery, coverage, work: workOf(meter), budget: request.budget,
    proofs: deliveredProofs, previews: previewRecord
  });
  const finish = (result: SourceSemanticWorkerResult): SourceSemanticWorkerResult => {
    if (result.kind !== "recall") throw new CoreError("VALIDATION", "library result kind mismatch");
    const index = SourceSemanticLibraryDeliverySchema.shape.index.parse(
      issueLibraryIndex(runtime, payload, authorized, meter, result.index, requestIdentity));
    meter.retain(encodeSourceSemanticLibraryResponse({ ...result, index }), "library public serialization");
    const final = { ...result, index, work: workOf(meter) };
    if (Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(final))) > request.output_byte_limit) {
      throw new CoreError("VALIDATION", "output budget cannot retain interpretation qualifiers");
    }
    return final;
  };
  if (full.kind === "recall" && Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(full))) <= request.output_byte_limit) return finish(full);
  // Preserve the occupied page and its offset; removing a proof cannot reorder previously exposed roots.
  const demotedIndex = { ...index, entries: sourceOnlyOccupancy(index.entries, payload.workspace_id, interpretationId),
    explanations: [], completeness: { ...index.completeness, payload: "partial" as const,
      explanation_coverage: "not_applicable" as const } };
  const demotedPreviews = Object.fromEntries(demotedIndex.entries.map((entry, offset) =>
    [indexEntryCacheKey(entry), previews.get(indexEntryCacheKey(index.entries[offset]!)) ?? "[payload omitted]"]));
  let limited = libraryRecallResult({
    index: demotedIndex, requestDigest, budget: request.budget,
    discovery: { ...discovery, truncated: true, open_residuals: true },
    coverage: { ...coverage, payload: "truncated", conditional_computation: "open" }, work: workOf(meter),
    proofs: [], previews: demotedPreviews
  });
  if (limited.kind === "recall" && Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(limited))) > request.output_byte_limit) {
    limited = { ...limited, previews: {} };
  }
  return finish(limited);
}

function libraryPageOffset(
  continuation: Continuation | undefined, issued: Continuation | undefined, queryId: string, snapshotId: string, interpretationId: string
): number {
  if (continuation === undefined) return 0;
  if (issued === undefined || issuedContinuationTampered(continuation, issued)
    || continuation.query_id !== queryId || continuation.snapshot_id !== snapshotId
    || continuation.interpretation_id !== interpretationId) {
    throw new CoreError("VALIDATION", "library continuation is invalid");
  }
  const matched = OFFSET_CURSOR.exec(continuation.cursor);
  if (matched === null) throw new CoreError("VALIDATION", "library continuation is invalid");
  return Number(matched[1]);
}

function issueLibraryIndex(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, index: InformationIndex,
  requestIdentity: string): InformationIndex {
  if (index.continuation === null) return index;
  const sealed = sealIssuedContinuation(index.continuation);
  issueSemanticLease(runtime, { kind: "library", workspace_id: payload.workspace_id,
    lifetime_now: sourceSemanticLifetimeNow(payload),
    principal: payload.principal ?? "", as_of: payload.as_of, authorized, expires_at: sealed.expires_at,
    revision: sourceSemanticRevision(runtime), continuation: sealed, request_identity: requestIdentity }, meter, sealed.continuation_id);
  return { ...index, continuation: sealed };
}

function sourceOnlyOccupancy(
  occupied: readonly IndexEntry[], workspaceId: string, hypothesisId: string
): IndexEntry[] {
  return occupied.flatMap((entry) => {
    if (entry.target.kind !== "source_evidence") return [];
    return [sourceSemanticLibrarySourceEntry({
      workspaceId, root_id: entry.target.root_id, source_version: entry.target.source_version,
      content_digest: entry.target.content_digest, evidence_object_id: entry.target.evidence_object_id,
      hypothesis_id: hypothesisId
    })];
  });
}

function libraryRecallResult(input: Readonly<{
  index: InformationIndex; requestDigest: string; discovery: SourceSemanticLibraryDiscovery;
  coverage: SourceSemanticCoverage; work: SourceSemanticWorkerWork;
  proofs: readonly SourceSemanticLibraryProof[]; budget: RequestBudget; previews: Readonly<Record<string, string>>;
}>): SourceSemanticWorkerResult {
  const index = input.index;
  return SourceSemanticWorkerResultSchema.parse({
    kind: "recall", request_budget: input.budget, delivery_id: preparedDeliveryId(input.requestDigest, index), protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
    total_count: index.entries.length, index, page_purpose: "membership", discovery: input.discovery,
    order: SOURCE_SEMANTIC_LIBRARY_ORDER, slot_qualifiers: slotQualifiersFor(index, input.proofs),
    ...(input.proofs.length === 0 ? {} : { proofs: input.proofs }),
    ...(Object.keys(input.previews).length === 0 ? {} : { previews: input.previews }),
    coverage: input.coverage, work: input.work
  });
}

function semanticCorrespondencesByInterpretation(rows: readonly SourceSemanticCorrespondence[]): Map<string, SourceSemanticCorrespondence[]> {
  const mapped = new Map<string, SourceSemanticCorrespondence[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const identity = canonicalJson(row);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const list = mapped.get(row.source_interpretation_id) ?? [];
    list.push(row);
    mapped.set(row.source_interpretation_id, list);
  }
  return mapped;
}

function previewsFor(
  runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget, index: ReturnType<typeof assembleSourceSemanticLibraryIndex>["index"]
): { previews: Map<string, string>; truncated: boolean } {
  const previews = new Map<string, string>();
  let truncated = false;
  for (const entry of index.entries) {
    if (entry.target.kind !== "source_evidence") continue;
    try {
      const stored = sourceSemanticReadStores(
        runtime.database, payload.workspace_id, entry.target.root_id, meter, authorized
      ).getStoredRecord(payload.workspace_id, entry.target.root_id);
      if (stored === null) { truncated = true; continue; }
      if (stored.record.identity !== entry.target.root_id
        || stored.record.source_version !== entry.target.source_version
        || stored.record.content_digest !== entry.target.content_digest) {
        truncated = true; continue;
      }
      if (stored.content_bytes.length === 0) {
        previews.set(indexEntryCacheKey(entry), "[empty source]");
        continue;
      }
      const chunk = hydrateUtf8Chunk(stored.content_bytes, { byteLimit: LIBRARY_PREVIEW_BYTES });
      if (chunk.status !== "chunk") { truncated = true; continue; }
      truncated ||= !chunk.complete;
      previews.set(indexEntryCacheKey(entry), chunk.text);
    } catch (error) {
      if (!(error instanceof CoreError) && !(error instanceof SourceSemanticResourceExhausted)) throw error;
      truncated = true;
    }
  }
  return { previews, truncated };
}
