import {
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SourceSemanticResourceExhausted, SourceSemanticLibraryUnprovedComputationSchema, canonicalJson, sourceSemanticExecution,
  type SourceSemanticCorrespondence, type SourceSemanticHandleDescriptor,
  type SourceSemanticLibraryProof, type SourceSemanticLibraryUnprovedComputation, type SourceSemanticWorkerResult, type SourceSemanticQuery, type SourceSemanticQueryStatus,
  type SourceSemanticWorkerRequest
} from "@do-soul/alaya-protocol";
import {
  CoreError, OFFSET_CURSOR, admitSourceSemanticCorrespondence, admitSourceSemanticQuery, sourceSemanticQueryStatus,
  continuationCapabilityMatches, encodeSourceSemanticLibraryResponse, executeSourceSemanticInterpretation,
  fieldContractSha256, proofEntriesFromBranch, selectSourceSemanticLibraryPage,
  sourceSemanticLibrarySourceEntry, sourceSemanticLibraryQueryIdentity, sourceSemanticLibraryRequestIdentity,
  scopeSourceSemanticLibraryBranch, sourceGoldRootIdentity
} from "@do-soul/alaya-core";
import { createRecallReadWorkerRuntime, type RecallReadWorkerRuntime, type SourceSemanticReadRuntime } from "./runtime.js";
import type { SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import { admissionOf, loadVerified, workOf } from "./source-semantic-discovery.js";
import { accessInputIdentity, observeSourceSemanticAccess, type SourceSemanticAccessPool } from "./source-semantic-candidate-access.js";
import { bindResearchFixedSourcePool, type ResearchSourceObservation } from "./source-semantic-research-pool.js";
import {
  listEligibleSemanticSources, SourceSemanticReadBudget
} from "../field/source-semantic-read-stores.js";
import { readSemanticLease, sourceSemanticLifetimeNow, sourceSemanticQueryInputIdentity,
  sourceSemanticRevision } from "./source-semantic-leases.js";

import { prepareLibraryPackages, type LibraryExecutedSupport } from "./source-semantic-library-packages.js";
import { prepareLibraryDelivery, deliverFrozenLibraryPage, type LibraryPageSelector } from "./source-semantic-library-delivery.js";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { authorizedScopesFromAdmission } from "@do-soul/alaya-core";

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
  // Keep a bounded finalization envelope outside exploration and native hydration.
  const exploration = new SourceSemanticReadBudget({
    work_units: Math.max(0, meter.work - Math.min(request.budget.finalization_reserve, Math.floor(meter.work / 4))),
    memory_bytes: meter.bytes - Math.min(Math.floor(meter.bytes / 4), request.output_byte_limit * 8 + 65536)
  });
  let explorationAbsorbed = false;
  try {
  const boundPool = lease?.access_pool;
  const policy = request.access_policy ?? boundPool?.access.policy ?? "query-conditioned-v1";
  const publicRequestIdentity = sourceSemanticLibraryRequestIdentity({
    workspace_id: payload.workspace_id, as_of: payload.as_of, authorized_scopes: authorized,
    original_query: original, query_semantics: admission.kind === "admitted" ? admission.query : undefined,
    query_semantics_status: boundStatus, source_id: lease?.source_id,
    ...(boundPool?.accessHint === undefined ? {} : { access_hint: boundPool.accessHint }),
    semantic_correspondences: request.semantic_correspondences ?? [], budget: request.budget,
    output_byte_limit: request.output_byte_limit, access_policy: policy
  });
  const inputId = accessInputIdentity(original, admission.kind === "admitted" ? admission.query : undefined,
    request.budget, policy, lease?.source_id, boundPool?.sourcePreviewExtents, boundPool?.accessHint);
  if (boundPool !== undefined && boundPool.access.input_id !== inputId) {
    throw new CoreError("VALIDATION", "library access policy or budget changed", { details: { admission: "bound" } });
  }
  if (boundPool !== undefined) exploration.retain(boundPool, "leased access pool");
  const pool = boundPool ?? observeSourceSemanticAccess(runtime, payload, authorized, exploration, original,
    admission.kind === "admitted" ? admission.query : undefined, policy, request.budget, lease?.source_id);
  const sources = { sources: [...pool.sources], pages: pool.sourcePages,
    open: pool.access.unvisited_sources, truncated: pool.access.unvisited_sources };
  const discovered: LibraryDiscovery = { descriptors: pool.descriptors, interpretationPages: pool.interpretationPages,
    interpretationOpen: pool.access.unvisited_interpretations, interpretationTruncated: pool.access.unvisited_interpretations, pool };
  const branches = admission.kind === "admitted"
    ? executeLibraryBranches(runtime, payload, authorized, exploration,
      discovered.descriptors, request, admission.query, original)
    : { proofGroups: [], proofs: [], unproved: [], examined: [], supports: [], pairs: 0,
      executedCount: 0, computeOpen: false, interpretationTruncated: false };
  explorationAbsorbed = true; meter.absorb(exploration);
  return deliverLibraryPage(runtime, payload, authorized, meter, request, boundStatus,
    admission.kind === "admitted" ? admission.query : undefined,
    sources, discovered, branches, original, requestIdentity, publicRequestIdentity);
  } finally { if (!explorationAbsorbed) meter.absorb(exploration); }
}

