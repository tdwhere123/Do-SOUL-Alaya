import { canonicalJson, sourceSemanticAccessPhases, SourceSemanticResourceExhausted,
  type SourceSemanticAcquisitionPhase } from "@do-soul/alaya-protocol";
import { CoreError, admitSourceSemanticQuery, authorizedScopesFromAdmission, encodeSourceSemanticLibraryResponse,
  fieldContractSha256, selectSourceSemanticLibraryPage, sourceGoldRootIdentity,
  sourceSemanticLibraryRequestIdentity, sourceSemanticQueryStatus, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "./runtime.js";
import type { SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import { accessInputIdentity, bindAccessPoolIdentity, type SourceSemanticAccessPool } from "./source-semantic-candidate-access.js";
import { bindVerifiedResearchSourceRecords } from "./source-semantic-research-pool.js";
import { executeLibraryBranches, prepareSourceSemanticLibraryInputs } from "./source-semantic-library-recall.js";
import { deliverFrozenLibraryPage, prepareLibraryDelivery, type LibraryPageSelector } from "./source-semantic-library-delivery.js";

type Proposal = Readonly<{ root: string; position: number; provenance: "primary" | "supplemental" | "legacy-access remainder" }>;
type Prepared = ReturnType<typeof prepareSourceSemanticLibraryInputs>;
type Runtime = ReturnType<typeof createRecallReadWorkerRuntime>;
type Request = Extract<SourceSemanticWorkerPayload["request"], { kind: "recall" }>;

/**
 * Named caller: compareResearchNominatedSourceLibrary's private controlled comparison.
 * Remove if it has no reproducible utility or distinct policy answer versus the simpler
 * access-order ablation; retire on reviewed public promotion. No product ranking option.
 */
export function projectResearchNativeProposals(candidates: readonly SourceSemanticLibraryPackage[],
  acquisition: SourceSemanticAcquisitionPhase, meter: SourceSemanticReadBudget) {
  const roots = new Set<string>();
  const proposals: Proposal[] = [];
  const eligible = new Set(candidates.map(row => packageRoot(row)));
  meter.charge(candidates.length, candidates.length * 32, "research proposal root census");
  const append = (root: string, provenance: Proposal["provenance"]) => {
    meter.charge(1, 0, "research root proposal check");
    if (!eligible.has(root) || roots.has(root)) return;
    meter.charge(1, 128 + root.length * 2, "research root proposal retention");
    roots.add(root); proposals.push({ root, position: proposals.length, provenance });
  };
  for (const [phase, provenance] of [[acquisition, "primary"],
    ...(acquisition.supplemental ?? []).map(phase => [phase, "supplemental"] as const)] as const) {
    for (const nomination of phase.result?.nominations ?? []) {
      if (nomination.source.root_key !== sourceGoldRootIdentity(nomination.source.target)) {
        throw new CoreError("CONFLICT", "native proposal root key does not match its target");
      }
      append(nomination.source.root_key, provenance);
    }
  }
  meter.charge(candidates.length * Math.max(1, Math.ceil(Math.log2(candidates.length))), candidates.length * 8,
    "research legacy access order");
  for (const row of [...candidates].sort((a, b) => a.access_position - b.access_position)) {
    append(packageRoot(row), "legacy-access remainder");
  }
  return proposals;
}

/** Ordering projection only: the existing selector still owns variants, root occupancy and fit. */
export function researchNativeProposalSelector(proposals: readonly Proposal[]): LibraryPageSelector {
  const positions = new Map(proposals.map(row => [row.root, row.position]));
  return input => {
    input.meter.charge(input.candidates.length, input.candidates.length * 256, "research private ordering projection");
    const candidates = input.candidates.map(row => {
      const position = positions.get(packageRoot(row));
      if (position === undefined) throw new CoreError("CONFLICT", "package is outside the frozen proposal sequence");
      return { ...row, access_position: position };
    });
    // Stable equal positions preserve all prepared window/qualification variants of a root.
    // A rejected root advances to the next GLOBAL proposal, never a same-route refill.
    return selectSourceSemanticLibraryPage({ ...input, candidates, order: "source_access" });
  };
}

/**
 * Explicit request-local opt-in over an already captured native access pool and its costs.
 * This is mechanism/counterfactual evidence, not a native response, consumer gain or promotion.
 * No acquisition, producer, provider, feedback or continuation protocol is introduced here.
 */
export function compareResearchNominatedSourceLibrary(database: StorageDatabase, payload: SourceSemanticWorkerPayload,
  pool: SourceSemanticAccessPool, capturedCosts: SourceSemanticReadBudget) {
  const request = payload.request;
  if (request.kind !== "recall" || request.original_query === undefined || request.query_handle !== undefined
    || request.continuation !== undefined || request.access_policy !== "query-conditioned-v1") {
    throw new CoreError("VALIDATION", "nominated comparison requires one direct frozen-pool research request");
  }
  const authorized = authorizedScopesFromAdmission(payload.authorized_scopes).authorized_scopes;
  if (authorized === undefined) throw new CoreError("VALIDATION", "research comparison requires admitted scopes");
  const runtime = createRecallReadWorkerRuntime(database), meter = forkCapturedRequestBudget(request, capturedCosts);
  meter.retain([request, pool], "research captured request and access pool");
  const admission = admitSourceSemanticQuery(request.query_semantics, request.original_query);
  const query = admission.kind === "admitted" ? admission.query : undefined;
  const status = sourceSemanticQueryStatus(admission, request.query_semantics_unavailable);
  if (pool.access.input_id !== accessInputIdentity(request.original_query, query, request.budget, request.access_policy,
    undefined, pool.sourcePreviewExtents, pool.accessHint)) throw new CoreError("CONFLICT", "research access request binding changed");
  const { pool_id, ...receipt } = pool.access;
  if (bindAccessPoolIdentity(runtime, payload.workspace_id, authorized, receipt, meter).pool_id !== pool_id) {
    throw new CoreError("CONFLICT", "research access scope or source revision changed");
  }
  const observations = pool.sources.map(record => {
    const row = pool.access.source_candidates.find(row => row.record_id === record.identity && row.source_id === record.source_id);
    if (row === undefined) throw new CoreError("CONFLICT", "captured source observation is missing");
    return { ...row, source_version: record.source_version, content_digest: record.content_digest };
  });
  meter.charge(pool.sources.length * pool.access.source_candidates.length, observations.length * 256,
    "research captured observation binding");
  const records = bindVerifiedResearchSourceRecords(runtime, payload.workspace_id, authorized, meter, observations);
  const acquisition = sourceSemanticAccessPhases(pool.access, meter).acquisition;
  const nominations = [acquisition, ...(acquisition.supplemental ?? [])].flatMap(phase => phase.result?.nominations ?? []);
  const branches = query === undefined
    ? { proofGroups: [], proofs: [], unproved: [], examined: [], supports: [], pairs: 0,
      executedCount: 0, computeOpen: false, interpretationTruncated: false }
    : executeLibraryBranches(runtime, payload, authorized, meter, pool.descriptors, request, query, request.original_query);
  const requestIdentity = fieldContractSha256(canonicalJson({ ...request, continuation: undefined }));
  const publicIdentity = sourceSemanticLibraryRequestIdentity({ workspace_id: payload.workspace_id, as_of: payload.as_of,
    authorized_scopes: authorized, original_query: request.original_query, query_semantics: query, query_semantics_status: status,
    semantic_correspondences: request.semantic_correspondences ?? [], budget: request.budget,
    output_byte_limit: request.output_byte_limit, access_policy: request.access_policy,
    ...(pool.accessHint === undefined ? {} : { access_hint: pool.accessHint }) });
  const capture = (nominated: boolean) => {
    const preparation = forkCapturedRequestBudget(request, meter);
    const prepared = prepareSourceSemanticLibraryInputs(runtime, payload, authorized, preparation, request, status, query,
      { sources: records, pages: pool.sourcePages, open: pool.access.unvisited_sources, truncated: pool.access.unvisited_sources },
      { descriptors: pool.descriptors, interpretationPages: pool.interpretationPages,
        interpretationOpen: pool.access.unvisited_interpretations, interpretationTruncated: pool.access.unvisited_interpretations, pool },
      branches, request.original_query!, requestIdentity, publicIdentity, nominated ? nominations : undefined);
    if (prepared.incomplete) throw new SourceSemanticResourceExhausted("research frozen package preparation");
    return { prepared, preparation };
  };
  const prefix = capture(false), nominated = capture(true);
  const nominatedO1 = measureArm(runtime, payload, request, nominated, "O1", "field");
  // Ranking contrasts consume the SAME captured nominated repertoire and total request envelope.
  return { kind: "PRIVATE_COUNTERFACTUAL" as const, query_semantics_status: status,
    hydration: {
      prefix: measureArm(runtime, payload, request, prefix, "O1", "field"),
      nominated: nominatedO1
    },
    ordering: {
      o1: nominatedO1,
      access: measureArm(runtime, payload, request, nominated, "access-order", "source_access"),
      native: measureArm(runtime, payload, request, nominated, "native-provenance", "source_access", acquisition)
    } };
}

function measureArm(runtime: Runtime, payload: SourceSemanticWorkerPayload, request: Request,
  capture: { prepared: Prepared; preparation: SourceSemanticReadBudget }, policy: string,
  order: "field" | "source_access", acquisition?: SourceSemanticAcquisitionPhase) {
  const meter = forkCapturedRequestBudget(request, capture.preparation);
  const proposals = acquisition === undefined ? undefined : projectResearchNativeProposals(capture.prepared.packages, acquisition, meter);
  const selection = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) });
  const plan = prepareLibraryDelivery(capture.prepared.base, capture.prepared.packages, request, selection, order,
    proposals === undefined ? selectSourceSemanticLibraryPage : researchNativeProposalSelector(proposals), capture.prepared.execution);
  meter.absorb(selection);
  const result = deliverFrozenLibraryPage(runtime, payload, meter, request, plan, 0);
  const encoded = encodeSourceSemanticLibraryResponse(result);
  if (encoded.operation !== "recall" || encoded.index === undefined) {
    throw new CoreError("OBLIGATION_VIOLATION", "research fit envelope lost its recall index");
  }
  // Never return a routable MCP/native response claiming the production enumeration policy.
  // Fit still uses the unchanged FULL encoder above, including reservations and metadata.
  const { operation: _operation, order: _order, delivery_id: _delivery, request_identity: _request,
    protocol_version: _protocol, index, ...content } = encoded;
  const { continuation: _continuation, ...privateIndex } = index;
  const artifact = { ...content, index: privateIndex, frozen_plan_has_more: index.continuation !== null };
  return { kind: "PRIVATE_COUNTERFACTUAL" as const, policy, proposals,
    full_envelope_bytes: Buffer.byteLength(JSON.stringify(encoded)), output_byte_limit: request.output_byte_limit,
    fit_template: "unchanged native full envelope; not an executed evidence_support ranking claim" as const,
    artifact, package_repertoire: capture.prepared.packages.map(row => ({ target: row.entry.target, proofs: row.proofs })),
    frozen_pages: plan.pages.map(page => page.map(row => ({ target: row.entry.target, preview: row.preview, proofs: row.proofs }))) };
}

/** Replay the captured call's phases as well as its costs, not a new native-only execution. */
function forkCapturedRequestBudget(request: Request, captured: SourceSemanticReadBudget): SourceSemanticReadBudget {
  const meter = new SourceSemanticReadBudget(request.budget);
  meter.absorb(captured);
  meter.preparation = captured.preparation; meter.acquisition = captured.acquisition;
  return meter;
}

function packageRoot(row: SourceSemanticLibraryPackage): string {
  if (row.entry.target.kind !== "source_evidence") throw new CoreError("CONFLICT", "research library package lost source root");
  return sourceGoldRootIdentity(row.entry.target);
}
