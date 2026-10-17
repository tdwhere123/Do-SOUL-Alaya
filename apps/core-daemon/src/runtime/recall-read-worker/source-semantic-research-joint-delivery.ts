import { canonicalJson, SourceSemanticResourceExhausted } from "@do-soul/alaya-protocol";
import { CoreError, encodeSourceSemanticLibraryResponse, fieldContractSha256,
  selectSourceSemanticLibraryPage, sourceGoldRootIdentity } from "@do-soul/alaya-core";
// Named private friend consumer; intentionally absent from the Core package-root export surface.
import { assessSourceSemanticJointWitness, type SourceSemanticJointAssessment }
  from "@do-soul/alaya-core/dist/recall/conditional-field/query/source-semantic-joint-witness.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { workOf } from "./source-semantic-discovery.js";
import { executeLibraryBranches, prepareSourceSemanticLibraryInputs } from "./source-semantic-library-recall.js";
import { prepareLibraryDelivery, fitFrozenLibraryPage, reservedLibraryWork, type LibraryPageSelector } from "./source-semantic-library-delivery.js";
import { chargeResearchTransport, reserveResearchFailureTransport } from "./source-semantic-research-serialization.js";
import { forkCapturedRequestBudget } from "./source-semantic-research-nominated-library.js";
import type { ResearchJointDiagnostics, ResearchJointDelivery, ResearchJointReply } from "./source-semantic-joint-boundary.js";

type Args = Parameters<typeof prepareSourceSemanticLibraryInputs> extends [unknown, ...infer Rest] ? Rest : never;
type Branches = ReturnType<typeof executeLibraryBranches>;

/** Private native adapter for the planned guarded compareSemanticChainSourceAcquisition Q-present mode.
 * The bench caller is a separate integration slice. Remove if that consumer is abandoned.
 * No new observation pipeline,
 * generic ranker, retained joint state or public proof meaning. Optional failure preserves native sibling.
 */
export function captureResearchJointDelivery(native: ResearchJointReply["result"], runtime: RecallReadWorkerRuntime,
  ...args: Args): ResearchJointReply {
  const [payload, authorized, capturedCosts, request, status, query, sources, discovered, branches,
    original, requestIdentity, publicIdentity] = args;
  const meter = forkCapturedRequestBudget(request, capturedCosts);
  const progress: ResearchJointDiagnostics = { contract: "private-joint-delivery-v1", status: "unavailable",
    reason: "selected_semantics_unavailable", request_identity: `sha256:${requestIdentity}`,
    assessment: null, witness_delivered: false, candidate: null, withdrawal: null, work: workOf(meter) };
  const reply: ResearchJointReply = { kind: "research_joint", result: native, private_joint: progress };
  // Reuse the native fit owner's bounded receipt, including the longer accounting tag.
  // The serialized work receipt is replaced only after its own serialization has been paid.
  const wire = () => ({ ...reply, private_joint: { ...progress,
    work: { ...reservedLibraryWork(request), native_accounting: "complete" as const } } });
  let releaseFailure: () => void;
  try {
    releaseFailure = reserveResearchFailureTransport({ ...wire(), private_joint: { ...wire().private_joint,
      status: "failed", reason: "\u0000".repeat(1024) } }, meter);
  } catch (error) {
    // Even a failed private envelope needs funding. Use the existing error boundary rather
    // than return an unpaid payload; retain the fork's planning cost separately from native work.
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    throw new CoreError("CONFLICT", error.message, { subCode: "RETRYABLE_BACKPRESSURE",
      details: { private_joint_work: workOf(meter), native_work: native.work } });
  }
  try {
    compute();
    chargeResearchTransport(wire(), meter);
  } catch (error) {
    progress.status = "failed";
    // A partially priced candidate is not a deliverable, including on early/unavailable paths.
    progress.assessment = null; progress.candidate = null; progress.withdrawal = null; progress.witness_delivered = false;
    progress.reason = error instanceof SourceSemanticResourceExhausted ? `resource_exhausted:${error.phase}`.slice(0, 1024)
      : error instanceof Error ? error.message.slice(0, 1024) : "private_joint_diagnostic_failed";
    releaseFailure();
    chargeResearchTransport(wire(), meter);
  } finally {
    releaseFailure();
    // Cumulative original-request cost, not a new allowance or native-prefix debit.
    progress.work = workOf(meter);
  }
  return reply;

  function compute(): void {
    const selection = payload.joint_control;
    if (selection === undefined) return;
    const identity = { native_request_identity: requestIdentity, selection };
    const identityBytes = meter.canonicalJsonLength(identity);
    meter.charge(identityBytes, identityBytes * 2, "private joint selection identity");
    progress.request_identity = `sha256:${fieldContractSha256(canonicalJson(identity))}`;
    meter.retain(selection, "private joint captured selection");
    if (query === undefined) return;
    const prepare = (local: Branches) => prepareSourceSemanticLibraryInputs(runtime, payload, authorized, meter,
      request, status, query, sources, discovered, local, original, requestIdentity, publicIdentity);
    const prepared = prepare(branches);
    const snapshotMaterial = { native: prepared.base.snapshot_id, selection };
    const snapshotBytes = meter.canonicalJsonLength(snapshotMaterial);
    meter.charge(snapshotBytes, snapshotBytes * 2, "private joint snapshot binding");
    const snapshot = `sha256:${fieldContractSha256(canonicalJson(snapshotMaterial))}`;
    const assess = (local: Branches) => assessSourceSemanticJointWitness({ selection, locals: local.supports,
      snapshot_id: snapshot, as_of: payload.as_of, meter });
    progress.assessment = assess(branches);
    progress.candidate = deliver(prepared, progress.assessment);
    progress.witness_delivered = jointWitnessDelivered(progress.assessment, progress.candidate);
    // Reexecute only the selected seed through the same native owner and still-owned SQLite snapshot.
    // Its existing withdrawal owner removes a real consumed Bridge leaf and reprojects that state.
    const seed = executeLibraryBranches(runtime, payload, authorized, meter,
      discovered.descriptors.filter(d => d.interpretation_id === selection.seed.interpretation_id),
      request, query, original, { interpretation_id: selection.seed.interpretation_id,
        occurrence: selection.seed.bridge.source_frame });
    const arm = seed.withdrawals[0];
    if (arm === undefined) {
      progress.reason = "bridge_withdrawal_unavailable";
      return;
    }
    const supports = branches.supports.filter(s => s.proof.source_interpretation_id !== arm.interpretation_id);
    if (arm.support !== null) supports.push(arm.support);
    const withdrawn: Branches = { ...branches, supports, proofs: supports.map(s => s.proof),
      proofGroups: supports.map(s => ({ entries: [...s.group.entries], explanations: [...s.group.explanations] })), withdrawals: seed.withdrawals };
    const approval = branches.supports.filter(s => s.proof.source_interpretation_id === selection.approval.interpretation_id);
    const preserved = approval.length > 0 && approval.every(s => supports.includes(s));
    const assessment = assess(withdrawn);
    progress.withdrawal = { leaf_id: arm.leaf_id, leaf: arm.leaf, assessment,
      independent_approval_preserved: preserved, delivery: deliver(prepare(withdrawn), assessment) };
    progress.status = progress.witness_delivered && assessment.status === "unresolved" && preserved ? "complete" : "unavailable";
    progress.reason = progress.status === "complete" ? null : progress.assessment.status === "witnessed"
      ? "joint_support_not_delivered" : progress.assessment.reason;

    function deliver(prepared: ReturnType<typeof prepare>, assessment: SourceSemanticJointAssessment): ResearchJointDelivery {
      const plan = prepareLibraryDelivery(prepared.base, prepared.packages, request, meter, "field",
        pairSelector(assessment), prepared.execution);
      const result = fitFrozenLibraryPage(meter, request, plan, 0);
      meter.retain(result, "private joint full fitting response");
      const encoded = encodeSourceSemanticLibraryResponse(result);
      const fullLength = meter.canonicalJsonLength(encoded);
      meter.charge(fullLength, fullLength * 2, "private joint full encoder work");
      const fullBytes = Buffer.byteLength(canonicalJson(encoded), "utf8");
      if (encoded.operation !== "recall" || encoded.index === undefined || fullBytes > request.output_byte_limit) {
        throw new CoreError("CONFLICT", "private joint page does not fit its unchanged full native envelope");
      }
      const { operation: _operation, order: _order, delivery_id: _delivery, request_identity: _request,
        protocol_version: _protocol, index, ...content } = encoded;
      const { continuation: _continuation, ...privateIndex } = index;
      const artifact = { ...content, index: privateIndex, frozen_plan_has_more: index.continuation !== null };
      meter.retain(artifact, "private joint delivered page references");
      const bytes = meter.canonicalJsonLength(artifact);
      meter.charge(bytes, bytes * 4, "private joint page serialization and worker transport");
      return { artifact, serialized: canonicalJson(artifact), full_envelope_bytes: fullBytes, output_byte_limit: request.output_byte_limit };
    }
  }
}

