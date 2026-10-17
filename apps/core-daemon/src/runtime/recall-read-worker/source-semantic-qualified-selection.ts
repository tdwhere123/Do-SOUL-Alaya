import { canonicalJson, SourceSemanticResourceExhausted, type SourceSemanticWorkerRequest } from "@do-soul/alaya-protocol";
import { CoreError, admitSourceSemanticQuery, admitSourceSemanticCorrespondence, authorizedScopesFromAdmission,
  sourceSemanticQueryStatus, fieldContractSha256, sourceSemanticLibraryRequestIdentity,
  selectSourceSemanticLibraryPage, encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
// Existing private algorithm, deliberately not a new package-root/product selection policy.
import { selectSourceSemanticLibraryPageWithEvidenceSetCoverage }
  from "@do-soul/alaya-core/dist/recall/runtime/source-semantic-library-selection.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { workOf, loadVerified, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { bindResearchQualifiedSourcePool } from "./source-semantic-research-pool.js";
import { executeLibraryBranches, prepareSourceSemanticLibraryInputs } from "./source-semantic-library-recall.js";
import { prepareLibraryDelivery, fitFrozenLibraryPage, reservedLibraryWork, type LibraryPageSelector }
  from "./source-semantic-library-delivery.js";
import { forkCapturedRequestBudget } from "./source-semantic-research-nominated-library.js";
import { chargeResearchTransport, reserveResearchFailureTransport } from "./source-semantic-research-serialization.js";
import type { QualifiedSourceSelectionReply, QualifiedSourceSelectionArm } from "./source-semantic-qualified-selection-boundary.js";

type Request = Extract<SourceSemanticWorkerRequest, { kind: "recall" }>;
type Query = Extract<ReturnType<typeof admitSourceSemanticQuery>, { kind: "admitted" }>;
type Prepared = ReturnType<typeof prepareSourceSemanticLibraryInputs>;
const reservedWork = (request: Request) => ({ ...reservedLibraryWork(request), native_accounting: "complete" as const });

/** One native snapshot, one paid preparation, equal counterfactual starts. No observation,
 * query preparation, continuation issuance, provider fallback or joint computation. */
export function compareResearchQualifiedSourceSelection(runtime: RecallReadWorkerRuntime,
  payload: SourceSemanticWorkerPayload, meter: SourceSemanticReadBudget): QualifiedSourceSelectionReply {
  const request = payload.request, population = payload.qualified_control;
  if (population === undefined || request.kind !== "recall" || request.original_query === undefined ||
      request.query_handle !== undefined || request.continuation !== undefined ||
      request.access_policy !== "query-conditioned-v1" || payload.prepared_query !== undefined ||
      payload.acquisition_control !== undefined || payload.joint_control !== undefined) {
    throw new CoreError("VALIDATION", "qualified selection requires one provider-free direct fixed-population recall");
  }
  const scopes = authorizedScopesFromAdmission(payload.authorized_scopes).authorized_scopes;
  if (scopes === undefined) throw new CoreError("VALIDATION", "qualified selection requires admitted scopes");
  const admission = admitSourceSemanticQuery(request.query_semantics, request.original_query);
  if (admission.kind !== "admitted") throw new CoreError("VALIDATION", "qualified selection requires admitted Q");
  // The transaction owns this ledger, including admission/quote failures and an unfundable failure wire.
  meter.retain([request, population], "qualified fixed-population admission");
  const reply: QualifiedSourceSelectionReply = { kind: "research_qualified_selection", status: "unavailable", reason: "preparation_not_completed",
    population, eligibility: population.nominees.map(source => ({ source, h: "missing", c: source.correspondence_status, reason: "not_checked" })),
    query_semantics_status: sourceSemanticQueryStatus(admission), common_work: workOf(meter), fork_start: meter.remaining(),
    arms: { default: null, evidence_set_coverage: null }, fork_work: { default: null, evidence_set_coverage: null },
    failure: null, work: workOf(meter), physical_total: "unknown" };
  const wire = () => ({ ...reply, work: reservedWork(request) });
  const releaseFailure = reserveResearchFailureTransport({ ...wire(), common_work: reservedWork(request), reason: "\u0000".repeat(1024),
    failure: { phase: "\u0000".repeat(64), name: "\u0000".repeat(256), message: "\u0000".repeat(1024), stack: "\u0000".repeat(8192), code: "\u0000".repeat(256) },
    fork_work: { default: reservedWork(request), evidence_set_coverage: reservedWork(request) },
    eligibility: reply.eligibility.map(row => ({ ...row, h: "rejected", c: "\u0000".repeat(256), reason: "\u0000".repeat(512) })) }, meter);
  let phase = "preparation";
  try {
    const prepared = prepareQualifiedPackages(runtime, payload, request, admission, scopes, meter, reply);
    reply.common_work = workOf(meter); reply.fork_start = meter.remaining();
    for (const [policy, selector] of [["default", selectSourceSemanticLibraryPage],
      ["evidence_set_coverage", selectSourceSemanticLibraryPageWithEvidenceSetCoverage]] as const) {
      phase = policy;
      const fork = forkCapturedRequestBudget(request, meter);
      // A held recovery wire is not spent work, but both forks must inherit the same unavailable capacity.
      fork.hold({ work_units: fork.work - meter.work, memory_bytes: fork.bytes - meter.bytes });
      try { reply.arms[policy] = deliverQualifiedPage(request, prepared, policy, selector, fork); }
      finally { reply.fork_work[policy] = workOf(fork); }
    }
    reply.status = "complete"; reply.reason = null; phase = "transport";
    // Outer transport is real work too, not a sum of the two cumulative fork quotes.
    chargeResearchTransport(wire(), meter);
  } catch (error) {
    if (phase === "preparation") reply.common_work = workOf(meter);
    reply.status = "failed";
    reply.reason = error instanceof Error ? error.message.slice(0, 1024) : "qualified_selection_failed";
    reply.failure = { phase, name: error instanceof Error ? error.name.slice(0, 256) : "UnknownError", message: reply.reason,
      stack: error instanceof Error ? error.stack?.slice(0, 8192) ?? null : null, code: error instanceof CoreError ? error.code : null };
    // Never expose an unpriced partial. Retain measured fork work and the funded failure instead.
    reply.arms = { default: null, evidence_set_coverage: null };
    releaseFailure();
    chargeResearchTransport(wire(), meter);
  } finally { releaseFailure(); reply.work = workOf(meter); }
  return reply;
}

/** Common source verification, local admission, execution and hydration precede either policy. */
function prepareQualifiedPackages(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  request: Request, admission: Query, scopes: readonly string[] | null, meter: SourceSemanticReadBudget,
  reply: QualifiedSourceSelectionReply): Prepared {
  const original = request.original_query!;
  const { pool, eligibility } = bindResearchQualifiedSourcePool(runtime, payload.workspace_id, scopes, meter,
    original, admission.query, request.budget, reply.population);
  reply.eligibility = eligibility;
  const correspondences = request.semantic_correspondences ?? [];
  if (correspondences.some(c => !reply.population.nominees.some(row => row.interpretation?.interpretation_id === c.source_interpretation_id))) {
    throw new CoreError("VALIDATION", "correspondence escapes the fixed population");
  }
  const admitted = correspondences.filter(c => {
    const row = eligibility.find(row => row.source.interpretation?.interpretation_id === c.source_interpretation_id)!;
    if (row.h !== "ready") { row.c = "unavailable_h"; return false; }
    const h = loadVerified(runtime, payload.workspace_id, c.source_interpretation_id, scopes, meter);
    const aligned = admitSourceSemanticCorrespondence({ semantic_correspondence: c,
      source_interpretation: h.bound.interpretation, query_semantics: admission.query, original_query: original });
    row.c = aligned.kind === "admitted" ? "admitted" : "rejected";
    return aligned.kind === "admitted";
  });
  const executable = { ...request, semantic_correspondences: admitted };
  const branches = executeLibraryBranches(runtime, payload, scopes, meter, pool.descriptors, executable, admission.query, original);
  const requestIdentity = fieldContractSha256(canonicalJson({ ...request, continuation: undefined }));
  const publicIdentity = sourceSemanticLibraryRequestIdentity({ workspace_id: payload.workspace_id, as_of: payload.as_of,
    authorized_scopes: scopes, original_query: original, query_semantics: admission.query,
    query_semantics_status: reply.query_semantics_status, semantic_correspondences: correspondences, budget: request.budget,
    output_byte_limit: request.output_byte_limit, access_policy: request.access_policy! });
  const prepared = prepareSourceSemanticLibraryInputs(runtime, payload, scopes, meter, executable, reply.query_semantics_status, admission.query,
    { sources: [...pool.sources], pages: pool.sourcePages, open: false, truncated: false },
    { descriptors: pool.descriptors, interpretationPages: pool.interpretationPages,
      interpretationOpen: false, interpretationTruncated: false, pool }, branches, original, requestIdentity, publicIdentity);
  if (prepared.incomplete) throw new SourceSemanticResourceExhausted("qualified package preparation");
  return prepared;
}

/** The existing full-envelope owners fit and encode the actual public spans/proofs; only non-issued
 * routing identities are removed from the private retained page. No lease owner is called. */
function deliverQualifiedPage(request: Request, prepared: Prepared, policy: QualifiedSourceSelectionArm["policy"],
  selector: LibraryPageSelector, meter: SourceSemanticReadBudget): QualifiedSourceSelectionArm {
  const selection = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) });
  let plan: ReturnType<typeof prepareLibraryDelivery>;
  try { plan = prepareLibraryDelivery(prepared.base, prepared.packages, request, selection, "field", selector, prepared.execution); }
  finally { meter.absorb(selection); }
  const result = fitFrozenLibraryPage(meter, request, plan, 0);
  meter.retain(result, "qualified full native response");
  const encoded = encodeSourceSemanticLibraryResponse(result);
  chargeResearchTransport(encoded, meter);
  const fullBytes = Buffer.byteLength(JSON.stringify(encoded));
  if (encoded.operation !== "recall" || encoded.index === undefined || fullBytes > request.output_byte_limit) {
    throw new CoreError("CONFLICT", "qualified selection lost its fitting full envelope");
  }
  const { operation: _operation, order: _order, delivery_id: _delivery, request_identity: _request,
    protocol_version: _protocol, index, ...content } = encoded;
  const { continuation: _continuation, ...privateIndex } = index;
  const artifact = { ...content, index: privateIndex, frozen_plan_has_more: index.continuation !== null };
  meter.retain(artifact, "qualified private page");
  const serialized = canonicalJson(artifact);
  const arm = { policy, artifact, serialized, full_envelope_bytes: fullBytes,
    output_byte_limit: request.output_byte_limit, work: reservedWork(request) };
  chargeResearchTransport(arm, meter);
  return { ...arm, work: workOf(meter) };
}
