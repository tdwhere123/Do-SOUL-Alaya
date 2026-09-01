import { compareText } from "../../../../shared/compare-text.js";
import {
  digestCanonicalQueryV1
} from "../../../query/canonical-query/validate.js";
import type { CanonicalAnswerProgramV1 } from
  "../../../query/canonical-query/types.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import type { ShadowWalkRuntimeManifestV1 } from
  "../../prefix-capture/walk-runtime-capture.js";
import { captureData } from "../../capture-data.js";
import {
  captureVerifiedSupportSourceSnapshot,
  readVerifiedSupportSourceSnapshot
} from "../measurement/support-source-admission.js";
import type { VerifiedMeasurementAuthorityV1 } from "../measurement/admission.js";
import type {
  SupportCandidateReceiptV1,
  SupportPropositionObservationV1
} from "../support/adapters/types.js";
import { supportReceiptBindsCurrentQuery } from
  "../support/live-support-receipts.js";
import {
  verifyLiveQueryProofAuthority,
  type LiveQueryProofAuthority
} from "../live-query-proof-authority.js";
import type {
  QueryGammaAtomJurisdictionV1,
  QueryGammaCandidateEvidenceV1,
  QueryGammaPropositionEvidenceV1
} from "./contract.js";

export type SourceOwnedQueryGammaEvidenceV1 = Readonly<{
  readonly candidates: readonly QueryGammaCandidateEvidenceV1[];
  readonly answer_bindings: readonly Readonly<{
    readonly candidate_key: string;
    readonly binding_id: string;
    readonly variable: string;
    readonly semantic_identity: string;
    readonly value: string;
  }>[];
  readonly hypothesis_digest: RecallFieldDigest;
  readonly source_digest: RecallFieldDigest;
}>;

export function captureSourceOwnedQueryGammaEvidence(params: Readonly<{
  readonly live_authority: LiveQueryProofAuthority;
  readonly measurement_authority: VerifiedMeasurementAuthorityV1;
  readonly runtime: ShadowWalkRuntimeManifestV1;
}>): SourceOwnedQueryGammaEvidenceV1 {
  const live = verifyLiveQueryProofAuthority(params.live_authority);
  const source = captureVerifiedSupportSourceSnapshot(params.measurement_authority);
  if (source.query_id !== live.query_id || source.workspace_id !== live.workspace_id ||
      source.snapshot_digest !== live.snapshot_digest ||
      source.lease_digest !==
        digestRecallFieldIdentity(params.live_authority.snapshot_read_lease)) {
    throw new Error("Gamma support source is not bound to the live query snapshot");
  }
  const sourceData = readVerifiedSupportSourceSnapshot(source);
  if (sourceData === null) {
    throw new Error("Gamma support source snapshot is not issued");
  }
  const compilation = params.live_authority.canonical_query_compilation;
  const query = receiptBoundHypothesis(compilation, sourceData.receipts);
  const queryDigest = digestCanonicalQueryV1(query);
  const candidateKeys = new Set(params.runtime.candidates.map(({ candidate_key }) => candidate_key));
  const receiptsByKey = new Map(sourceData.receipts.map((receipt) =>
    [receipt.candidate_key, receipt] as const));
  if (receiptsByKey.size !== sourceData.receipts.length ||
      sourceData.receipts.some((receipt) =>
        !candidateKeys.has(receipt.candidate_key) ||
        receipt.hypothesis_digest !== queryDigest ||
        !supportReceiptBindsCurrentQuery(receipt, compilation))) {
    throw new Error("Gamma support receipts are outside the runtime query universe");
  }
  const jurisdiction = propositionJurisdiction(query);
  const candidates = params.runtime.candidates.map((candidate) => candidateEvidence(
    candidate,
    receiptsByKey.get(candidate.candidate_key),
    sourceData.observations,
    queryDigest,
    jurisdiction
  ));
  const answerVariables = answerBindingVariables(query.answer);
  const answerBindings = candidates.flatMap((candidate) => candidate.bindings
    .filter(({ variable }) => answerVariables.has(variable))
    .map((binding) => Object.freeze({
      candidate_key: candidate.candidate_key,
      binding_id: digestRecallFieldIdentity({
        kind: "source_owned_query_binding_v1",
        candidate_key: candidate.candidate_key,
        variable: binding.variable,
        semantic_identity: binding.semantic_identity
      }),
      variable: binding.variable,
      semantic_identity: binding.semantic_identity,
      value: binding.semantic_identity
    }))).sort((left, right) =>
      compareText(left.candidate_key, right.candidate_key) ||
      compareText(left.binding_id, right.binding_id));
  return captureData({
    candidates,
    answer_bindings: answerBindings,
    hypothesis_digest: queryDigest,
    source_digest: digestRecallFieldIdentity({
      kind: "source_owned_query_gamma_evidence_v1",
      support_source_digest: source.source_digest,
      live_query_digest: queryDigest,
      runtime_candidate_digest: digestRecallFieldIdentity(params.runtime.candidates),
      candidate_evidence_digest: digestRecallFieldIdentity(candidates),
      answer_binding_digest: digestRecallFieldIdentity(answerBindings)
    })
  });
}

