import { describe, expect, it } from "vitest";
import {
  classifySoulGraphOriginKind,
  createSoulGraphService
} from "../daemon-runtime-support.js";
import { MemoryGovernanceEventType, type EventLogEntry, type PathRelation } from "@do-soul/alaya-protocol";
import type {
  SqliteMemoryEntryRepo,
  SqliteMemoryGraphEdgeRepo,
  ProposalRepo,
  PathRelationRepo
} from "@do-soul/alaya-storage";

type SoulGraphProposalRepo = Pick<
  ProposalRepo,
  "findPendingSummaries" | "countPending" | "countPendingMemoryTargetEdges"
>;

describe("createSoulGraphService", () => {
  it("projects shared domain tags as read-only scope nodes and belongs_to edges", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({
            object_id: "memory-a",
            content: "First line summary\n\nSecond paragraph with more details about tooling.",
            domain_tags: ["tooling", "workflow"]
          }),
          createMemory({
            object_id: "memory-b",
            content: "memory-b content",
            domain_tags: ["tooling"]
          })
        ]
      } as unknown as SqliteMemoryEntryRepo,
      memoryGraphEdgeRepo: {
        findByWorkspace: async () => []
      } as unknown as SqliteMemoryGraphEdgeRepo,
      pathRelationRepo: {
        findActive: async () => []
      } as unknown as Pick<PathRelationRepo, "findActive">,
      proposalRepo: {
        findPendingSummaries: async () => [],
        countPending: async () => 0,
        countPendingMemoryTargetEdges: async () => 0
      } as unknown as SoulGraphProposalRepo,
      eventLogRepo: emptyEventLogRepo()
    });

    const graph = await service.buildSoulGraph({
      workspaceId: "default",
      depth: 2,
      limit: 10
    });

    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "memory-a",
          kind: "memory",
          label: "First line summary",
          scope_id: "project",
          origin_plane: "project"
        }),
        expect.objectContaining({
          id: "memory-b",
          kind: "memory",
          label: "memory-b content"
        }),
        expect.objectContaining({
          id: "scope:domain_tag:tooling",
          kind: "scope",
          label: "#tooling",
          scope_id: "domain_tag:tooling"
        })
      ])
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "domain_tag:memory-a:tooling",
          kind: "belongs_to",
          source_id: "memory-a",
          target_id: "scope:domain_tag:tooling"
        }),
        expect.objectContaining({
          id: "domain_tag:memory-b:tooling",
          kind: "belongs_to",
          source_id: "memory-b",
          target_id: "scope:domain_tag:tooling"
        })
      ])
    );
    expect(graph.edge_total).toBe(3);
  });

  it("makes memory node labels and summaries non-redundant", async () => {
    const longContent = "Headline of the memory\n" + "x".repeat(400);
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({
            object_id: "long-memory",
            content: longContent,
            domain_tags: []
          }),
          createMemory({
            object_id: "short-memory",
            content: "tiny",
            domain_tags: []
          })
        ]
      } as unknown as SqliteMemoryEntryRepo,
      memoryGraphEdgeRepo: {
        findByWorkspace: async () => []
      } as unknown as SqliteMemoryGraphEdgeRepo,
      pathRelationRepo: {
        findActive: async () => []
      } as unknown as Pick<PathRelationRepo, "findActive">,
      proposalRepo: {
        findPendingSummaries: async () => [],
        countPending: async () => 0,
        countPendingMemoryTargetEdges: async () => 0
      } as unknown as SoulGraphProposalRepo,
      eventLogRepo: emptyEventLogRepo()
    });

    const graph = await service.buildSoulGraph({
      workspaceId: "default",
      depth: 2,
      limit: 10
    });

    const longNode = graph.nodes.find((n) => n.id === "long-memory");
    expect(longNode).toBeDefined();
    expect(longNode?.label).toBe("Headline of the memory");
    expect(longNode?.summary).toBeDefined();
    expect(longNode?.summary).not.toBe(longNode?.label);
    expect(longNode?.summary?.length).toBeLessThanOrEqual(280);
    expect(longNode?.summary?.endsWith("…")).toBe(true);

    // Short content where label already covers everything: no redundant summary.
    const shortNode = graph.nodes.find((n) => n.id === "short-memory");
    expect(shortNode?.label).toBe("tiny");
    expect(shortNode?.summary).toBeUndefined();
  });

  it("derives origin_plane from scope_class for global memories", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({
            object_id: "global-memory",
            content: "Global core knowledge",
            domain_tags: [],
            scope_class: "global_core"
          })
        ]
      } as unknown as SqliteMemoryEntryRepo,
      memoryGraphEdgeRepo: {
        findByWorkspace: async () => []
      } as unknown as SqliteMemoryGraphEdgeRepo,
      pathRelationRepo: {
        findActive: async () => []
      } as unknown as Pick<PathRelationRepo, "findActive">,
      proposalRepo: {
        findPendingSummaries: async () => [],
        countPending: async () => 0,
        countPendingMemoryTargetEdges: async () => 0
      } as unknown as SoulGraphProposalRepo,
      eventLogRepo: emptyEventLogRepo()
    });

    const graph = await service.buildSoulGraph({
      workspaceId: "default",
      depth: 2,
      limit: 10
    });

    expect(graph.nodes[0]).toMatchObject({
      id: "global-memory",
      origin_plane: "global",
      scope_id: "global_core"
    });
  });

  it("describes domain tag scope nodes with member sample summary", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({
            object_id: "m1",
            content: "Rust tooling notes",
            domain_tags: ["tooling"]
          }),
          createMemory({
            object_id: "m2",
            content: "Vitest workflow",
            domain_tags: ["tooling"]
          })
        ]
      } as unknown as SqliteMemoryEntryRepo,
      memoryGraphEdgeRepo: {
        findByWorkspace: async () => []
      } as unknown as SqliteMemoryGraphEdgeRepo,
      pathRelationRepo: {
        findActive: async () => []
      } as unknown as Pick<PathRelationRepo, "findActive">,
      proposalRepo: {
        findPendingSummaries: async () => [],
        countPending: async () => 0,
        countPendingMemoryTargetEdges: async () => 0
      } as unknown as SoulGraphProposalRepo,
      eventLogRepo: emptyEventLogRepo()
    });

    const graph = await service.buildSoulGraph({
      workspaceId: "default",
      depth: 2,
      limit: 10
    });

    const tagNode = graph.nodes.find((n) => n.id === "scope:domain_tag:tooling");
    expect(tagNode?.summary).toBe("2 memories · Rust tooling notes · Vitest workflow");
  });

  it("projects origin details, influence counts, pending proposals, and path relation strength", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({
            object_id: "memory-a",
            content: "User preference",
            domain_tags: [],
            source_kind: "user",
            formation_kind: "explicit",
            confidence: 0.72,
            last_used_at: "2026-05-05T01:00:00.000Z",
            last_hit_at: "2026-05-05T02:00:00.000Z",
            evidence_refs: ["evidence-1"]
          }),
          createMemory({
            object_id: "memory-b",
            content: "Imported Codex memory",
            domain_tags: [],
            source_kind: "import",
            formation_kind: "imported",
            evidence_refs: ["/home/tdwhere/.codex/memories/MEMORY.md:10"]
          }),
          createMemory({
            object_id: "memory-c",
            content: "Compiler memory later accepted by a reviewer",
            domain_tags: [],
            source_kind: "compiler",
            formation_kind: "extracted"
          })
        ]
      } as unknown as SqliteMemoryEntryRepo,
      memoryGraphEdgeRepo: {
        findByWorkspace: async () => []
      } as unknown as SqliteMemoryGraphEdgeRepo,
      pathRelationRepo: {
        findActive: async () => [
          createPathRelation({
            path_id: "path-a-b",
            source_object_id: "memory-a",
            target_object_id: "memory-b",
            strength: 1.5,
            support_events_count: 3,
            stability_class: "stable",
            last_reinforced_at: "2026-05-05T03:00:00.000Z"
          })
        ]
      } as unknown as Pick<PathRelationRepo, "findActive">,
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
      eventLogRepo: {
        queryByWorkspaceAndType: async () => [createMemoryUpdatedEvent("memory-c")]
      }
    });

    const graph = await service.buildSoulGraph({
      workspaceId: "default",
      depth: 2,
      limit: 10
    });

    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "memory-a",
          origin_kind: "user_memory",
          evidence_refs: ["evidence-1"],
          confidence: 0.72,
          last_used_at: "2026-05-05T01:00:00.000Z",
          last_hit_at: "2026-05-05T02:00:00.000Z",
          influence_count: 4
        }),
        expect.objectContaining({
          id: "memory-b",
          origin_kind: "engineering_chunk",
          influence_count: 4
        }),
        expect.objectContaining({
          id: "memory-c",
          origin_kind: "user_memory",
          rationale: "Human-reviewed proposal applied to this memory."
        }),
        expect.objectContaining({
          id: "proposal:proposal-1",
          kind: "projection",
          origin_kind: "proposal_pending"
        })
      ])
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "path-a-b",
          source_id: "memory-a",
          target_id: "memory-b",
          weight: 1,
          strength_normalized: 1,
          stability_class: "stable",
          last_reinforced_at: "2026-05-05T03:00:00.000Z"
        }),
        expect.objectContaining({
          id: "proposal:proposal-1:target",
          kind: "derived_from",
          source_id: "proposal:proposal-1",
          target_id: "memory-a"
        })
      ])
    );
  });

  it("classifies graph origin kind through explicit boundary cases", () => {
    expect(
      classifySoulGraphOriginKind(
        createMemory({
          object_id: "user",
          domain_tags: [],
          source_kind: "review",
          formation_kind: "explicit"
        })
      )
    ).toBe("user_memory");
    expect(
      classifySoulGraphOriginKind(
        createMemory({
          object_id: "codex",
          domain_tags: [],
          source_kind: "import",
          formation_kind: "imported",
          evidence_refs: ["/home/tdwhere/.codex/memories/MEMORY.md:1"]
        })
      )
    ).toBe("engineering_chunk");
    expect(
      classifySoulGraphOriginKind(
        createMemory({
          object_id: "seed",
          domain_tags: [],
          source_kind: "seed",
          formation_kind: "derived"
        })
      )
    ).toBe("system");
    expect(
      classifySoulGraphOriginKind(
        createMemory({
          object_id: "proposal-accepted",
          domain_tags: [],
          source_kind: "compiler",
          formation_kind: "extracted"
        }),
        true
      )
    ).toBe("user_memory");
  });

  // M-6 (Phase 2 review-loop): a Codex-origin entry that has been
  // reviewer-accepted is its own classification — neither plain
  // "engineering_chunk" (loses governance signal) nor "user_memory" (loses
  // attribution). The classifier must resolve to "reviewed_engineering_chunk"
  // so the graph view tells the operator both facts.
  it("returns reviewed_engineering_chunk for an engineering-origin memory after proposal accept", () => {
    expect(
      classifySoulGraphOriginKind(
        createMemory({
          object_id: "codex-then-accepted",
          domain_tags: [],
          source_kind: "import",
          formation_kind: "imported",
          evidence_refs: ["/home/tdwhere/.codex/memories/MEMORY.md:42"]
        }),
        true
      )
    ).toBe("reviewed_engineering_chunk");
    // Without the reviewer accept the same entry stays "engineering_chunk".
    expect(
      classifySoulGraphOriginKind(
        createMemory({
          object_id: "codex-pending",
          domain_tags: [],
          source_kind: "import",
          formation_kind: "imported",
          evidence_refs: ["/home/tdwhere/.codex/memories/MEMORY.md:42"]
        })
      )
    ).toBe("engineering_chunk");
  });

  // M-2 (Phase 2 review-loop): under graph limit pressure, PathRelation
  // edges (richer dynamics metadata: strength, stability, last_reinforced_at)
  // claim slots first; legacy memoryGraphEdge rows fill the remainder. This
  // pin test surfaces any future re-order in a single test diff.
  it("prefers PathRelation edges over legacy edges under limit pressure", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({ object_id: "memory-a", domain_tags: [] }),
          createMemory({ object_id: "memory-b", domain_tags: [] })
        ]
      } as unknown as SqliteMemoryEntryRepo,
      memoryGraphEdgeRepo: {
        findByWorkspace: async () => [
          {
            edge_id: "legacy-edge-1",
            source_memory_id: "memory-a",
            target_memory_id: "memory-b",
            edge_type: "explicit",
            workspace_id: "default",
            created_at: "2026-05-05T00:00:00.000Z"
          }
        ]
      } as unknown as SqliteMemoryGraphEdgeRepo,
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

    // 4 PathRelation edges fit within the limit; legacy edge is starved out.
    const pathEdges = graph.edges.filter((edge) => edge.id.startsWith("path-"));
    const legacyEdges = graph.edges.filter((edge) => edge.id === "legacy-edge-1");
    expect(pathEdges).toHaveLength(4);
    expect(legacyEdges).toHaveLength(0);
    expect(graph.truncated).toBe(true);
  });

  // M-3 (Phase 2 review-loop): pending-proposal projection nodes and domain-tag
  // projection scope nodes share kind="projection". Their ids must stay in
  // disjoint namespaces ("proposal:" vs "scope:domain_tag:") so the inspector
  // can never collide a proposal node with a tag-named-"proposal:foo".
  it("keeps proposal projection ids in a different namespace from domain-tag scope ids", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [
          createMemory({ object_id: "memory-a", domain_tags: ["tooling", "workflow"] }),
          createMemory({ object_id: "memory-b", domain_tags: ["tooling"] })
        ]
      } as unknown as SqliteMemoryEntryRepo,
      memoryGraphEdgeRepo: { findByWorkspace: async () => [] } as unknown as SqliteMemoryGraphEdgeRepo,
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
    // Every proposal projection id starts with "proposal:" and every shared
    // tag scope node id starts with "scope:domain_tag:" — disjoint namespaces.
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

  // M-4 (Phase 2 review-loop): node_total / edge_total must reflect TRUE
  // counts even when findPendingSummaries SQL-LIMITs. Pin behavior: even
  // with limit=10 and 25 pending proposals in storage, node_total includes
  // all 25 (via cheap COUNT(*) via countPending), and truncated=true.
  it("reports raw pending proposal count in node_total even when LIMIT clips the summary list", async () => {
    const service = createSoulGraphService({
      memoryEntryRepo: {
        findByWorkspaceId: async () => [createMemory({ object_id: "memory-a", domain_tags: [] })]
      } as unknown as SqliteMemoryEntryRepo,
      memoryGraphEdgeRepo: { findByWorkspace: async () => [] } as unknown as SqliteMemoryGraphEdgeRepo,
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
    last_hit_at: overrides.last_hit_at ?? null
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
