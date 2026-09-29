import {
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SourceSemanticResourceExhausted, canonicalJson, type AuthorizedScopesAdmission, type RequestBudget, type SourceSemanticQuery,
  type SourceSemanticQueryStatus, type SourceSemanticQueryUnavailableReason, type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import {
  CoreError, admitSourceSemanticQuery, authorizedScopesFromAdmission, encodeSourceSemanticLibraryResponse,
  fieldContractSha256, sourceSemanticLibraryQueryIdentity,
  sourceSemanticLibraryRequestIdentity, sourceSemanticLibrarySourceEntry, sourceSemanticQueryStatus
} from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "./runtime.js";
import {
  bindResearchSourceAccessPool, bindVerifiedResearchSourceRecords, type ResearchSourceObservation
} from "./source-semantic-candidate-access.js";
import { prepareLibraryDelivery, deliverFrozenLibraryPage, type LibraryPageSelector } from "./source-semantic-library-delivery.js";
import { prepareLibraryPackages } from "./source-semantic-library-packages.js";
import { sourceSemanticLifetimeNow, sourceSemanticRevision } from "./source-semantic-leases.js";

export type ResearchOriginalSourcePreviewExtent = Readonly<{
  source_id: string; source_version: string; record_id: string; byte_extent: number }>;
export type ResearchOriginalSourceEvidenceInput = Readonly<{
  workspace_id: string; as_of: string; authorized_scopes: AuthorizedScopesAdmission; original_query: string;
  query_semantics?: SourceSemanticQuery;
  query_semantics_unavailable?: Exclude<SourceSemanticQueryUnavailableReason, "absent">;
  budget: RequestBudget; output_byte_limit: number; observations: readonly ResearchSourceObservation[];
  source_preview_extents?: readonly ResearchOriginalSourcePreviewExtent[];
  proposed_root_ids: readonly string[];
}>;
export type ResearchOriginalSourceEvidenceArm = Readonly<{
  result: Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
  encoded: ReturnType<typeof encodeSourceSemanticLibraryResponse>;
}>;
export type ResearchOriginalSourceEvidenceComparison = Readonly<{
  provenance: "research_original_source_evidence";
  query_semantics_status: SourceSemanticQueryStatus;
  baseline: ResearchOriginalSourceEvidenceArm;
  proposed: ResearchOriginalSourceEvidenceArm;
}>;

type RecallRequest = Extract<Parameters<typeof deliverFrozenLibraryPage>[3], { kind: "recall" }>;

/** Daemon-internal original-source comparison. Not an MCP option; no invented Q or proof success. */
export function compareResearchOriginalSourceEvidence(database: StorageDatabase,
  input: ResearchOriginalSourceEvidenceInput): ResearchOriginalSourceEvidenceComparison {
  if (input.query_semantics !== undefined && input.query_semantics_unavailable !== undefined) {
    throw new CoreError("VALIDATION", "query semantics and an unavailable producer declaration are mutually exclusive");
  }
  const authorized = authorizedScopesFromAdmission(input.authorized_scopes).authorized_scopes;
  if (authorized === undefined) throw new CoreError("VALIDATION", "research original-source comparison requires admitted scopes");
  const admission = admitSourceSemanticQuery(input.query_semantics, input.original_query);
  const queryStatus = sourceSemanticQueryStatus(admission, input.query_semantics_unavailable);
  const query = admission.kind === "admitted" ? admission.query : undefined;
  const request: RecallRequest = {
    kind: "recall", accepts_unreviewed_conditional_results: true, original_query: input.original_query,
    ...(query === undefined ? {} : { query_semantics: query }),
    ...(input.query_semantics_unavailable === undefined ? {} : { query_semantics_unavailable: input.query_semantics_unavailable }),
    semantic_correspondences: [], budget: input.budget, output_byte_limit: input.output_byte_limit,
    access_policy: "query-conditioned-v1"
  };
  const payload = { workspace_id: input.workspace_id, as_of: input.as_of, authorized_scopes: input.authorized_scopes, request };
  const runtime = createRecallReadWorkerRuntime(database);
  const meter = new SourceSemanticReadBudget(input.budget);
  meter.retain(request, "research original-source request admission");
  const records = bindVerifiedResearchSourceRecords(runtime, input.workspace_id, authorized, meter,
    input.observations, input.source_preview_extents);
  const pool = bindResearchSourceAccessPool(runtime, input.workspace_id, authorized, meter, input.original_query, query,
    input.budget, records, input.observations, [], []);
  validateProposedResearchRoots(input.proposed_root_ids, records.map(record => record.identity));
  const requestIdentity = fieldContractSha256(canonicalJson({ ...request, continuation: undefined }));
  const publicRequestIdentity = sourceSemanticLibraryRequestIdentity({
    workspace_id: input.workspace_id, as_of: input.as_of, authorized_scopes: authorized,
    original_query: input.original_query, query_semantics: query, query_semantics_status: queryStatus,
    semantic_correspondences: [], budget: input.budget, output_byte_limit: input.output_byte_limit,
    access_policy: "query-conditioned-v1"
  });
  const interpretationId = `sha256:${fieldContractSha256(canonicalJson({
    kind: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, query: input.original_query, query_semantics_status: queryStatus,
    scopes: authorized
  }))}`;
  const sourceEntries = records.map(record => sourceSemanticLibrarySourceEntry({
    workspaceId: input.workspace_id, root_id: record.identity, source_version: record.source_version,
    content_digest: record.content_digest, evidence_object_id: record.evidence_object_id, hypothesis_id: interpretationId
  }));
  const hydration = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 3), memory_bytes: Math.floor(meter.bytes / 3) });
  let prepared: ReturnType<typeof prepareLibraryPackages>;
  try { prepared = prepareLibraryPackages(runtime, payload, authorized, hydration, sourceEntries, []); }
  finally { meter.absorb(hydration); }
  // A paired comparison requires the same complete frozen preview pool on both arms.
  if (prepared.incomplete) throw new SourceSemanticResourceExhausted("research frozen-pool preparation");
  assertPreparedPreviewExtents(prepared.packages, input.source_preview_extents);
  meter.charge(prepared.packages.length + input.proposed_root_ids.length, prepared.packages.length * 32,
    "research proposed package lookup");
  const packageByRoot = new Map(prepared.packages.map(row => [row.entry.target.kind === "source_evidence"
    ? row.entry.target.root_id : "", row]));
  const proposedPackages = input.proposed_root_ids.map(rootId => {
    const row = packageByRoot.get(rootId);
    if (row === undefined) throw new CoreError("CONFLICT", "proposed source missing from prepared pool");
    return row;
  });
  const snapshotId = `sha256:${fieldContractSha256(canonicalJson({
    workspace: input.workspace_id, as_of: input.as_of, scopes: authorized, revision: sourceSemanticRevision(runtime),
    requestIdentity, sources: records.map(record => record.identity), access_pool: pool.access.pool_id,
    semantic_correspondences: []
  }))}`;
  const base = {
    query_id: sourceSemanticLibraryQueryIdentity(input.original_query), snapshot_id: snapshotId,
    interpretation_id: interpretationId, as_of: input.as_of, authorized, request_identity: requestIdentity,
    public_request_identity: publicRequestIdentity, pool, query_semantics_status: queryStatus, unproved_computations: [],
    expires_at: new Date(Date.parse(sourceSemanticLifetimeNow(payload)) + 5 * 60_000).toISOString(),
    coverage: {
      discovery: "complete" as const,
      source_interpretation: "unexercised" as const,
      query_semantics: query === undefined ? "unexercised" as const : query.gaps.length === 0 ? "complete" as const : "open" as const,
      semantic_correspondence: "unexercised" as const, conditional_computation: "unexercised" as const,
      payload: "complete" as const
    },
    discovery: {
      eligible_source_count: sourceEntries.length, visited_source_pages: pool.sourcePages,
      visited_source_interpretation_pages: pool.interpretationPages, visited_source_interpretation_descriptors: 0,
      candidate_prefix: [], examined_source_interpretation_ids: [], unexamined_source_interpretation_count: 0,
      omitted_duplicate_bindings: 0, examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
      open_residuals: false, truncated: false
    }
  };
  return {
    provenance: "research_original_source_evidence", query_semantics_status: queryStatus,
    baseline: deliverOriginalSourceArm(runtime, payload, request, input.budget, meter, base, prepared.packages, "source_access"),
    proposed: deliverOriginalSourceArm(runtime, payload, request, input.budget, meter, base, proposedPackages, "source_access",
      selectResearchForcedSourceRoots(input.proposed_root_ids))
  };
}

