import { nodeKey } from "../identity.js";
import type { SupportEdgeKind, SupportEdgeV1, SupportNodeKind, SupportNodeV1 } from
  "../types.js";
import type {
  SupportMaterializationOutcomeV1,
  SupportObservabilityGapV1
} from "./types.js";

export type PolarityVotes = Readonly<{
  readonly support: Set<string>;
  readonly refute: Set<string>;
  readonly superseded: Set<string>;
}>;

export type CandidatePolarityVotes = Readonly<{
  readonly candidateId: string;
  readonly propositionId: string;
  readonly hypothesisDigest: string | null;
  readonly votes: PolarityVotes;
  readonly provenance: { source_id: string; producer: string }[];
}>;

export type SupportDraft = {
  readonly nodes: Map<string, SupportNodeV1>;
  readonly edges: Map<string, SupportEdgeV1>;
  readonly gaps: SupportObservabilityGapV1[];
  readonly outcomes: SupportMaterializationOutcomeV1[];
  readonly votes: Map<string, PolarityVotes>;
  readonly candidateVotes: Map<string, CandidatePolarityVotes>;
  readonly evidenceLineages: Map<string, Set<string>>;
};

export function createDraft(): SupportDraft {
  return {
    nodes: new Map(),
    edges: new Map(),
    gaps: [],
    outcomes: [],
    votes: new Map(),
    candidateVotes: new Map(),
    evidenceLineages: new Map()
  };
}

export function addOutcome(
  draft: SupportDraft,
  outcome: SupportMaterializationOutcomeV1
): void {
  draft.outcomes.push(Object.freeze(outcome));
}

export function addNode(draft: SupportDraft, kind: SupportNodeKind, id: string): void {
  const node = { kind, id };
  draft.nodes.set(nodeKey(kind, id), node);
}

export function addEdge(
  draft: SupportDraft,
  kind: SupportEdgeKind,
  fromKind: SupportNodeKind,
  fromId: string,
  toKind: SupportNodeKind,
  toId: string
): void {
  const edge: SupportEdgeV1 = {
    kind,
    from: { kind: fromKind, id: fromId },
    to: { kind: toKind, id: toId }
  };
  const key = [kind, fromKind, fromId, toKind, toId].join("\0");
  draft.edges.set(key, edge);
}

export function addGap(
  draft: SupportDraft,
  kind: SupportObservabilityGapV1["kind"],
  owner: string,
  detail: string
): void {
  draft.gaps.push(Object.freeze({ kind, owner, detail }));
}

export function recordEvidenceLineage(
  draft: SupportDraft,
  evidenceId: string,
  lineageId: string
): void {
  const lineages = draft.evidenceLineages.get(evidenceId) ?? new Set<string>();
  lineages.add(lineageId);
  draft.evidenceLineages.set(evidenceId, lineages);
}

export function noteApplicableProposition(
  draft: SupportDraft,
  candidateId: string,
  hypothesisDigest: string | null,
  propositionId: string,
  provenance: Readonly<{ readonly source_id: string; readonly producer: string }>
): CandidatePolarityVotes {
  const row = candidateVotesFor(draft, candidateId, hypothesisDigest, propositionId);
  if (!row.provenance.some((entry) =>
    entry.source_id === provenance.source_id && entry.producer === provenance.producer)) {
    row.provenance.push({ source_id: provenance.source_id, producer: provenance.producer });
  }
  return row;
}

export function vote(
  draft: SupportDraft,
  candidateId: string,
  hypothesisDigest: string | undefined,
  propositionId: string,
  lineageId: string,
  side: "support" | "refute"
): void {
  const row = votesFor(draft, propositionId);
  row[side].add(lineageId);
  const candidateVotes = noteApplicableProposition(
    draft,
    candidateId,
    hypothesisDigest ?? null,
    propositionId,
    { source_id: lineageId, producer: "support.polarity.receipt.v1" }
  ).votes;
  candidateVotes[side].add(lineageId);
  if (row.superseded.has(lineageId)) candidateVotes.superseded.add(lineageId);
}

export function supersedeLineage(
  draft: SupportDraft,
  propositionId: string,
  lineageId: string
): void {
  votesFor(draft, propositionId).superseded.add(lineageId);
  for (const row of draft.candidateVotes.values()) {
    if (row.propositionId !== propositionId) continue;
    if (!row.votes.support.has(lineageId) && !row.votes.refute.has(lineageId)) continue;
    row.votes.superseded.add(lineageId);
  }
}

function candidateVotesFor(
  draft: SupportDraft,
  candidateId: string,
  hypothesisDigest: string | null,
  propositionId: string
): CandidatePolarityVotes {
  const key = [candidateId, hypothesisDigest ?? "unbound", propositionId].join("\0");
  const existing = draft.candidateVotes.get(key);
  if (existing !== undefined) return existing;
  const created = {
    candidateId,
    propositionId,
    hypothesisDigest,
    votes: emptyVotes(),
    provenance: []
  };
  draft.candidateVotes.set(key, created);
  return created;
}

function votesFor(draft: SupportDraft, propositionId: string): PolarityVotes {
  const existing = draft.votes.get(propositionId);
  if (existing !== undefined) return existing;
  const created = emptyVotes();
  draft.votes.set(propositionId, created);
  return created;
}

function emptyVotes(): PolarityVotes {
  return {
    support: new Set(),
    refute: new Set(),
    superseded: new Set()
  };
}