function jointWitnessDelivered(assessment: SourceSemanticJointAssessment, delivery: ResearchJointDelivery): boolean {
  const witness = assessment.witness;
  return witness !== null && witness.locals.every((local, i) => {
    const proof = delivery.artifact.proofs?.find(p => p.conditional_computation_id === local.proof_identity);
    const binding = proof?.binding_results?.find(b => b.binding_id === local.binding_id);
    return binding !== undefined && canonicalJson(binding.explanation_ids) === canonicalJson(local.explanation_ids)
      && local.observations.every(o => proof?.evidence_leaves?.some(e => e.observation_id === o.observation_id
        && canonicalJson(e.leaf) === canonicalJson(o.leaf)))
      && delivery.artifact.index.entries.some(e => e.target.kind === "source_evidence" && e.target.span !== undefined
        && sourceGoldRootIdentity(e.target) === sourceGoldRootIdentity(witness.source_targets[i]!));
  });
}

/** One bounded contrast: only the two complete witnessed local packages gain first-page priority.
 * The existing selector owns root occupancy, proof variants, caps and actual-envelope fit.
 * All remaining packages preserve native access order. No private proof is put on a public slot.
 */
function pairSelector(assessment: SourceSemanticJointAssessment): LibraryPageSelector {
  const witness = assessment.witness;
  if (witness === null) return selectSourceSemanticLibraryPage;
  return input => {
    input.meter.charge(input.candidates.length * 3, input.candidates.length * 256, "private witnessed pair delivery ordering");
    const candidates = input.candidates.map(row => {
      const target = row.entry.target;
      const required = target.kind === "source_evidence" ? witness.source_targets.findIndex(t => sourceGoldRootIdentity(t) === sourceGoldRootIdentity(target)) : -1;
      const local = required < 0 ? undefined : witness.locals[required];
      const complete = local !== undefined && row.proofs.some(p => p.conditional_computation_id === local.proof_identity
        && p.binding_results?.some(b => b.binding_id === local.binding_id));
      return { ...row, access_position: complete ? required : row.access_position + 2 };
    });
    return selectSourceSemanticLibraryPage({ ...input, candidates, order: "source_access" });
  };
}