function receiptBoundHypothesis(
  compilation: LiveQueryProofAuthority["canonical_query_compilation"],
  receipts: readonly SupportCandidateReceiptV1[]
): LiveQueryProofAuthority["canonical_query_compilation"]["hypotheses"][number] {
  const hypothesisDigests = new Set(receipts
    .map(({ hypothesis_digest }) => hypothesis_digest)
    .filter((digest): digest is string => digest !== undefined));
  const selectedDigest = hypothesisDigests.size === 1
    ? [...hypothesisDigests][0]
    : undefined;
  const query = selectedDigest === undefined
    ? undefined
    : compilation.hypotheses.find((candidate) =>
      digestCanonicalQueryV1(candidate) === selectedDigest);
  if (query === undefined) {
    throw new Error("source-owned Gamma requires one receipt-bound query hypothesis");
  }
  return query;
}

function candidateEvidence(
  candidate: ShadowWalkRuntimeManifestV1["candidates"][number],
  receipt: SupportCandidateReceiptV1 | undefined,
  observations: readonly SupportPropositionObservationV1[],
  queryDigest: string,
  jurisdiction: ReadonlyMap<string, QueryGammaAtomJurisdictionV1>
): QueryGammaCandidateEvidenceV1 {
  const osf = receipt?.osf;
  const bindingsObserved = osf?.composition_status === "composed" && osf.truncated === false;
  const bindings = bindingsObserved
    ? uniqueBindings(osf.bindings ?? [])
    : Object.freeze([]);
  const propositionRows = observations.filter((observation) =>
    observation.candidate_id === candidate.candidate_key &&
    observation.hypothesis_digest === queryDigest &&
    jurisdiction.has(observation.local_proposition_id));
  const propositions = propositionRows.map((observation) => Object.freeze({
    proposition_id: observation.local_proposition_id,
    jurisdiction: jurisdiction.get(observation.local_proposition_id)!,
    support: propositionSupport(observation.witness.payload?.polarity ?? "unknown"),
    independence: "unknown" as const
  }));
  const propositionIds = new Set(propositions.map(({ proposition_id }) => proposition_id));
  if (propositionIds.size !== propositions.length) {
    throw new Error("Gamma support observations duplicate a query proposition");
  }
  return Object.freeze({
    candidate_key: candidate.candidate_key,
    object_key: candidate.object_key,
    token_cost: candidate.token_cost,
    dimension: candidate.dimension,
    bindings_status: bindingsObserved ? "observed" as const : "unknown" as const,
    bindings,
    propositions_status: [...jurisdiction.keys()].every((id) => propositionIds.has(id))
      ? "observed" as const
      : "unknown" as const,
    propositions: Object.freeze(propositions.sort((left, right) =>
      compareText(`${left.jurisdiction}\0${left.proposition_id}`,
        `${right.jurisdiction}\0${right.proposition_id}`))),
    sequence_slots: Object.freeze([]),
    extremal_bindings: Object.freeze([])
  });
}

function uniqueBindings(
  rows: readonly Readonly<{
    readonly variable_id: string;
    readonly semantic_identity: string;
  }>[]
): QueryGammaCandidateEvidenceV1["bindings"] {
  const byIdentity = new Map<string, QueryGammaCandidateEvidenceV1["bindings"][number]>();
  for (const row of rows) {
    const key = `${row.variable_id}\0${row.semantic_identity}`;
    byIdentity.set(key, Object.freeze({
      variable: row.variable_id,
      semantic_identity: row.semantic_identity,
      distinctness: "unknown" as const
    }));
  }
  return Object.freeze([...byIdentity.values()].sort((left, right) =>
    compareText(`${left.variable}\0${left.semantic_identity}`,
      `${right.variable}\0${right.semantic_identity}`)));
}

function propositionJurisdiction(
  query: LiveQueryProofAuthority["canonical_query_compilation"]["hypotheses"][number]
): ReadonlyMap<string, QueryGammaAtomJurisdictionV1> {
  return new Map<string, QueryGammaAtomJurisdictionV1>([
    ...query.predicates.map(({ id }) => [id, "predicate"] as const),
    ...query.constraints.map(({ id }) => [id, "constraint"] as const)
  ]);
}

function propositionSupport(
  polarity: "supported_only" | "refuted_only" | "both" | "unknown"
): QueryGammaPropositionEvidenceV1["support"] {
  if (polarity === "supported_only") return "supports";
  if (polarity === "refuted_only") return "refutes";
  return "unknown";
}

function answerBindingVariables(
  answer: CanonicalAnswerProgramV1
): ReadonlySet<string> {
  if (answer.kind === "scalar" || answer.kind === "distinct" || answer.kind === "sequence") {
    return new Set([answer.variable]);
  }
  return answerBindingVariables(answer.inner);
}
