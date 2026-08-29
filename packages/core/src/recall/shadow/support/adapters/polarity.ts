import { createFourValuedWitness, type FourValuedPolarity, type FourValuedWitness } from
  "../../witness/index.js";
import type { SupportDraft } from "./draft.js";
import { addEdge, addGap, addNode, supersedeLineage, vote } from "./draft.js";
import type { SupportCandidateReceiptV1 } from "./types.js";

export function adaptPolarityReceipts(
  draft: SupportDraft,
  candidate: SupportCandidateReceiptV1
): void {
  adaptPolarity(draft, candidate);
  adaptContradiction(draft, candidate);
  adaptSupersession(draft, candidate);
}

export function polaritiesFromDraft(
  draft: SupportDraft,
  queryId: string,
  snapshot: string
): readonly FourValuedWitness[] {
  const witnesses: FourValuedWitness[] = [];
  for (const [propositionId, votes] of draft.votes) {
    const polarity = polarityOf(votes.support, votes.refute, votes.superseded);
    witnesses.push(createFourValuedWitness({
      identity: {
        coordinate_id: `support.polarity:${propositionId}`,
        query_id: queryId,
        snapshot_digest: snapshot,
        proposition_id: propositionId
      },
      provenance: [{ source_id: "support.adapter", producer: "support.polarity.v1" }],
      epistemic: polarity === "both" ? { kind: "conflict" } : { kind: "exact" },
      payload: { polarity }
    }));
  }
  return Object.freeze(witnesses);
}

function adaptPolarity(draft: SupportDraft, candidate: SupportCandidateReceiptV1): void {
  const polarity = candidate.polarity;
  if (polarity === undefined) return;
  if (polarity.status === "unavailable") {
    addGap(draft, "polarity_unavailable", candidate.candidate_key, polarity.reason);
    return;
  }
  const propositionId = polarity.value.proposition_id;
  if (propositionId === undefined) {
    addGap(draft, "binding_absent", candidate.candidate_key, "polarity without proposition");
    return;
  }
  addNode(draft, "proposition", propositionId);
  vote(
    draft,
    propositionId,
    polarity.value.lineage_id,
    polarity.value.polarity === "positive" ? "support" : "refute"
  );
}

function adaptContradiction(draft: SupportDraft, candidate: SupportCandidateReceiptV1): void {
  const contradiction = candidate.contradiction;
  if (contradiction === undefined || contradiction.status === "unavailable") return;
  const propositionId = contradiction.value.proposition_id;
  if (propositionId === undefined) return;
  addNode(draft, "proposition", propositionId);
  if (candidate.evidence_ids?.[0] !== undefined) {
    addNode(draft, "evidence_unit", candidate.evidence_ids[0]);
    addEdge(
      draft,
      "refutes",
      "evidence_unit",
      candidate.evidence_ids[0],
      "proposition",
      propositionId
    );
  }
  vote(draft, propositionId, contradiction.value.lineage_id, "refute");
}

function adaptSupersession(draft: SupportDraft, candidate: SupportCandidateReceiptV1): void {
  const supersession = candidate.supersession;
  if (supersession === undefined || supersession.status === "unavailable") return;
  if (supersession.value.standing !== "superseded") return;
  const propositionId = supersession.value.proposition_id;
  if (propositionId === undefined) return;
  supersedeLineage(draft, propositionId, supersession.value.lineage_id);
}

function polarityOf(
  support: ReadonlySet<string>,
  refute: ReadonlySet<string>,
  superseded: ReadonlySet<string>
): FourValuedPolarity {
  const liveSupport = active(support, superseded);
  const liveRefute = active(refute, superseded);
  if (liveSupport && liveRefute) return "both";
  if (liveSupport) return "supported_only";
  if (liveRefute) return "refuted_only";
  return "unknown";
}

function active(votes: ReadonlySet<string>, superseded: ReadonlySet<string>): boolean {
  for (const lineage of votes) {
    if (!superseded.has(lineage)) return true;
  }
  return false;
}
