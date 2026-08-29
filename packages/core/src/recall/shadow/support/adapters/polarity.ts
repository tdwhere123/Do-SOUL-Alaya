import { createFourValuedWitness, type FourValuedPolarity, type FourValuedWitness } from
  "../../witness/index.js";
import type { SupportDraft } from "./draft.js";
import { addEdge, addGap, addNode, supersedeLineage, vote } from "./draft.js";
import type { SupportCandidateReceiptV1, SupportSupersessionValueV1 } from "./types.js";

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
  const side = polarity.value.polarity === "positive" ? "support" : "refute";
  voteOnProposition(draft, candidate, propositionId, polarity.value.lineage_id, side);
}

function adaptContradiction(draft: SupportDraft, candidate: SupportCandidateReceiptV1): void {
  const contradiction = candidate.contradiction;
  if (contradiction === undefined || contradiction.status === "unavailable") return;
  const propositionId = contradiction.value.proposition_id;
  if (propositionId === undefined) {
    addGap(draft, "binding_absent", candidate.candidate_key, "contradiction without proposition");
    return;
  }
  voteOnProposition(draft, candidate, propositionId, contradiction.value.lineage_id, "refute");
}

function adaptSupersession(draft: SupportDraft, candidate: SupportCandidateReceiptV1): void {
  const supersession = candidate.supersession;
  if (supersession === undefined || supersession.status === "unavailable") return;
  const value = supersession.value;
  if (value.standing === "superseded" && value.proposition_id !== undefined) {
    addNode(draft, "proposition", value.proposition_id);
    supersedeLineage(draft, value.proposition_id, value.lineage_id);
  }
  if (value.standing === "current" && !hasPropositionPair(value)) return;
  emitSupersedesOrGap(draft, candidate.candidate_key, value);
}

function voteOnProposition(
  draft: SupportDraft,
  candidate: SupportCandidateReceiptV1,
  propositionId: string,
  lineageId: string,
  side: "support" | "refute"
): void {
  addNode(draft, "proposition", propositionId);
  vote(draft, propositionId, lineageId, side);
  const kind = side === "support" ? "supports" : "refutes";
  for (const evidenceId of candidate.evidence_ids ?? []) {
    addNode(draft, "evidence_unit", evidenceId);
    addEdge(draft, kind, "evidence_unit", evidenceId, "proposition", propositionId);
  }
}

function emitSupersedesOrGap(
  draft: SupportDraft,
  owner: string,
  value: SupportSupersessionValueV1
): void {
  const fromId = value.standing === "superseded"
    ? value.counterpart_proposition_id
    : value.proposition_id;
  const toId = value.standing === "superseded"
    ? value.proposition_id
    : value.counterpart_proposition_id;
  if (fromId === undefined || toId === undefined || fromId === toId) {
    addGap(
      draft,
      "supersedes_open",
      owner,
      "supersedes needs two distinct proposition ids; lineage standing is not a pair"
    );
    return;
  }
  addNode(draft, "proposition", fromId);
  addNode(draft, "proposition", toId);
  addEdge(draft, "supersedes", "proposition", fromId, "proposition", toId);
}

function hasPropositionPair(value: SupportSupersessionValueV1): boolean {
  return value.proposition_id !== undefined && value.counterpart_proposition_id !== undefined;
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
