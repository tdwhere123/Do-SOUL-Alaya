import { describe, expect, it } from "vitest";

import {
  classifySoulGraphOriginKind,
  createSoulGraphService,
  deriveDomainTagSummary
} from "../../runtime/daemon-runtime-support.js";

import { MemoryGovernanceEventType, type EventLogEntry, type PathRelation } from "@do-soul/alaya-protocol";

import type {
  SqliteMemoryEntryRepo,
  ProposalRepo,
  PathRelationRepo
} from "@do-soul/alaya-storage";

// invariant: keep this test-local row-shape alias aligned with the daemon's
// runtime memory-entry rows so fixture records match findByWorkspaceId output.
// see also: apps/core-daemon/src/runtime/daemon-runtime-support.ts:MemoryEntryRecord
type MemoryEntryRecord = Awaited<ReturnType<SqliteMemoryEntryRepo["findByWorkspaceId"]>>[number];

type SoulGraphProposalRepo = Pick<
  ProposalRepo,
  "findPendingSummaries" | "countPending" | "countPendingMemoryTargetEdges"
>;

function emptyEventLogRepo() {
  return {
    queryByWorkspaceAndType: async () => []
  };
}

function createMemory(overrides: {
  readonly object_id: string;
  readonly content?: string;
  readonly domain_tags: readonly string[];
  readonly scope_class?: "project" | "global_domain" | "global_core";
  readonly source_kind?: "compiler" | "user" | "seed" | "import" | "review";
  readonly formation_kind?: "extracted" | "explicit" | "inferred" | "derived" | "imported";
  readonly created_by?: string;
  readonly evidence_refs?: readonly string[];
  readonly confidence?: number | null;
  readonly last_used_at?: string | null;
  readonly last_hit_at?: string | null;
  readonly run_id?: string;
}) {
  return {
    object_id: overrides.object_id,
    content: overrides.content ?? `${overrides.object_id} content`,
    workspace_id: "default",
    created_at: "2026-05-05T00:00:00.000Z",
    domain_tags: overrides.domain_tags,
    scope_class: overrides.scope_class ?? "project",
    source_kind: overrides.source_kind ?? "compiler",
    formation_kind: overrides.formation_kind ?? "extracted",
    created_by: overrides.created_by ?? "system",
    evidence_refs: overrides.evidence_refs ?? [],
    confidence: overrides.confidence ?? null,
    last_used_at: overrides.last_used_at ?? null,
    last_hit_at: overrides.last_hit_at ?? null,
    run_id: overrides.run_id ?? "test-run-id"
  };
}

function createPathRelation(overrides: {
  readonly path_id: string;
  readonly source_object_id: string;
  readonly target_object_id: string;
  readonly strength: number;
  readonly support_events_count: number;
  readonly stability_class?: "volatile" | "normal" | "stable" | "pinned";
  readonly last_reinforced_at?: string;
}): PathRelation {
  return {
    path_id: overrides.path_id,
    workspace_id: "default",
    anchors: {
      source_anchor: { kind: "object", object_id: overrides.source_object_id },
      target_anchor: { kind: "object", object_id: overrides.target_object_id }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["test path relation"]
    },
    effect_vector: {
      salience: 0.1,
      recall_bias: 0.1,
      verification_bias: 0.1,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: overrides.strength,
      direction_bias: "source_to_target",
      stability_class: overrides.stability_class ?? "normal",
      support_events_count: overrides.support_events_count,
      contradiction_events_count: 0,
      last_reinforced_at: overrides.last_reinforced_at
    },
    lifecycle: { status: "active", retirement_rule: "default" },
    legitimacy: { evidence_basis: [], governance_class: "recall_allowed" },
    created_at: "2026-05-05T00:00:00.000Z",
    updated_at: "2026-05-05T00:00:00.000Z"
  };
}

function createMemoryUpdatedEvent(memoryId: string): EventLogEntry {
  return {
    event_id: `event-${memoryId}`,
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
    entity_type: "memory_entry",
    entity_id: memoryId,
    workspace_id: "default",
    run_id: "run-1",
    revision: 0,
    caused_by: "proposal_accept:proposal-1",
    payload_json: {
      object_id: memoryId,
      object_kind: "memory_entry",
      workspace_id: "default",
      run_id: "run-1",
      updated_fields: ["content"]
    },
    created_at: "2026-05-05T05:00:00.000Z"
  };
}

