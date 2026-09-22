import {
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SourceSemanticResourceExhausted, canonicalJson,
  type SourceSemanticCorrespondence, type SourceSemanticHandleDescriptor,
  type SourceSemanticLibraryProof, type SourceSemanticWorkerResult, type SourceSemanticQuery, type SourceSemanticWorkerRequest
} from "@do-soul/alaya-protocol";
import {
  CoreError, OFFSET_CURSOR, admitSourceSemanticCorrespondence, admitSourceSemanticQuery,
  continuationCapabilityMatches, executeSourceSemanticInterpretation,
  fieldContractSha256, proofEntriesFromBranch,
  sourceSemanticLibrarySourceEntry, sourceSemanticLibraryQueryIdentity, sourceSemanticLibraryRequestIdentity,
  scopeSourceSemanticLibraryBranch, sourceGoldRootIdentity
} from "@do-soul/alaya-core";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import type { SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import { admissionOf, loadVerified } from "./source-semantic-discovery.js";
import { accessInputIdentity, observeSourceSemanticAccess, type SourceSemanticAccessPool } from "./source-semantic-candidate-access.js";
import {
  listEligibleSemanticSources, SourceSemanticReadBudget
} from "../field/source-semantic-read-stores.js";
import { readSemanticLease, sourceSemanticLifetimeNow, sourceSemanticRevision } from "./source-semantic-leases.js";

import { prepareLibraryPackages, type LibraryExecutedSupport } from "./source-semantic-library-packages.js";
import { prepareLibraryDelivery, deliverFrozenLibraryPage } from "./source-semantic-library-delivery.js";

type LibraryDiscovery = Readonly<{ descriptors: readonly SourceSemanticHandleDescriptor[];
  interpretationPages: number; interpretationOpen: boolean; interpretationTruncated: boolean; pool: SourceSemanticAccessPool }>;

/** Provider-free library recall: one query/scope, independent conditional computation, bounded evidence delivery. */
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
  if (continuationLease !== undefined) {
    const plan = continuationLease.library_plan;
    const offset = OFFSET_CURSOR.exec(request.continuation!.cursor);
    if (plan === undefined || offset === null) throw new CoreError("VALIDATION", "library continuation has no frozen membership");
    return deliverFrozenLibraryPage(runtime, payload, meter, request, plan, Number(offset[1]));
  }
  const currentClock = payload.as_of;
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
  const boundPool = lease?.access_pool;
  const policy = request.access_policy ?? boundPool?.access.policy ?? "query-conditioned-v1";
  const publicRequestIdentity = sourceSemanticLibraryRequestIdentity({
    workspace_id: payload.workspace_id, as_of: payload.as_of, authorized_scopes: authorized,
    original_query: original, query_semantics: admission.query, source_id: lease?.source_id,
    semantic_correspondences: request.semantic_correspondences ?? [], budget: request.budget,
    output_byte_limit: request.output_byte_limit, access_policy: policy
  });
  const inputId = accessInputIdentity(original, admission.query, request.budget, policy, lease?.source_id);
  if (boundPool !== undefined && boundPool.access.input_id !== inputId) {
    throw new CoreError("VALIDATION", "library access policy or budget changed", { details: { admission: "bound" } });
  }
  if (boundPool !== undefined) exploration.retain(boundPool, "leased access pool");
  const pool = boundPool ?? observeSourceSemanticAccess(runtime, payload, authorized, exploration, original,
    admission.query, policy, request.budget, lease?.source_id);
  const sources = { sources: [...pool.sources], pages: pool.sourcePages,
    open: pool.access.unvisited_sources, truncated: pool.access.unvisited_sources };
  const discovered: LibraryDiscovery = { descriptors: pool.descriptors, interpretationPages: pool.interpretationPages,
    interpretationOpen: pool.access.unvisited_interpretations, interpretationTruncated: pool.access.unvisited_interpretations, pool };
  const branches = executeLibraryBranches(runtime, payload, authorized, exploration,
    discovered.descriptors, request, admission.query, original);
  meter.absorb(exploration);
  return deliverLibraryPage(runtime, payload, authorized, meter, request, admission.query_id, admission.query,
    sources, discovered, branches, original, requestIdentity, publicRequestIdentity);
}

