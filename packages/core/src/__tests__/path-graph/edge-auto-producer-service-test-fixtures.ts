import { vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type { PathMintOutcome } from "../../path-graph/path-relation-proposal-service.js";

// Minimal active positive-associative PathRelation for the applyVerdict
// directional-dedup tests; only the fields the dedup guard reads
// (anchors, effect_vector.recall_bias, lifecycle.status) are load-bearing.
export function makePositiveAssociativePath(
  relationKind: string,
  sourceObjectId: string,
  targetObjectId: string
): Readonly<PathRelation> {
  return {
    anchors: {
      source_anchor: { kind: "object", object_id: sourceObjectId },
      target_anchor: { kind: "object", object_id: targetObjectId }
    },
    constitution: { relation_kind: relationKind },
    effect_vector: { recall_bias: 0.5 },
    lifecycle: { status: "active" }
  } as unknown as Readonly<PathRelation>;
}

// Structural shape the assertions read off the submitCandidate fake; the
// full SubmitCandidateInput is wider but these are the fields under test.
interface SubmittedCandidate {
  readonly relationKind: string;
  readonly recallBiasSign: 1 | 0 | -1;
  readonly governanceClass?: string;
  readonly initialStrength?: number;
  readonly why?: readonly string[];
}

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-new",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-24T12:00:00.000Z",
    updated_at: "2026-05-24T12:00:00.000Z",
    created_by: "test",
    dimension: MemoryDimension.FACT,
    source_kind: "compiler",
    formation_kind: "extracted",
    scope_class: ScopeClass.PROJECT,
    content: "RTK wrapper is required for shell commands in this repository.",
    domain_tags: ["rtk", "workflow"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.6,
    retention_score: 0.6,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.8,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

export function createDeps(memories: readonly MemoryEntry[]) {
  const byId = new Map(memories.map((memory) => [memory.object_id, memory]));
  const searchByKeyword = vi.fn(async (_workspaceId: string, _queryText: string, _limit: number) =>
    memories
      .filter((memory) => memory.object_id !== "memory-new")
      .map((memory, index) => ({
        object_id: memory.object_id,
        normalized_rank: 1 - index * 0.1
      }))
  );
  const findByIds = vi.fn(async (objectIds: readonly string[]) =>
    objectIds.flatMap((objectId) => {
      const memory = byId.get(objectId);
      return memory === undefined ? [] : [memory];
    })
  );
  const findById = vi.fn(async (objectId: string) => byId.get(objectId) ?? null);
  const pathCandidatePort = {
    submitCandidate: vi.fn(async (_input: SubmittedCandidate): Promise<PathMintOutcome> => "applied")
  };
  return {
    deps: {
      memoryRepo: { findById, searchByKeyword, findByIds },
      pathCandidatePort
    },
    findById,
    searchByKeyword,
    findByIds,
    pathCandidatePort
  };
}