describe("createSoulGraphService", () => {

  it("truncates PathRelation edges under limit pressure (path plane is the only edge source)", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({ object_id: "memory-a", domain_tags: [] }),
          createMemory({ object_id: "memory-b", domain_tags: [] })
        ]
      } as unknown as SqliteMemoryEntryRepo,
      pathRelationRepo: {
        findActive: async () =>
          Array.from({ length: 5 }, (_, index) => createPathRelation({
            path_id: `path-${index + 1}`,
            source_object_id: "memory-a",
            target_object_id: "memory-b",
            strength: 0.5,
            support_events_count: 1
          }))
      } as unknown as Pick<PathRelationRepo, "findActive">,
      proposalRepo: {
        findPendingSummaries: async () => [],
        countPending: async () => 0,
        countPendingMemoryTargetEdges: async () => 0
      } as unknown as SoulGraphProposalRepo,
      eventLogRepo: emptyEventLogRepo()
    });

    const graph = await service.buildSoulGraph({ workspaceId: "default", depth: 2, limit: 4 });

    const pathEdges = graph.edges.filter((edge) => edge.id.startsWith("path-"));
    expect(pathEdges).toHaveLength(4);
    expect(graph.truncated).toBe(true);
  });

  it("keeps proposal projection ids in a different namespace from domain-tag scope ids", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({ object_id: "memory-a", domain_tags: ["tooling", "workflow"] }),
          createMemory({ object_id: "memory-b", domain_tags: ["tooling"] })
        ]
      } as unknown as SqliteMemoryEntryRepo,
      pathRelationRepo: { findActive: async () => [] } as unknown as Pick<PathRelationRepo, "findActive">,
      proposalRepo: {
        findPendingSummaries: async () => [
          {
            proposal_id: "proposal-1",
            target_object_id: "memory-a",
            target_object_kind: "memory_entry",
            created_at: "2026-05-05T04:00:00.000Z",
            proposed_change_summary: "Rewrite memory-a",
            proposed_changes: { content: "rewritten" },
            assigned_reviewer_identity: null,
            assigned_at: null,
            deadline_at: null,
            is_overdue: false
          }
        ],
        countPending: async () => 1,
        countPendingMemoryTargetEdges: async () => 1
      } as unknown as SoulGraphProposalRepo,
      eventLogRepo: emptyEventLogRepo()
    });

    const graph = await service.buildSoulGraph({ workspaceId: "default", depth: 2, limit: 50 });
    const proposalNodes = graph.nodes.filter((node) => node.kind === "projection");
    const scopeNodes = graph.nodes.filter((node) => node.kind === "scope");
    expect(proposalNodes.map((node) => node.id)).toEqual(["proposal:proposal-1"]);
    for (const node of proposalNodes) {
      expect(node.id.startsWith("proposal:")).toBe(true);
      expect(node.id.startsWith("scope:domain_tag:")).toBe(false);
    }
    for (const node of scopeNodes) {
      expect(node.id.startsWith("scope:domain_tag:")).toBe(true);
      expect(node.id.startsWith("proposal:")).toBe(false);
    }
    expect(scopeNodes.length).toBeGreaterThan(0);
  });

  it("reports raw pending proposal count in node_total even when LIMIT clips the summary list", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [createMemory({ object_id: "memory-a", domain_tags: [] })]
      } as unknown as SqliteMemoryEntryRepo,
      pathRelationRepo: { findActive: async () => [] } as unknown as Pick<PathRelationRepo, "findActive">,
      proposalRepo: {
        // Simulating the SQL LIMIT: only 10 of the 25 pending rows surface.
        findPendingSummaries: async () =>
          Array.from({ length: 10 }, (_, index) => ({
            proposal_id: `proposal-${index + 1}`,
            target_object_id: "memory-a",
            target_object_kind: "memory_entry",
            created_at: "2026-05-05T04:00:00.000Z",
            proposed_change_summary: `change ${index + 1}`,
            proposed_changes: { content: `c${index + 1}` },
            assigned_reviewer_identity: null,
            assigned_at: null,
            deadline_at: null,
            is_overdue: false
          })),
        countPending: async () => 25,
        countPendingMemoryTargetEdges: async () => 25
      } as unknown as SoulGraphProposalRepo,
      eventLogRepo: emptyEventLogRepo()
    });

    const graph = await service.buildSoulGraph({ workspaceId: "default", depth: 2, limit: 10 });

    // 1 memory + 25 (raw) pending proposals + 0 unique tags = 26.
    expect(graph.node_total).toBe(26);
    expect(graph.edge_total).toBe(25);
    expect(graph.truncated).toBe(true);
  });
});
