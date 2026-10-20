import {
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SourceSemanticResourceExhausted, SourceSemanticLibraryUnprovedComputationSchema, canonicalJson, sourceSemanticExecution,
  type SourceSemanticCorrespondence, type SourceSemanticHandleDescriptor,
  type SourceSemanticLibraryProof, type SourceSemanticLibraryUnprovedComputation, type SourceSemanticWorkerResult, type SourceSemanticQuery, type SourceSemanticQueryStatus,
  type SourceSemanticWorkerRequest
} from "@do-soul/alaya-protocol";
import {
  CoreError, OFFSET_CURSOR, admitSourceSemanticCorrespondence, admitSourceSemanticQuery, sourceSemanticQueryStatus,
  continuationCapabilityMatches, executeSourceSemanticInterpretation,
  fieldContractSha256, proofEntriesFromBranch, selectSourceSemanticLibraryPage,
  sourceSemanticLibrarySourceEntry, sourceSemanticLibraryQueryIdentity, sourceSemanticLibraryRequestIdentity,
  scopeSourceSemanticLibraryBranch, sourceGoldRootIdentity
} from "@do-soul/alaya-core";
import type { RecallReadWorkerRuntime, SourceSemanticReadRuntime } from "./runtime.js";
import type { SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import { admissionOf, loadVerified } from "./source-semantic-discovery.js";
import { accessInputIdentity, observeSourceSemanticAccess, type SourceSemanticAccessPool } from "./source-semantic-candidate-access.js";
import { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { listEligibleSemanticSources } from "./source-recall-catalog.js";
import { readSemanticLease, sourceSemanticLifetimeNow, sourceSemanticQueryInputIdentity,
  sourceSemanticRevision } from "./source-semantic-leases.js";

import { prepareLibraryPackages, type LibraryExecutedSupport } from "./source-semantic-library-packages.js";
import { prepareLibraryDelivery, deliverFrozenLibraryPage, type LibraryDeliveryPlan } from "./source-semantic-library-delivery.js";
import { runSourceRecall, sourceRecallPhaseAllowance } from "./source-recall.js";

type LibraryDiscovery = Readonly<{ descriptors: readonly SourceSemanticHandleDescriptor[];
  interpretationPages: number; interpretationOpen: boolean; interpretationTruncated: boolean; pool: SourceSemanticAccessPool }>;

/** Native library computation over one prepared query/scope and its bounded shared access pool. */
export function runSourceSemanticLibraryRecall(
  runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget
): SourceSemanticWorkerResult {
  const request = payload.request;
  if (request.kind !== "recall") throw new CoreError("VALIDATION", "recall kind mismatch");
  meter.retain(request, "library request admission");
  const requestIdentity = fieldContractSha256(canonicalJson({ ...request, continuation: undefined }));
  const continuationLease = request.continuation === undefined ? undefined
    : readSemanticLease(runtime, payload, request.continuation.continuation_id, authorized, "library", meter);
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
  const lease = request.query_handle === undefined ? undefined : readSemanticLease(runtime, { ...payload, as_of: currentClock }, request.query_handle, authorized, "query", meter);
  if (lease !== undefined && (request.original_query !== undefined && request.original_query !== lease.original_query
    || request.query_semantics !== undefined && sourceSemanticQueryInputIdentity(request.query_semantics) !== lease.query_semantics_input_id
    || request.query_semantics_unavailable !== undefined && (lease.query_semantics_status?.status !== "unavailable"
      || lease.query_semantics_status.reason !== request.query_semantics_unavailable))) {
    throw new CoreError("VALIDATION", "query handle cannot be retargeted", { details: { admission: "bound" } });
  }
  const original = lease?.original_query ?? request.original_query;
  const querySemantics = lease?.query_semantics ?? request.query_semantics;
  if (original === undefined) throw new CoreError("VALIDATION", "recall lacks its original question");
  if (lease !== undefined) {
    meter.retain(lease.query_semantics_status, "leased query semantics status");
    if (querySemantics !== undefined) meter.retain(querySemantics, "leased query semantics admission");
  }
  const admission = admitSourceSemanticQuery(querySemantics, original);
  const queryStatus = sourceSemanticQueryStatus(admission, request.query_semantics_unavailable);
  if (lease !== undefined && canonicalJson(lease.query_semantics_status) !== canonicalJson(queryStatus)
    && request.query_semantics_unavailable === undefined) {
    // The lease may carry a producer failure that has no semantic object to re-admit.
    if (admission.kind !== "absent" || lease.query_semantics_status?.status !== "unavailable") {
      throw new CoreError("VALIDATION", "query handle semantic admission changed", { details: { admission: "bound" } });
    }
  }
  const boundStatus = lease?.query_semantics_status ?? queryStatus;
  return recallAdmittedLibrary(runtime, payload, authorized, meter, request, lease,
    admission.kind === "admitted" ? admission.query : undefined, boundStatus, original, requestIdentity);
}

function recallAdmittedLibrary(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, lease: ReturnType<typeof readSemanticLease> | undefined,
  query: SourceSemanticQuery | undefined, boundStatus: SourceSemanticQueryStatus, original: string, requestIdentity: string) {
  const boundPool = lease?.access_pool;
  const policy = request.access_policy ?? boundPool?.access.policy ?? "query-conditioned-v1";
  let publicRequestIdentity: string;
  let exploration: SourceSemanticReadBudget | undefined;
  let pool: SourceSemanticAccessPool, sources: Pick<ReturnType<typeof listEligibleSemanticSources>, "sources" | "pages" | "open" | "truncated">;
  let discovered: LibraryDiscovery, branches: ReturnType<typeof executeLibraryBranches>, plan: LibraryDeliveryPlan;
  let result: SourceSemanticWorkerResult | undefined;
  runSourceRecall(meter, request.budget.finalization_reserve, request.output_byte_limit, {
    observe: allowance => {
      exploration = meter.child(allowance, "exploration");
      publicRequestIdentity = sourceSemanticLibraryRequestIdentity({
        workspace_id: payload.workspace_id, as_of: payload.as_of, authorized_scopes: authorized,
        original_query: original, query_semantics: query,
        query_semantics_status: boundStatus, source_id: lease?.source_id,
        ...(boundPool?.accessHint === undefined ? {} : { access_hint: boundPool.accessHint }),
        semantic_correspondences: request.semantic_correspondences ?? [], budget: request.budget,
        output_byte_limit: request.output_byte_limit, access_policy: policy
      });
      const inputId = accessInputIdentity(original, query,
        request.budget, policy, lease?.source_id, boundPool?.sourcePreviewExtents, boundPool?.accessHint);
      if (boundPool !== undefined && boundPool.access.input_id !== inputId) {
        throw new CoreError("VALIDATION", "library access policy or budget changed", { details: { admission: "bound" } });
      }
      if (boundPool !== undefined) {
        exploration.retain(boundPool, "leased access pool");
        meter.observer?.event("pool_reuse", meter.phase, () => ({ pool_id: boundPool.access.pool_id, discovery: "not_observed_this_request" }));
        meter.observer?.facts.pool(boundPool, boundPool.access.pool_id, boundPool.sources,
          boundPool.access.unvisited_sources, boundPool.access.unvisited_interpretations, "reused");
      }
      pool = boundPool ?? observeSourceSemanticAccess(runtime, payload, authorized, exploration, original,
        query, policy, request.budget, lease?.source_id);
      sources = { sources: [...pool.sources], pages: pool.sourcePages,
        open: pool.access.unvisited_sources, truncated: pool.access.unvisited_sources };
      discovered = { descriptors: pool.descriptors, interpretationPages: pool.interpretationPages,
        interpretationOpen: pool.access.unvisited_interpretations, interpretationTruncated: pool.access.unvisited_interpretations, pool };
    },
    compute: () => {
      branches = query === undefined
        ? { proofGroups: [], proofs: [], unproved: [], examined: [], supports: [], pairs: 0,
          executedCount: 0, computeOpen: false, interpretationTruncated: false }
        : executeLibraryBranches(runtime, payload, authorized, exploration!, discovered.descriptors, request, query, original);
    },
    absorbExploration: () => { if (exploration !== undefined) meter.absorb(exploration); },
    finalize: () => { plan = prepareLibraryPlan(runtime, payload, authorized, meter, request, boundStatus,
      query, sources, discovered, branches, original, requestIdentity, publicRequestIdentity); },
    deliver: () => { result = deliverFrozenLibraryPage(runtime, payload, meter, request, plan, 0); }
  });
  if (result === undefined) throw new CoreError("OBLIGATION_VIOLATION", "source recall did not deliver its finalized plan");
  return result;
}

function executeLibraryBranches(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  descriptors: readonly SourceSemanticHandleDescriptor[],
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, query: SourceSemanticQuery, original: string) {
  let interpretationTruncated = false;
  const semantic_correspondences = semanticCorrespondencesByInterpretation(request.semantic_correspondences ?? []);
  const proofGroups: { entries: ReturnType<typeof proofEntriesFromBranch>["entries"];
    explanations: ReturnType<typeof proofEntriesFromBranch>["explanations"] }[] = [];
  const proofs: SourceSemanticLibraryProof[] = [];
  const unproved: SourceSemanticLibraryUnprovedComputation[] = [];
  const examined: string[] = [];
  const supports: LibraryExecutedSupport[] = [];
  let pairs = 0, executedCount = 0, computeOpen = false;
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
        if (aligned.kind !== "admitted") { computeOpen = true; continue; }
        const executed = executeSourceSemanticInterpretation({
          computation: {
            contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
            source_interpretation_id: aligned.interpretation_id, query_semantics_id: aligned.query_id, semantic_correspondence_id: aligned.semantic_correspondence_id,
            original_query: original, budget: remaining
          },
          source_interpretation: checked.bound, query_semantics: query, semantic_correspondence: semantic_correspondence, original_query: original,
          workspaceId: payload.workspace_id, scope: checked.stored.record.scope_class!,
          authorizedScopes: authorized, asOf: payload.as_of, sourceValidity: checked.stored.record,
          source_target: checked.bound.source_target
        });
        executedCount += 1;
        if (executed.result.resource_usage !== undefined) {
          meter.charge(executed.result.resource_usage.work_units, executed.result.resource_usage.memory_bytes, "library branch");
        }
        if (executed.result.outcome.status === "resource_exhausted"
          || executed.result.completeness?.logical_index !== "complete") computeOpen = true;
        if ((executed.result.binding_results ?? []).length === 0) {
          if (executed.result.outcome.status === "interpreted" && executed.result.completeness?.logical_index === "complete") {
            meter.charge(1, 0, "library unproved computation projection");
            const control = SourceSemanticLibraryUnprovedComputationSchema.parse({
              kind: "complete_zero_binding", conclusion_scope: executed.result.conclusion_scope,
              world_claim: executed.result.world_claim,
              source_record: { workspace_id: checked.stored.record.workspace_id,
                source_id: checked.stored.record.source_id, identity: checked.stored.record.identity,
                source_version: checked.stored.record.source_version, content_digest: checked.stored.record.content_digest,
                ...(checked.stored.record.source_representation === undefined ? {} : {
                  source_representation: checked.stored.record.source_representation
                }) },
              source_interpretation_id: aligned.interpretation_id,
              query_semantics_id: aligned.query_id, semantic_correspondence_id: aligned.semantic_correspondence_id,
              conditional_computation_id: executed.result.conditional_computation_id,
              completeness: executed.result.completeness, attention: executed.result.attention
            });
            meter.retain(control, "library unproved computation");
            unproved.push(control);
          }
          continue;
        }
        if (executed.index === null) { computeOpen = true; continue; }
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
    if (pairs >= SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP) break;
  }
  return { proofGroups, proofs, unproved, examined, supports, pairs, executedCount, computeOpen, interpretationTruncated };
}

function prepareLibraryPlan(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, queryStatus: SourceSemanticQueryStatus,
  query: SourceSemanticQuery | undefined,
  sources: Pick<ReturnType<typeof listEligibleSemanticSources>, "sources" | "pages" | "open" | "truncated">, discovered: LibraryDiscovery,
  branches: ReturnType<typeof executeLibraryBranches>, original: string, requestIdentity: string,
  publicRequestIdentity: string) {
  const prepared = prepareSourceSemanticLibraryInputs(runtime, payload, authorized, meter, request, queryStatus,
    query, sources, discovered, branches, original, requestIdentity, publicRequestIdentity);
  const selection = meter.child(sourceRecallPhaseAllowance(meter, "selection"), "selection");
  return prepareLibraryDelivery(prepared.base, prepared.packages, request, meter, "field",
    selectSourceSemanticLibraryPage, prepared.execution, selection);
}

function prepareSourceSemanticLibraryInputs(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, queryStatus: SourceSemanticQueryStatus,
  query: SourceSemanticQuery | undefined,
  sources: Pick<ReturnType<typeof listEligibleSemanticSources>, "sources" | "pages" | "open" | "truncated">, discovered: LibraryDiscovery,
  branches: ReturnType<typeof executeLibraryBranches>, original: string, requestIdentity: string,
  publicRequestIdentity: string) {
  const { descriptors, interpretationPages, interpretationOpen } = discovered;
  const { proofGroups, examined, computeOpen } = branches;
  const interpretationTruncated = discovered.interpretationTruncated || branches.interpretationTruncated;
  const interpretationId = `sha256:${fieldContractSha256(canonicalJson({
    kind: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, query: original, query_semantics_status: queryStatus, scopes: authorized
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
  const openResiduals = sources.open || sources.truncated || interpretationOpen || interpretationTruncated || computeOpen;
  const hydration = meter.child(sourceRecallPhaseAllowance(meter, "package_hydration"), "package_hydration");
  let prepared: ReturnType<typeof prepareLibraryPackages>;
  try { prepared = prepareLibraryPackages(runtime, payload, authorized, hydration, sourceEntries, branches.supports); }
  finally { meter.absorb(hydration); }
  // Selection has no acquisition phase of its own; capture current execution
  // from the parent after observation, not from the pool's frozen provenance.
  const execution = sourceSemanticExecution(meter.preparation, meter.acquisition, meter);
  const base: Parameters<typeof prepareLibraryDelivery>[0] = {
    query_id: sourceSemanticLibraryQueryIdentity(original), snapshot_id: snapshotId, interpretation_id: interpretationId,
    as_of: payload.as_of, authorized, request_identity: requestIdentity, public_request_identity: publicRequestIdentity, pool: discovered.pool,
    query_semantics_status: queryStatus,
    unproved_computations: branches.unproved,
    expires_at: new Date(Date.parse(sourceSemanticLifetimeNow(payload)) + 5 * 60_000).toISOString(),
    coverage: {
      discovery: openResiduals ? "truncated" : "complete",
      source_interpretation: descriptors.length === 0 ? "unexercised" : "open",
      query_semantics: query === undefined ? "unexercised" : query.gaps.length === 0 ? "complete" : "open",
      semantic_correspondence: examined.length === 0 ? "unexercised" : "open",
      conditional_computation: queryStatus.status === "unavailable" ? "unexercised"
        : computeOpen ? "open" : branches.executedCount === 0 ? "unexercised" : "complete",
      payload: prepared.incomplete ? "truncated" : "complete"
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
  };
  return { base, packages: prepared.packages, incomplete: prepared.incomplete, execution };
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
