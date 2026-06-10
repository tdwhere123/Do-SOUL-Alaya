import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import {
  PathRelationProposalService,
  PATH_RELATION_PROPOSE_THRESHOLD,
  type CoUsageCounterPort,
  type MemoryAnchorExistencePort,
  type PathRelationProposalEventPublisherPort,
  type SubmitCandidateInput
} from "../../path-relation-proposal-service.js";

// invariant (codex spine-review B3): an agent/Garden candidate may PROPOSE a
// path, but Alaya DECIDES durable truth. A path object anchor naming a memory
// that is missing from, or owned by a workspace other than, the relation
// workspace must be REFUSED at the durable mint sink — before any
// path_relations row or path.relation_created audit row — and must leave an
// auditable path.relation_rejected trace. submitCandidate is the convergence
// point for both the MCP soul.emit_candidate_signal mint and the Garden
// completion mint, so gating it here covers both untrusted producers.

function inMemoryCounterStore(): CoUsageCounterPort {
  const rows = new Map<string, number>();
  const keyOf = (workspaceId: string, low: string, high: string): string =>
    `${workspaceId}|${low}|${high}`;
  return {
    increment: (input) => {
      const key = keyOf(input.workspaceId, input.lowMemoryId, input.highMemoryId);
      const next = (rows.get(key) ?? 0) + 1;
      rows.set(key, next);
      return next;
    },
    delete: (workspaceId, low, high) => {
      rows.delete(keyOf(workspaceId, low, high));
    },
    evictExpired: () => 0,
    size: () => rows.size
  };
}

// Fake existence port: object id -> owning workspace. Unknown id -> null
// (missing). A known id whose workspace differs from the relation workspace is
// the cross-workspace case.
function existencePort(owners: Record<string, string>): MemoryAnchorExistencePort {
  return {
    workspaceOfObject: async (objectId) => owners[objectId] ?? null
  };
}

interface Harness {
  readonly service: PathRelationProposalService;
  readonly repoCreate: ReturnType<typeof vi.fn>;
  readonly events: EventLogEntry[];
  readonly recordPathRelationFailure: ReturnType<typeof vi.fn>;
}

function buildHarness(owners: Record<string, string>): Harness {
  const events: EventLogEntry[] = [];
  const recordPathRelationFailure = vi.fn();
  const repoCreate = vi.fn((relation: any) => relation);
  const appendManyWithMutation = vi.fn(
    async <T,>(
      eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
      mutate: (entries: readonly EventLogEntry[]) => T
    ): Promise<T> => {
      const persisted = eventInputs.map((entry, idx) => ({
        event_id: `evt_${idx}`,
        created_at: "2026-05-16T00:00:00.000Z",
        revision: 0,
        ...entry
      })) as EventLogEntry[];
      const result = mutate(persisted);
      for (const event of persisted) {
        events.push(event);
      }
      return result;
    }
  );
  const service = new PathRelationProposalService({
    repo: {
      create: repoCreate,
      findByAnchorMemoryId: vi.fn(async () => [])
    },
    counterStore: inMemoryCounterStore(),
    memoryExistence: existencePort(owners),
    eventPublisher: {
      appendManyWithMutation
    } as unknown as PathRelationProposalEventPublisherPort,
    healthInboxPort: { recordPathRelationFailure },
    generateId: () => "path-should-not-mint"
  });
  return { service, repoCreate, events, recordPathRelationFailure };
}

function candidate(overrides: Partial<SubmitCandidateInput> = {}): SubmitCandidateInput {
  return {
    workspaceId: "workspace-A",
    sourceAnchor: { kind: "object", object_id: "mem-source" },
    targetAnchor: { kind: "object", object_id: "mem-target" },
    relationKind: "supports",
    initialStrength: 0.5,
    governanceClass: "attention_only",
    evidenceBasis: ["llm_supports_verdict"],
    recallBiasSign: 1,
    recallBiasMagnitude: 0.5,
    runId: "run-mcp-or-garden",
    ...overrides
  };
}