/** Bench-only fixed-window computation. Its derived pool stays internal and is not an MCP observation. */
export function selectResearchFixedSourceLibrary(database: StorageDatabase,
  payload: SourceSemanticWorkerPayload, rawRows: readonly ResearchSourceObservation[],
  descriptors: readonly SourceSemanticHandleDescriptor[]) {
  const prepared = prepareResearchFixedSourceLibrary({ database }, payload, rawRows, descriptors, true);
  const selected = prepared.plan.pages[0]!.map(row => {
    const target = row.entry.target;
    if (target.kind !== "source_evidence") throw new CoreError("CONFLICT", "research selection lost source target");
    const source = rawRows.find(item => item.record_id === target.root_id);
    if (source === undefined) throw new CoreError("CONFLICT", "research selection escaped fixed ten");
    return { source_id: source.source_id, record_id: source.record_id,
      source_version: source.source_version, content_digest: source.content_digest,
      access_rank: rawRows.indexOf(source) + 1, selection_basis: row.selection_basis,
      payload_support: row.payload_support, preview: row.preview,
      source_disclosure: row.source_disclosure, proofs: row.proofs,
      span: target.span ?? null };
  });
  const rawOrder = prepared.plan.research_raw_order?.map(row => {
    const target = row.entry.target;
    if (target.kind !== "source_evidence") throw new CoreError("CONFLICT", "raw-order control lost source target");
    return { record_id: target.root_id, selection_basis: row.selection_basis,
      payload_support: row.payload_support, proofs: row.proofs };
  }) ?? null;
  return { provenance: "research_fixed_pool" as const, selected, raw_order_control: rawOrder,
    raw_order_control_work: prepared.plan.research_raw_order_work,
    coverage: prepared.plan.coverage, discovery: { ...prepared.plan.discovery, access: undefined },
    examined_source_interpretation_ids: prepared.branches.examined, unproved_computations: prepared.branches.unproved,
    conditional_proofs: prepared.branches.proofs, work: workOf(prepared.meter) };
}

/** Daemon-internal research delivery: same frozen-pool owner, actual page fit, native encoder. */
export function deliverResearchFixedSourceLibrary(database: StorageDatabase,
  payload: SourceSemanticWorkerPayload, rawRows: readonly ResearchSourceObservation[],
  descriptors: readonly SourceSemanticHandleDescriptor[],
  selectPage: LibraryPageSelector = selectSourceSemanticLibraryPage) {
  const runtime = createRecallReadWorkerRuntime(database);
  const prepared = prepareResearchFixedSourceLibrary(runtime, payload, rawRows, descriptors, false, selectPage);
  const result = deliverFrozenLibraryPage(runtime, payload, prepared.meter, prepared.request, prepared.plan, 0);
  return { provenance: "research_fixed_pool" as const, result, encoded: encodeSourceSemanticLibraryResponse(result) };
}

