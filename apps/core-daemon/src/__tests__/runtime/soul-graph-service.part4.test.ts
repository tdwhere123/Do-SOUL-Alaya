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

describe("deriveDomainTagSummary", () => {
  it("returns just the count when members is empty", () => {
    expect(deriveDomainTagSummary([])).toBe("0 memories");
  });

  it("collapses a uniform bucket to 'all: <label>' so the same string is not repeated", () => {
    const sameContent = "Codex memory recall shard (2026-04-12)";
    const members = Array.from({ length: 226 }, (_, i) =>
      createMemory({ object_id: `chunk-${i}`, content: sameContent, domain_tags: [] })
    );
    const summary = deriveDomainTagSummary(members as unknown as readonly MemoryEntryRecord[]);
    expect(summary).toMatch(/^226 memories · all: Codex memory recall shard/);
    // Two raw "Codex memory recall shard" occurrences in a row would be the
    // pre-dedupe regression (one from "all:" prefix, one from a duplicated
    // sample slot). Assert the phrase appears exactly once.
    const occurrences = (summary.match(/Codex memory recall shard/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("lists distinct labels and surfaces a +N more variants tail when heterogeneous", () => {
    const members = [
      createMemory({ object_id: "a", content: "Alpha topic line", domain_tags: [] }),
      createMemory({ object_id: "b", content: "Bravo topic line", domain_tags: [] }),
      createMemory({ object_id: "c", content: "Charlie topic line", domain_tags: [] }),
      createMemory({ object_id: "d", content: "Delta topic line", domain_tags: [] }),
      createMemory({ object_id: "e", content: "Echo topic line", domain_tags: [] })
    ];
    const summary = deriveDomainTagSummary(members as unknown as readonly MemoryEntryRecord[]);
    expect(summary).toMatch(/^5 memories · /);
    expect(summary).toContain("Alpha topic line");
    expect(summary).toContain("Bravo topic line");
    expect(summary).toContain("Charlie topic line");
    expect(summary).toMatch(/\+2 more variants$/);
    expect(summary).not.toContain("Delta topic line");
    expect(summary).not.toContain("Echo topic line");
  });

  it("uses singular 'variant' when exactly one is hidden", () => {
    const members = [
      createMemory({ object_id: "a", content: "Alpha topic line", domain_tags: [] }),
      createMemory({ object_id: "b", content: "Bravo topic line", domain_tags: [] }),
      createMemory({ object_id: "c", content: "Charlie topic line", domain_tags: [] }),
      createMemory({ object_id: "d", content: "Delta topic line", domain_tags: [] })
    ];
    const summary = deriveDomainTagSummary(members as unknown as readonly MemoryEntryRecord[]);
    expect(summary).toMatch(/\+1 more variant$/);
  });
});
