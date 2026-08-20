import {
  DYNAMICS_CONSTANTS,
  type EventLogEntry,
  type PathAnchorRef,
  type PathRelation,
  type SoulGraph,
  type SoulGraphOriginKind
} from "@do-soul/alaya-protocol";
import type { ProposalRepo, SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";

export type SoulGraphMemoryEntryRecord =
  Awaited<ReturnType<SqliteMemoryEntryRepo["findByWorkspaceId"]>>[number];

export function classifySoulGraphOriginKind(
  memory: Pick<
    SoulGraphMemoryEntryRecord,
    | "source_kind"
    | "formation_kind"
    | "created_by"
    | "evidence_refs"
    | "content"
    | "domain_tags"
    | "run_id"
  >,
  hasAcceptedProposalApply = false
): SoulGraphOriginKind {
  const isUserOrigin = memory.source_kind === "user" || memory.source_kind === "review";
  if (isUserOrigin) {
    return "user_memory";
  }

  const tagsContainCodex = memory.domain_tags.some((tag) =>
    tag.toLowerCase().includes("codex-memory-import")
  );
  const runIdMarksCodex = memory.run_id.toLowerCase().includes("codex-memory-import");
  const contentMentionsCodexMemories = memory.content.includes(".codex/memories");

  const isEngineeringOrigin =
    memory.source_kind === "import" ||
    memory.formation_kind === "imported" ||
    memory.created_by.toLowerCase().includes("codex") ||
    memory.evidence_refs.some((ref) => ref.includes(".codex/memories")) ||
    tagsContainCodex ||
    runIdMarksCodex ||
    contentMentionsCodexMemories;

  if (isEngineeringOrigin) {
    return hasAcceptedProposalApply ? "reviewed_engineering_chunk" : "engineering_chunk";
  }
  return hasAcceptedProposalApply ? "user_memory" : "system";
}

export function buildUserReviewedMemoryIds(events: readonly EventLogEntry[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (
      event.entity_type === "memory_entry" &&
      event.caused_by?.startsWith("proposal_accept:") === true
    ) {
      ids.add(event.entity_id);
    }
  }
  return ids;
}

export function deriveMemoryRationale(
  memory: Pick<SoulGraphMemoryEntryRecord, "source_kind" | "formation_kind">,
  hasAcceptedProposalApply: boolean
): string {
  if (hasAcceptedProposalApply) {
    return "Human-reviewed proposal applied to this memory.";
  }
  if (memory.source_kind === "user" || memory.source_kind === "review") {
    return "Explicit user or reviewer-governed memory.";
  }
  if (memory.source_kind === "import" || memory.formation_kind === "imported") {
    return "Imported engineering context.";
  }
  return memory.source_kind === "seed"
    ? "System bootstrap seed."
    : "Compiled from governed runtime signals.";
}

export function buildPathRelationEdges(
  relations: readonly Readonly<PathRelation>[],
  memoryIds: ReadonlySet<string>
): readonly SoulGraph["edges"][number][] {
  return relations.flatMap((relation) => {
    const sourceId = anchorMemoryId(relation.anchors.source_anchor);
    const targetId = anchorMemoryId(relation.anchors.target_anchor);
    if (
      sourceId === undefined ||
      targetId === undefined ||
      !memoryIds.has(sourceId) ||
      !memoryIds.has(targetId) ||
      sourceId === targetId
    ) {
      return [];
    }
    const strength = normalizePathStrength(relation.plasticity_state.strength);
    return [
      {
        id: relation.path_id,
        kind: "references" as const,
        source_id: sourceId,
        target_id: targetId,
        weight: strength,
        strength_normalized: strength,
        stability_class: relation.plasticity_state.stability_class,
        last_reinforced_at: relation.plasticity_state.last_reinforced_at,
        created_at: relation.created_at
      }
    ];
  });
}

export function buildInfluenceCounts(
  relations: readonly Readonly<PathRelation>[]
): ReadonlyMap<string, number> {
  const influence = new Map<string, number>();
  for (const relation of relations) {
    const anchors = new Set(
      [relation.anchors.source_anchor, relation.anchors.target_anchor]
        .map(anchorMemoryId)
        .filter((id): id is string => id !== undefined)
    );
    const increment = 1 + relation.plasticity_state.support_events_count;
    for (const memoryId of anchors) {
      influence.set(memoryId, (influence.get(memoryId) ?? 0) + increment);
    }
  }
  return influence;
}

export function buildPendingProposalProjection(
  proposals: Awaited<ReturnType<ProposalRepo["findPendingSummaries"]>>,
  memoryIds: ReadonlySet<string>
): {
  readonly nodes: readonly SoulGraph["nodes"][number][];
  readonly edges: readonly SoulGraph["edges"][number][];
  readonly total_edges: number;
} {
  const nodes: SoulGraph["nodes"][number][] = [];
  const edges: SoulGraph["edges"][number][] = [];

  for (const proposal of proposals) {
    const proposalNodeId = `proposal:${proposal.proposal_id}`;
    nodes.push({
      id: proposalNodeId,
      kind: "projection",
      label: `Proposal ${proposal.proposal_id}`,
      ...(proposal.proposed_change_summary.length === 0
        ? {}
        : { summary: proposal.proposed_change_summary }),
      created_at: proposal.created_at,
      scope_id: proposal.target_object_id,
      origin_kind: "proposal_pending"
    });
    if (memoryIds.has(proposal.target_object_id)) {
      edges.push({
        id: `proposal:${proposal.proposal_id}:target`,
        kind: "derived_from",
        source_id: proposalNodeId,
        target_id: proposal.target_object_id,
        created_at: proposal.created_at
      });
    }
  }

  return { nodes, edges, total_edges: edges.length };
}

export function countPathRelationEdges(
  relations: readonly Readonly<PathRelation>[],
  memoryIds: ReadonlySet<string>
): number {
  return relations.reduce((count, relation) => {
    const sourceId = anchorMemoryId(relation.anchors.source_anchor);
    const targetId = anchorMemoryId(relation.anchors.target_anchor);
    return sourceId !== undefined &&
      targetId !== undefined &&
      sourceId !== targetId &&
      memoryIds.has(sourceId) &&
      memoryIds.has(targetId)
      ? count + 1
      : count;
  }, 0);
}

function anchorMemoryId(anchor: PathAnchorRef): string | undefined {
  switch (anchor.kind) {
    case "object":
    case "object_facet":
      return anchor.object_id;
    case "obligation":
    case "risk_concern":
    case "time_concern":
      return anchor.source_object_id;
    default:
      return undefined;
  }
}

function normalizePathStrength(value: number): number {
  const floor = DYNAMICS_CONSTANTS.path_plasticity.strength_floor;
  const ceiling = DYNAMICS_CONSTANTS.path_plasticity.strength_ceiling;
  if (ceiling <= floor) {
    return clamp01(value);
  }
  return clamp01((value - floor) / (ceiling - floor));
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function buildDomainTagProjection(memories: readonly SoulGraphMemoryEntryRecord[]): {
  readonly nodes: readonly SoulGraph["nodes"][number][];
  readonly edges: readonly SoulGraph["edges"][number][];
} {
  const tagMembers = new Map<string, SoulGraphMemoryEntryRecord[]>();
  const tagEdges: SoulGraph["edges"][number][] = [];

  for (const memory of memories) {
    for (const tag of uniqueDomainTags(memory)) {
      let members = tagMembers.get(tag);
      if (!members) {
        members = [];
        tagMembers.set(tag, members);
      }
      members.push(memory);
      tagEdges.push({
        id: `domain_tag:${memory.object_id}:${tag}`,
        kind: "belongs_to",
        source_id: memory.object_id,
        target_id: domainTagNodeId(tag),
        created_at: memory.created_at
      });
    }
  }

  return {
    nodes: [...tagMembers.entries()].map(([tag, members]) => ({
      id: domainTagNodeId(tag),
      kind: "scope",
      label: `#${tag}`,
      summary: deriveDomainTagSummary(members),
      scope_id: `domain_tag:${tag}`,
      origin_plane: "project"
    })),
    edges: tagEdges
  };
}

const MEMORY_NODE_LABEL_MAX = 80;
const MEMORY_NODE_SUMMARY_MAX = 280;
const DOMAIN_TAG_SAMPLE_LIMIT = 3;
const DOMAIN_TAG_SAMPLE_LABEL_MAX = 32;

export function deriveMemoryNodeLabel(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length > 0) {
    return truncateWithEllipsis(firstLine, MEMORY_NODE_LABEL_MAX);
  }
  const fallback = content.trim();
  return fallback.length === 0 ? "(empty)" : truncateWithEllipsis(fallback, MEMORY_NODE_LABEL_MAX);
}

export function deriveMemoryNodeSummary(content: string, label: string): string | undefined {
  const trimmed = content.trim();
  return trimmed.length === 0 || trimmed === label
    ? undefined
    : truncateWithEllipsis(trimmed, MEMORY_NODE_SUMMARY_MAX);
}

export function deriveDomainTagSummary(members: readonly SoulGraphMemoryEntryRecord[]): string {
  const count = members.length;
  const distinctLabels: string[] = [];
  const seenLabels = new Set<string>();
  for (const member of members) {
    const sample = truncateWithEllipsis(deriveMemoryNodeLabel(member.content), DOMAIN_TAG_SAMPLE_LABEL_MAX);
    if (!seenLabels.has(sample)) {
      seenLabels.add(sample);
      distinctLabels.push(sample);
    }
  }
  const noun = count === 1 ? "memory" : "memories";
  if (distinctLabels.length === 0) {
    return `${count} ${noun}`;
  }
  if (distinctLabels.length === 1 && count > 1) {
    return `${count} ${noun} · all: ${distinctLabels[0]}`;
  }
  const visible = distinctLabels.slice(0, DOMAIN_TAG_SAMPLE_LIMIT);
  const remainingVariants = distinctLabels.length - visible.length;
  const tail =
    remainingVariants > 0
      ? ` · +${remainingVariants} more variant${remainingVariants === 1 ? "" : "s"}`
      : "";
  return `${count} ${noun} · ${visible.join(" · ")}${tail}`;
}

function truncateWithEllipsis(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function uniqueDomainTags(memory: SoulGraphMemoryEntryRecord): readonly string[] {
  const tags = Array.isArray(memory.domain_tags) ? memory.domain_tags : [];
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

export function countUniqueDomainTags(memories: readonly SoulGraphMemoryEntryRecord[]): number {
  return new Set(memories.flatMap((memory) => uniqueDomainTags(memory))).size;
}

export function countDomainTagEdges(memories: readonly SoulGraphMemoryEntryRecord[]): number {
  return memories.reduce((count, memory) => count + uniqueDomainTags(memory).length, 0);
}

function domainTagNodeId(tag: string): string {
  return `scope:domain_tag:${tag}`;
}
