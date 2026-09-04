import type { FourValuedWitness } from "../../witness/index.js";
import { captureData } from "../../../capture-data.js";
import { createSupportHypergraph } from "../graph.js";
import type { SupportHypergraphReceiptV1 } from "../receipt.js";
import { createDraft, type SupportDraft } from "./draft.js";
import { adaptFactFrames } from "./fact-frame.js";
import { adaptOsfCandidate } from "./osf.js";
import { adaptPathProjection, adaptEvidenceAndF3, adaptTemporal } from
  "./path-temporal.js";
import {
  adaptPolarityReceipts,
  candidatePropositionObservationsFromDraft,
  polaritiesFromDraft
} from "./polarity.js";
import type {
  SupportCandidateReceiptV1,
  SupportMaterializationOutcomeV1,
  SupportMaterializationInputV1,
  SupportObservabilityGapV1,
  SupportPropositionObservationV1,
  SupportRelationalSourceVerifierV1
} from "./types.js";

export type SupportMaterializationV1 = Readonly<{
  readonly graph: SupportHypergraphReceiptV1;
  readonly polarities: readonly FourValuedWitness[];
  readonly proposition_observations: readonly SupportPropositionObservationV1[];
  readonly gaps: readonly SupportObservabilityGapV1[];
  readonly outcomes: readonly SupportMaterializationOutcomeV1[];
}>;

export function materializeSupportFromReceipts(
  input: SupportMaterializationInputV1
): SupportMaterializationV1 {
  const captured = captureMaterializationInput(input);
  const draft = createDraft();
  for (const candidate of captured.candidates ?? []) {
    adaptCandidate(draft, candidate, captured);
  }
  const graph = createSupportHypergraph({
    query_id: captured.query_id,
    snapshot_digest: captured.snapshot_digest,
    nodes: [...draft.nodes.values()],
    edges: [...draft.edges.values()]
  });
  const lease = captured.authority_context?.read_lease;
  const proposition_observations = candidatePropositionObservationsFromDraft(
    draft,
    captured.query_id,
    captured.snapshot_digest,
    Object.freeze({
      workspace_id: null,
      principal: lease?.principal ?? null
    })
  );
  registerIssuedSupportSource(graph, captured.candidates ?? [], proposition_observations);
  return Object.freeze({
    graph,
    polarities: polaritiesFromDraft(draft, captured.query_id, captured.snapshot_digest),
    proposition_observations,
    gaps: Object.freeze([...draft.gaps]),
    outcomes: Object.freeze([...draft.outcomes])
  });
}

function captureMaterializationInput(
  input: SupportMaterializationInputV1
): SupportMaterializationInputV1 {
  const candidates = captureData(input.candidates ?? []);
  const authority = input.authority_context;
  if (authority === undefined) {
    return Object.freeze({
      query_id: input.query_id,
      snapshot_digest: input.snapshot_digest,
      candidates
    });
  }
  const verifiers = bindVerifierRefs(authority.relational_source_verifiers);
  return Object.freeze({
    query_id: input.query_id,
    snapshot_digest: input.snapshot_digest,
    candidates,
    authority_context: Object.freeze({
      snapshot_vector: captureData(authority.snapshot_vector),
      snapshot_receipt: captureData(authority.snapshot_receipt),
      read_lease: captureData(authority.read_lease),
      ...(verifiers === undefined ? {} : { relational_source_verifiers: verifiers })
    })
  });
}

function bindVerifierRefs(
  verifiers: readonly SupportRelationalSourceVerifierV1[] | undefined
): readonly SupportRelationalSourceVerifierV1[] | undefined {
  if (verifiers === undefined) return undefined;
  return Object.freeze(verifiers.map((verifier) => Object.freeze({
    source_owner: verifier.source_owner,
    allowed_subject_kinds: captureData(verifier.allowed_subject_kinds),
    verifySourceObservation: verifier.verifySourceObservation
  })));
}

// Issued-graph identity cache only; OSF composition receipt is source authority.
const ISSUED_SUPPORT_SOURCES = new WeakMap<SupportHypergraphReceiptV1, Readonly<{
  readonly receipts: readonly SupportCandidateReceiptV1[];
  readonly observations: readonly SupportPropositionObservationV1[];
}>>();

function registerIssuedSupportSource(
  graph: SupportHypergraphReceiptV1,
  receipts: readonly SupportCandidateReceiptV1[],
  observations: readonly SupportPropositionObservationV1[]
): void {
  ISSUED_SUPPORT_SOURCES.set(graph, Object.freeze({
    receipts: Object.freeze([...receipts]),
    observations
  }));
}

export function issuedSupportSourceBinding(
  graph: SupportHypergraphReceiptV1
): Readonly<{
  readonly receipts: readonly SupportCandidateReceiptV1[];
  readonly observations: readonly SupportPropositionObservationV1[];
}> | undefined {
  return ISSUED_SUPPORT_SOURCES.get(graph);
}

function adaptCandidate(
  draft: SupportDraft,
  candidate: SupportCandidateReceiptV1,
  input: SupportMaterializationInputV1
): void {
  adaptOsfCandidate(draft, candidate);
  adaptFactFrames(draft, candidate);
  adaptPolarityReceipts(draft, candidate, input);
  adaptPathProjection(draft, candidate, input);
  adaptTemporal(draft, candidate);
  adaptEvidenceAndF3(draft, candidate);
}