function assertPreparedPreviewExtents(packages: Parameters<typeof prepareLibraryDelivery>[1],
  extents: ResearchOriginalSourceEvidenceInput["source_preview_extents"]): void {
  if (extents === undefined) return;
  const byRoot = new Map(packages.filter(row => row.proofs.length === 0).map(row => [row.entry.target.kind === "source_evidence"
    ? row.entry.target.root_id : "", row]));
  for (const extent of extents) {
    const candidate = byRoot.get(extent.record_id);
    if (candidate === undefined || candidate.entry.target.kind !== "source_evidence"
      || candidate.entry.target.span?.content_start !== 0 || candidate.entry.target.span.content_end !== extent.byte_extent) {
      throw new CoreError("CONFLICT", "native preview differs from the frozen research extent");
    }
  }
}

function validateProposedResearchRoots(rootIds: readonly string[], poolRootIds: readonly string[]): void {
  if (rootIds.length > SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET) {
    throw new CoreError("VALIDATION", "research proposal must supply at most one library page of roots",
      { details: { admission: "bound" } });
  }
  if (new Set(rootIds).size !== rootIds.length) {
    throw new CoreError("VALIDATION", "proposed research roots are not distinct", { details: { admission: "bound" } });
  }
  const pool = new Set(poolRootIds);
  if (rootIds.some(id => !pool.has(id))) {
    throw new CoreError("VALIDATION", "proposed research root is not in the frozen source pool",
      { details: { admission: "bound" } });
  }
}

