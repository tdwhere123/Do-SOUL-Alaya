import { nodeKey } from "../identity.js";
import type { SupportEdgeKind, SupportEdgeV1, SupportNodeKind, SupportNodeV1 } from
  "../types.js";
import type { SupportObservabilityGapV1 } from "./types.js";

export type PolarityVotes = Readonly<{
  readonly support: Set<string>;
  readonly refute: Set<string>;
  readonly superseded: Set<string>;
}>;

export type SupportDraft = {
  readonly nodes: Map<string, SupportNodeV1>;
  readonly edges: Map<string, SupportEdgeV1>;
  readonly gaps: SupportObservabilityGapV1[];
  readonly votes: Map<string, PolarityVotes>;
  readonly evidenceLineage: Map<string, string>;
};

export function createDraft(): SupportDraft {
  return {
    nodes: new Map(),
    edges: new Map(),
    gaps: [],
    votes: new Map(),
    evidenceLineage: new Map()
  };
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

export function vote(
  draft: SupportDraft,
  propositionId: string,
  lineageId: string,
  side: "support" | "refute"
): void {
  const row = votesFor(draft, propositionId);
  row[side].add(lineageId);
}

export function supersedeLineage(
  draft: SupportDraft,
  propositionId: string,
  lineageId: string
): void {
  votesFor(draft, propositionId).superseded.add(lineageId);
}

function votesFor(draft: SupportDraft, propositionId: string): PolarityVotes {
  const existing = draft.votes.get(propositionId);
  if (existing !== undefined) return existing;
  const created: PolarityVotes = {
    support: new Set(),
    refute: new Set(),
    superseded: new Set()
  };
  draft.votes.set(propositionId, created);
  return created;
}