describe("PathRelationProposalService — object-anchor existence + ownership gate (B3)", () => {
  it("mints when both object anchors exist in the relation workspace", async () => {
    const { service, repoCreate, events } = buildHarness({
      "mem-source": "workspace-A",
      "mem-target": "workspace-A"
    });

    const result = await service.submitCandidate(candidate());

    expect(result).toBe("applied");
    expect(repoCreate).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.event_type)).toEqual(["path.relation_created"]);
  });

  it("rejects a candidate whose target object id is MISSING — no path, no neighbor, audited", async () => {
    const { service, repoCreate, events } = buildHarness({
      "mem-source": "workspace-A"
      // mem-target is absent -> missing
    });

    const result = await service.submitCandidate(candidate());

    expect(result).toBe("rejected");
    expect(repoCreate).not.toHaveBeenCalled();
    expect(events.map((e) => e.event_type)).toEqual(["path.relation_rejected"]);
    expect(events[0]!.payload_json).toMatchObject({
      workspace_id: "workspace-A",
      relation_kind: "supports",
      anchor_role: "target",
      rejected_object_id: "mem-target",
      rejection_reason: "object_missing"
    });
  });

  it("rejects a candidate whose source object id is MISSING and reports the source role", async () => {
    const { service, repoCreate, events } = buildHarness({
      "mem-target": "workspace-A"
      // mem-source is absent -> missing; source is checked before target
    });

    const result = await service.submitCandidate(candidate());

    expect(result).toBe("rejected");
    expect(repoCreate).not.toHaveBeenCalled();
    expect(events.map((e) => e.event_type)).toEqual(["path.relation_rejected"]);
    expect(events[0]!.payload_json).toMatchObject({
      anchor_role: "source",
      rejected_object_id: "mem-source",
      rejection_reason: "object_missing"
    });
  });

  it("rejects a candidate whose target object belongs to ANOTHER workspace — distinct foreign reason", async () => {
    const { service, repoCreate, events } = buildHarness({
      "mem-source": "workspace-A",
      "mem-target": "workspace-B"
    });

    const result = await service.submitCandidate(candidate());

    expect(result).toBe("rejected");
    expect(repoCreate).not.toHaveBeenCalled();
    expect(events.map((e) => e.event_type)).toEqual(["path.relation_rejected"]);
    expect(events[0]!.payload_json).toMatchObject({
      workspace_id: "workspace-A",
      anchor_role: "target",
      rejected_object_id: "mem-target",
      rejection_reason: "object_foreign_workspace"
    });
  });

  // D-EDGEAUDIT: an anchor-rejected mint also surfaces a health_inbox
  // path_relation_failure entry (best-effort) keyed on the rejected object id,
  // in addition to the path.relation_rejected EventLog row. A clean mint does not.
  it("surfaces a health_inbox path-relation-failure on anchor reject and not on a clean mint", async () => {
    const rejected = buildHarness({ "mem-source": "workspace-A" });
    await rejected.service.submitCandidate(candidate());
    expect(rejected.recordPathRelationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-A", targetObjectId: "mem-target" })
    );

    const clean = buildHarness({ "mem-source": "workspace-A", "mem-target": "workspace-A" });
    await clean.service.submitCandidate(candidate());
    expect(clean.recordPathRelationFailure).not.toHaveBeenCalled();
  });

  it("does not mutate durable memory on the co-recall counter path when the pair object id is missing", async () => {
    const { service, repoCreate, events } = buildHarness({
      // neither mem-x nor mem-y exists
    });

    // Drive the counter to its threshold; the counter-gated co_recalled mint
    // runs through the same materialize gate as submitCandidate.
    for (let i = 0; i < PATH_RELATION_PROPOSE_THRESHOLD; i += 1) {
      await service.onCoRecall(["mem-x", "mem-y"], "workspace-A");
    }

    expect(repoCreate).not.toHaveBeenCalled();
    expect(events.every((e) => e.event_type === "path.relation_rejected")).toBe(true);
  });
});
