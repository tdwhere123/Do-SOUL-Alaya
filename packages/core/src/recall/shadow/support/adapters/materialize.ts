import { createCorrelationWitness, type CorrelationWitness, type FourValuedWitness } from
  "../../witness/index.js";
import { createSupportHypergraph } from "../graph.js";
import type { SupportHypergraphReceiptV1 } from "../receipt.js";
import { createDraft, type SupportDraft } from "./draft.js";
import { adaptFactFrames } from "./fact-frame.js";
import { adaptOsfCandidate } from "./osf.js";
import { adaptPathProjection, adaptEvidenceAndF3, adaptTemporal } from
  "./path-temporal.js";
import { adaptPolarityReceipts, polaritiesFromDraft } from "./polarity.js";
import type {
  SupportCandidateReceiptV1,
  SupportMaterializationInputV1,
  SupportObservabilityGapV1
} from "./types.js";

export type SupportMaterializationV1 = Readonly<{
  readonly graph: SupportHypergraphReceiptV1;
  readonly polarities: readonly FourValuedWitness[];
  readonly gaps: readonly SupportObservabilityGapV1[];
}>;

export function materializeSupportFromReceipts(
  input: SupportMaterializationInputV1
): SupportMaterializationV1 {
  const draft = createDraft();
  for (const candidate of input.candidates ?? []) {
    adaptCandidate(draft, candidate);
  }
  const graph = createSupportHypergraph({
    query_id: input.query_id,
    snapshot_digest: input.snapshot_digest,
    nodes: [...draft.nodes.values()],
    edges: [...draft.edges.values(), ...lineageCorrelationEdges(draft)],
    correlations: lineageCorrelationWitnesses(draft, input.query_id, input.snapshot_digest)
  });
  return Object.freeze({
    graph,
    polarities: polaritiesFromDraft(draft, input.query_id, input.snapshot_digest),
    gaps: Object.freeze([...draft.gaps])
  });
}

function adaptCandidate(draft: SupportDraft, candidate: SupportCandidateReceiptV1): void {
  adaptOsfCandidate(draft, candidate);
  adaptFactFrames(draft, candidate);
  adaptPolarityReceipts(draft, candidate);
  adaptPathProjection(draft, candidate);
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
  for (const [evidenceId, lineageId] of draft.evidenceLineage) {
    const group = byLineage.get(lineageId) ?? [];
    group.push(evidenceId);
    byLineage.set(lineageId, group);
  }
  const pairs: [string, string][] = [];
  for (const group of byLineage.values()) {
    const unique = [...new Set(group)].sort();
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        pairs.push([unique[i]!, unique[j]!]);
      }
    }
  }
  return pairs;
}