/**
 * Private forced membership over the shared page-fit owner.
 * Named consumer: compareResearchOriginalSourceEvidence.
 * Do not expose as a product ranking policy.
 */
function selectResearchForcedSourceRoots(rootIds: readonly string[]): LibraryPageSelector {
  return input => {
    const { candidates, fits, meter } = input;
    meter.charge(candidates.length, candidates.length * 16, "research forced source candidates");
    const byRoot = new Map<string, (typeof candidates)[number]>();
    for (const row of candidates) {
      if (row.entry.target.kind !== "source_evidence") continue;
      if (!byRoot.has(row.entry.target.root_id)) byRoot.set(row.entry.target.root_id, row);
    }
    const selected: Array<(typeof candidates)[number]> = [];
    for (const id of rootIds) {
      const candidate = byRoot.get(id);
      if (candidate === undefined) continue;
      const delivered = { ...candidate, selection_basis: "source_access" as const };
      try {
        if (!fits([...selected, delivered])) break;
        selected.push(delivered);
      } catch (error) {
        if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
        break;
      }
    }
    return selected;
  };
}

function deliverOriginalSourceArm(runtime: ReturnType<typeof createRecallReadWorkerRuntime>,
  payload: Parameters<typeof deliverFrozenLibraryPage>[1], request: RecallRequest, budget: RequestBudget,
  preparationMeter: SourceSemanticReadBudget, base: Parameters<typeof prepareLibraryDelivery>[0], packages: Parameters<typeof prepareLibraryDelivery>[1],
  order: "field" | "source_access", selectPage?: LibraryPageSelector): ResearchOriginalSourceEvidenceArm {
  const meter = new SourceSemanticReadBudget(budget);
  meter.absorb(preparationMeter);
  const plan = selectPage === undefined
    ? prepareLibraryDelivery(base, packages, request, meter, order)
    : prepareLibraryDelivery(base, packages, request, meter, order, selectPage);
  const result = deliverFrozenLibraryPage(runtime, payload, meter, request, plan, 0);
  return { result, encoded: encodeSourceSemanticLibraryResponse(result) };
}
