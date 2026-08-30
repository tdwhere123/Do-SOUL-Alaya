import { createCorrelationWitness, type CorrelationWitness, type FourValuedWitness } from
  "../../witness/index.js";
import { compareText } from "../../../../shared/compare-text.js";
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
  SupportPropositionObservationV1
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
  const draft = createDraft();
  for (const candidate of input.candidates ?? []) {
    adaptCandidate(draft, candidate, input);
  }
  const graph = createSupportHypergraph({
    query_id: input.query_id,
    snapshot_digest: input.snapshot_digest,
    nodes: [...draft.nodes.values()],
    edges: [...draft.edges.values(), ...lineageCorrelationEdges(draft)],
    correlations: lineageCorrelationWitnesses(draft, input.query_id, input.snapshot_digest)
  });
  const proposition_observations = candidatePropositionObservationsFromDraft(
    draft,
    input.query_id,
    input.snapshot_digest
  );
  registerIssuedSupportSource(graph, input.candidates ?? [], proposition_observations);
  return Object.freeze({
    graph,
    polarities: polaritiesFromDraft(draft, input.query_id, input.snapshot_digest),
    proposition_observations,
    gaps: Object.freeze([...draft.gaps]),
    outcomes: Object.freeze([...draft.outcomes])
  });
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

function lineageCorrelationEdges(draft: SupportDraft): readonly {
  readonly kind: "correlated";
  readonly from: { readonly kind: "evidence_unit"; readonly id: string };
  readonly to: { readonly kind: "evidence_unit"; readonly id: string };
}[] {
  const pairs = lineagePairs(draft);
  return pairs.map(([left, right]) => ({
    kind: "correlated" as const,
    from: { kind: "evidence_unit" as const, id: left },
    to: { kind: "evidence_unit" as const, id: right }
  }));
}

function lineageCorrelationWitnesses(
  draft: SupportDraft,
  queryId: string,
  snapshot: string
): readonly CorrelationWitness[] {
  return lineagePairs(draft).map(([left, right]) => createCorrelationWitness({
    identity: {
      coordinate_id: `support.corr:${left}:${right}`,
      query_id: queryId,
      snapshot_digest: snapshot
    },
    provenance: [{ source_id: "support.adapter", producer: "support.correlation.v1" }],
    epistemic: { kind: "exact" },
    payload: { left_id: left, right_id: right, state: "same_source_lineage" }
  }));
}

function lineagePairs(draft: SupportDraft): readonly [string, string][] {
  const byLineage = new Map<string, string[]>();
  for (const [evidenceId, lineageIds] of draft.evidenceLineages) {
    for (const lineageId of lineageIds) {
      const group = byLineage.get(lineageId) ?? [];
      group.push(evidenceId);
      byLineage.set(lineageId, group);
    }
  }
  const pairs = new Map<string, [string, string]>();
  for (const group of byLineage.values()) {
    const unique = [...new Set(group)].sort();
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const pair: [string, string] = [unique[i]!, unique[j]!];
        pairs.set(pair.join("\0"), pair);
      }
    }
  }
  return [...pairs.values()].sort(([leftA, rightA], [leftB, rightB]) =>
    compareText(leftA, leftB) || compareText(rightA, rightB));
}