function prepareResearchFixedSourceLibrary(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  rawRows: readonly ResearchSourceObservation[], descriptors: readonly SourceSemanticHandleDescriptor[],
  researchRawOrder = false, selectPage: LibraryPageSelector = selectSourceSemanticLibraryPage) {
  const request = payload.request;
  if (request.kind !== "recall" || request.query_handle !== undefined || request.continuation !== undefined ||
      request.original_query === undefined || request.query_semantics === undefined ||
      request.access_policy !== "query-conditioned-v1") {
    throw new CoreError("VALIDATION", "fixed-window research requires direct admitted Q and one recall request");
  }
  const authorized = authorizedScopesFromAdmission(payload.authorized_scopes).authorized_scopes;
  if (authorized === undefined) throw new CoreError("VALIDATION", "research fixed window requires admitted scopes");
  const admission = admitSourceSemanticQuery(request.query_semantics, request.original_query);
  if (admission.kind !== "admitted") throw new CoreError("VALIDATION", "research fixed window requires admitted Q");
  const meter = new SourceSemanticReadBudget(request.budget);
  meter.retain(request, "research fixed-window request admission");
  const pool = bindResearchFixedSourcePool(runtime, payload.workspace_id, authorized, meter,
    request.original_query, admission.query, request.budget, rawRows, descriptors);
  const discovered: LibraryDiscovery = { descriptors: pool.descriptors, interpretationPages: pool.interpretationPages,
    interpretationOpen: false, interpretationTruncated: false, pool };
  const branches = executeLibraryBranches(runtime, payload, authorized, meter, pool.descriptors,
    request, admission.query, request.original_query);
  const requestIdentity = fieldContractSha256(canonicalJson({ ...request, continuation: undefined }));
  const queryStatus = sourceSemanticQueryStatus(admission);
  const publicRequestIdentity = sourceSemanticLibraryRequestIdentity({
    workspace_id: payload.workspace_id, as_of: payload.as_of, authorized_scopes: authorized,
    original_query: request.original_query, query_semantics: admission.query,
    query_semantics_status: queryStatus, semantic_correspondences: request.semantic_correspondences ?? [],
    budget: request.budget, output_byte_limit: request.output_byte_limit, access_policy: request.access_policy
  });
  const plan = prepareLibraryPlan(runtime, payload, authorized, meter, request, queryStatus,
    admission.query, { sources: [...pool.sources], pages: pool.sourcePages, open: false, truncated: false },
    discovered, branches, request.original_query, requestIdentity, publicRequestIdentity, researchRawOrder, selectPage);
  return { request, meter, plan, branches };
}

export function executeLibraryBranches(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
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

function deliverLibraryPage(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, queryStatus: SourceSemanticQueryStatus,
  query: SourceSemanticQuery | undefined,
  sources: Pick<ReturnType<typeof listEligibleSemanticSources>, "sources" | "pages" | "open" | "truncated">, discovered: LibraryDiscovery,
  branches: ReturnType<typeof executeLibraryBranches>, original: string, requestIdentity: string,
  publicRequestIdentity: string): SourceSemanticWorkerResult {
  const plan = prepareLibraryPlan(runtime, payload, authorized, meter, request, queryStatus,
    query, sources, discovered, branches, original, requestIdentity, publicRequestIdentity);
  return deliverFrozenLibraryPage(runtime, payload, meter, request, plan, 0);
}

function prepareLibraryPlan(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, queryStatus: SourceSemanticQueryStatus,
  query: SourceSemanticQuery | undefined,
  sources: Pick<ReturnType<typeof listEligibleSemanticSources>, "sources" | "pages" | "open" | "truncated">, discovered: LibraryDiscovery,
  branches: ReturnType<typeof executeLibraryBranches>, original: string, requestIdentity: string,
  publicRequestIdentity: string, researchRawOrder = false,
  selectPage: LibraryPageSelector = selectSourceSemanticLibraryPage) {
  const prepared = prepareSourceSemanticLibraryInputs(runtime, payload, authorized, meter, request, queryStatus,
    query, sources, discovered, branches, original, requestIdentity, publicRequestIdentity);
  const selection = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) });
  const plan = prepareLibraryDelivery(prepared.base, prepared.packages, request, selection, "field", selectPage, prepared.execution);
  const rawOrderSelection = researchRawOrder ? new SourceSemanticReadBudget({
    work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) }) : null;
  const rawOrder = rawOrderSelection === null ? null : prepareLibraryDelivery(prepared.base,
    prepared.packages, request, rawOrderSelection, "source_access", selectSourceSemanticLibraryPage, prepared.execution);
  meter.absorb(selection);
  return { ...plan, research_raw_order: rawOrder?.pages[0] ?? null,
    research_raw_order_work: rawOrderSelection === null ? null : workOf(rawOrderSelection) };
}

/** Shared package/base owner. Private comparisons capture these inputs, not another recall engine. */
export function prepareSourceSemanticLibraryInputs(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }>, queryStatus: SourceSemanticQueryStatus,
  query: SourceSemanticQuery | undefined,
  sources: Pick<ReturnType<typeof listEligibleSemanticSources>, "sources" | "pages" | "open" | "truncated">, discovered: LibraryDiscovery,
  branches: ReturnType<typeof executeLibraryBranches>, original: string, requestIdentity: string,
  publicRequestIdentity: string, researchNominations?: Parameters<typeof prepareLibraryPackages>[6]) {
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
  const hydration = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 3), memory_bytes: Math.floor(meter.bytes / 3) });
  let prepared: ReturnType<typeof prepareLibraryPackages>;
  try { prepared = prepareLibraryPackages(runtime, payload, authorized, hydration, sourceEntries, branches.supports, researchNominations); }
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