function executeLibraryBranches(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  descriptors: readonly SourceSemanticHandleDescriptor[],
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, query: SourceSemanticQuery, original: string) {
  let interpretationTruncated = false;
  const semantic_correspondences = semanticCorrespondencesByInterpretation(request.semantic_correspondences ?? []);
  const proofGroups: { entries: ReturnType<typeof proofEntriesFromBranch>["entries"];
    explanations: ReturnType<typeof proofEntriesFromBranch>["explanations"] }[] = [];
  const proofs: SourceSemanticLibraryProof[] = [];
  const examined: string[] = [];
  const supports: LibraryExecutedSupport[] = [];
  let pairs = 0, computeOpen = false;
  for (const descriptor of descriptors) {
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
            contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
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
        if (executed.index === null || (executed.result.binding_results ?? []).length === 0) {
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
        supports.push({ proof, group, source: checked.stored.content_bytes, dependencies: executed.source_dependencies ?? [] });
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
  return { proofGroups, proofs, examined, supports, pairs, computeOpen, interpretationTruncated };
}

function deliverLibraryPage(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, queryIdentity: string, query: SourceSemanticQuery,
  sources: Pick<ReturnType<typeof listEligibleSemanticSources>, "sources" | "pages" | "open" | "truncated">, discovered: LibraryDiscovery,
  branches: ReturnType<typeof executeLibraryBranches>, original: string, requestIdentity: string,
  publicRequestIdentity: string): SourceSemanticWorkerResult {
  const { descriptors, interpretationPages, interpretationOpen } = discovered;
  const { proofGroups, examined, pairs, computeOpen } = branches;
  const interpretationTruncated = discovered.interpretationTruncated || branches.interpretationTruncated;
  const interpretationId = `sha256:${fieldContractSha256(canonicalJson({
    kind: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, query: original, query_semantics_id: queryIdentity, scopes: authorized
  }))}`;
  const snapshotId = `sha256:${fieldContractSha256(canonicalJson({
    workspace: payload.workspace_id, as_of: payload.as_of, scopes: authorized, revision: sourceSemanticRevision(runtime), requestIdentity,
    sources: sources.sources.map((row) => row.identity), access_pool: discovered.pool.access.pool_id,
    semantic_correspondences: request.semantic_correspondences ?? []
  }))}`;
  const sourceEntries = sources.sources.map(record => sourceSemanticLibrarySourceEntry({
    workspaceId: payload.workspace_id, root_id: record.identity, source_version: record.source_version,
    content_digest: record.content_digest, evidence_object_id: record.evidence_object_id, hypothesis_id: interpretationId
  }));
  // Interpretation discovery can verify a current root beyond the bounded source
  // catalog prefix. Its actually executed support remains an eligible candidate.
  const sourceRoots = new Set(sourceEntries.map(entry => entry.target.kind === "source_evidence" ? sourceGoldRootIdentity(entry.target) : ""));
  for (const { proof } of branches.supports) {
    const target = proof.source_target;
    if (target === undefined || sourceRoots.has(sourceGoldRootIdentity(target))) continue;
    sourceRoots.add(sourceGoldRootIdentity(target));
    sourceEntries.push(sourceSemanticLibrarySourceEntry({ workspaceId: target.workspace_id, root_id: target.root_id,
      source_version: target.source_version, content_digest: target.content_digest, evidence_object_id: target.evidence_object_id,
      hypothesis_id: interpretationId }));
  }
  const openResiduals = sources.open || sources.truncated || interpretationOpen || interpretationTruncated || computeOpen
    || pairs >= SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP;
  const hydration = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 3), memory_bytes: Math.floor(meter.bytes / 3) });
  const prepared = prepareLibraryPackages(runtime, payload, authorized, hydration, sourceEntries, branches.supports);
  meter.absorb(hydration);
  const selection = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) });
  const plan = prepareLibraryDelivery({
    query_id: sourceSemanticLibraryQueryIdentity(original), snapshot_id: snapshotId, interpretation_id: interpretationId,
    as_of: payload.as_of, authorized, request_identity: requestIdentity, public_request_identity: publicRequestIdentity, pool: discovered.pool,
    expires_at: new Date(Date.parse(sourceSemanticLifetimeNow(payload)) + 5 * 60_000).toISOString(),
    coverage: {
      discovery: openResiduals ? "truncated" : "complete",
      source_interpretation: descriptors.length === 0 ? "unexercised" : "open",
      query_semantics: query.gaps.length === 0 ? "complete" : "open",
      semantic_correspondence: examined.length === 0 ? "unexercised" : "open",
      conditional_computation: computeOpen ? "open" : "complete", payload: prepared.incomplete ? "truncated" : "complete"
    },
    discovery: {
      eligible_source_count: sourceEntries.length, visited_source_pages: sources.pages, visited_source_interpretation_pages: interpretationPages,
      visited_source_interpretation_descriptors: descriptors.length,
      candidate_prefix: descriptors.slice(0, 64).map(row => row.interpretation_id), examined_source_interpretation_ids: examined,
      unexamined_source_interpretation_count: Math.max(0, descriptors.length - examined.length),
      omitted_duplicate_bindings: proofGroups.reduce((sum, group) => sum + group.entries.length, 0)
        - new Set(proofGroups.flatMap(group => group.entries.flatMap(entry => entry.target.kind === "source_evidence"
          ? [sourceGoldRootIdentity(entry.target)] : []))).size,
      examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
      open_residuals: openResiduals || prepared.incomplete, truncated: openResiduals || prepared.incomplete
    }
  }, prepared.packages, request, selection);
  meter.absorb(selection);
  return deliverFrozenLibraryPage(runtime, payload, meter, request, plan, 0);
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
