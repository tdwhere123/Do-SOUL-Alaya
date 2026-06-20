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

  // invariant: bulk codex-memory-import rows persist source_kind="compiler"
  // and formation_kind="extracted" (not "import" / "imported"), and their
  // evidence_refs hold internal UUIDs rather than file paths. The classifier
  // must still reach engineering_chunk through domain_tags / run_id /
  // content cues so the production graph view does not silently mislabel
  // 226 codex chunks as `system`.
  it("classifies codex-memory-import bulk rows as engineering_chunk via domain_tags / run_id / content", () => {
    const baseShape = {
      object_id: "codex-bulk-1",
      domain_tags: ["codex-memory-import", "smoke"] as readonly string[],
      source_kind: "compiler" as const,
      formation_kind: "extracted" as const,
      created_by: "model_tool",
      evidence_refs: ["75b87846-1351-4c03-9f05-969bbd075032"]
    };
    expect(classifySoulGraphOriginKind(createMemory(baseShape))).toBe("engineering_chunk");

    expect(
      classifySoulGraphOriginKind(
        createMemory({
          ...baseShape,
          object_id: "codex-bulk-2",
          domain_tags: [],
          run_id: "codex-memory-import-smoke-20260505"
        })
      )
    ).toBe("engineering_chunk");

    expect(
      classifySoulGraphOriginKind(
        createMemory({
          ...baseShape,
          object_id: "codex-bulk-3",
          domain_tags: [],
          content: "Codex memory file import (2026-05-05)\nSource: ~/.codex/memories/MEMORY.md\nChunk: 1/11\n..."
        })
      )
    ).toBe("engineering_chunk");
  });

  // invariant: source_kind="user"/"review" beats every soft engineering
  // substring signal. A user note that mentions .codex/memories or carries
  // a "codex-memory-import" tag stays user_memory.
  it("keeps source_kind=user as user_memory even when content / tags / run_id mention codex", () => {
    expect(
      classifySoulGraphOriginKind(
        createMemory({
          object_id: "user-mentions-codex-path",
          source_kind: "user",
          formation_kind: "explicit",
          domain_tags: [],
          content: "I disagree with how we treat ~/.codex/memories — let's revisit."
        })
      )
    ).toBe("user_memory");
    expect(
      classifySoulGraphOriginKind(
        createMemory({
          object_id: "user-with-codex-tag",
          source_kind: "user",
          formation_kind: "explicit",
          domain_tags: ["codex-memory-import-feedback"]
        })
      )
    ).toBe("user_memory");
    expect(
      classifySoulGraphOriginKind(
        createMemory({
          object_id: "review-with-codex-run-id",
          source_kind: "review",
          formation_kind: "explicit",
          domain_tags: [],
          run_id: "codex-memory-import-bug-investigation"
        })
      )
    ).toBe("user_memory");
  });

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
});
