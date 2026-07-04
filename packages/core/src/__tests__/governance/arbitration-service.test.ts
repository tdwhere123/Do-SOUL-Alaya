import { describe, expect, it, vi } from "vitest";
import {
  ClaimKind,
  ClaimLifecycleState,
  ScopeClass,
  canonicalGovernanceSubject,
  type ClaimForm,
  type ConflictMatrixEdge,
  type EventLogEntry,
  type Slot
} from "@do-soul/alaya-protocol";
import { ArbitrationService, type ArbitrationServiceDependencies } from "../../governance/proposals/arbitration-service.js";

const SLOT_ID = "33333333-3333-4333-8333-333333333333";
const CLAIM_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EDGE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "workspace-1";

function createClaim(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: CLAIM_ID_A,
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    governance_subject: canonicalGovernanceSubject("security", { category: "secrets" }),
    claim_kind: ClaimKind.CONSTRAINT,
    scope_class: ScopeClass.PROJECT,
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Never print secrets.",
    evidence_refs: [],
    source_object_refs: [],
    workspace_id: WORKSPACE_ID,
    claim_status: ClaimLifecycleState.ACTIVE,
    ...overrides
  };
}

function createSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    object_id: SLOT_ID,
    object_kind: "slot",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "system",
    governance_subject: canonicalGovernanceSubject("security", { category: "secrets" }),
    claim_kind: ClaimKind.CONSTRAINT,
    scope_class: ScopeClass.PROJECT,
    winner_claim_id: CLAIM_ID_A,
    incumbent_since: "2026-03-21T00:00:00.000Z",
    flip_conditions: [],
    workspace_id: WORKSPACE_ID,
    ...overrides
  };
}

function createEdge(overrides: Partial<ConflictMatrixEdge> = {}): ConflictMatrixEdge {
  return {
    object_id: EDGE_ID,
    object_kind: "conflict_matrix_edge",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T01:00:00.000Z",
    updated_at: "2026-03-21T01:00:00.000Z",
    created_by: "user_action",
    source_claim_id: CLAIM_ID_B,
    target_claim_id: CLAIM_ID_A,
    edge_type: "exception_to",
    workspace_id: WORKSPACE_ID,
    ...overrides
  };
}

function createDependencies(seed: {
  readonly slot?: Slot;
  readonly claims?: readonly ClaimForm[];
  readonly edges?: readonly ConflictMatrixEdge[];
} = {}): {
  readonly dependencies: ArbitrationServiceDependencies;
  readonly order: string[];
  readonly transitionSpy: ReturnType<typeof vi.fn>;
  readonly updateWinnerSpy: ReturnType<typeof vi.fn>;
  readonly broadcastSpy: ReturnType<typeof vi.fn>;
  readonly appendSpy: ReturnType<typeof vi.fn>;
} {
  const order: string[] = [];
  const claims = new Map((seed.claims ?? []).map((claim) => [claim.object_id, Object.freeze({ ...claim })]));
  const edges = new Map((seed.edges ?? []).map((edge) => [edge.object_id, Object.freeze({ ...edge })]));
  let slotState = seed.slot ? Object.freeze({ ...seed.slot }) : null;
  const eventLog: EventLogEntry[] = [];

  const transitionSpy = vi.fn(async (claimId, nextState) => {
    const existing = claims.get(claimId);

    if (existing !== undefined) {
      claims.set(claimId, Object.freeze({ ...existing, claim_status: nextState }));
    }

    return claims.get(claimId) as ClaimForm;
  });

  const updateWinnerSpy = vi.fn(async (_slotId, winnerClaimId, incumbentSince, updatedAt) => {
    if (slotState === null) {
      throw new Error("missing slot");
    }

    slotState = Object.freeze({
      ...slotState,
      winner_claim_id: winnerClaimId,
      incumbent_since: incumbentSince,
      updated_at: updatedAt
    });

    return slotState;
  });

  const broadcastSpy = vi.fn(async () => {});

  const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
    order.push("event_log");
    const event = {
      event_id: `event-${eventLog.length + 1}`,
      created_at: "2026-03-21T02:00:00.000Z",
      revision: 0,
      ...entry
    };
    eventLog.push(event);
    return event;
  });

  const dependencies: ArbitrationServiceDependencies = {
    generateObjectId: () => EDGE_ID,
    now: () => "2026-03-21T02:00:00.000Z",
    slotRepo: {
      findById: vi.fn(async () => slotState),
      updateWinner: updateWinnerSpy
    },
    claimRepo: {
      findById: vi.fn(async (objectId: string) => claims.get(objectId) ?? null),
      findByWorkspaceId: vi.fn(async (workspaceId: string) =>
        [...claims.values()].filter((claim) => claim.workspace_id === workspaceId)
      )
    },
    conflictMatrixRepo: {
      create: vi.fn(async (edge) => {
        order.push("repo_create");
        edges.set(edge.object_id, Object.freeze({ ...edge }));
        return edge;
      }),
      findById: vi.fn(async (objectId: string) => edges.get(objectId) ?? null),
      findByWorkspace: vi.fn(async (workspaceId: string) =>
        [...edges.values()].filter((edge) => edge.workspace_id === workspaceId)
      ),
      findBetweenClaims: vi.fn(async (sourceClaimId: string, targetClaimId: string) =>
        [...edges.values()].filter(
          (edge) =>
            (edge.source_claim_id === sourceClaimId && edge.target_claim_id === targetClaimId) ||
            (edge.source_claim_id === targetClaimId && edge.target_claim_id === sourceClaimId)
        )
      ),
      delete: vi.fn(async (objectId: string) => {
        edges.delete(objectId);
      })
    },
    claimService: {
      transitionLifecycle: transitionSpy
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: vi.fn(async (entityType: string, entityId: string) =>
        eventLog.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
      )
    },
    runtimeNotifier: {
      notifyEntry: broadcastSpy
    }
  };

  return {
    dependencies,
    order,
    transitionSpy,
    updateWinnerSpy,
    broadcastSpy,
    appendSpy
  };
}

describe("ArbitrationService", () => {
  it("creates conflict edge with EventLog-first order and broadcasts", async () => {
    const claimA = createClaim({ object_id: CLAIM_ID_A });
    const claimB = createClaim({ object_id: CLAIM_ID_B });
    const { dependencies, order, broadcastSpy } = createDependencies({ claims: [claimA, claimB] });
    const service = new ArbitrationService(dependencies);

    const edge = await service.createEdge({
      source_claim_id: CLAIM_ID_A,
      target_claim_id: CLAIM_ID_B,
      edge_type: "incompatible_with",
      created_by: "reviewer"
    }, WORKSPACE_ID);

    expect(edge.edge_type).toBe("incompatible_with");
    expect(order).toEqual(["event_log", "repo_create"]);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it("createEdge rejects when a claim belongs to a different workspace and does not persist", async () => {
    const claimA = createClaim({ object_id: CLAIM_ID_A, workspace_id: "workspace-other" });
    const claimB = createClaim({ object_id: CLAIM_ID_B, workspace_id: "workspace-other" });
    const { dependencies, broadcastSpy } = createDependencies({ claims: [claimA, claimB] });
    const createSpy = dependencies.conflictMatrixRepo.create as ReturnType<typeof vi.fn>;
    const service = new ArbitrationService(dependencies);

    await expect(
      service.createEdge(
        {
          source_claim_id: CLAIM_ID_A,
          target_claim_id: CLAIM_ID_B,
          edge_type: "incompatible_with",
          created_by: "reviewer"
        },
        WORKSPACE_ID
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Source claim not found" });
    expect(createSpy).not.toHaveBeenCalled();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it("deleteEdge returns NOT_FOUND for an edge bound to a different workspace and does not delete", async () => {
    const edge = createEdge({ workspace_id: "workspace-other" });
    const { dependencies } = createDependencies({ edges: [edge] });
    const deleteSpy = dependencies.conflictMatrixRepo.delete as ReturnType<typeof vi.fn>;
    const service = new ArbitrationService(dependencies);

    await expect(service.deleteEdge(edge.object_id, WORKSPACE_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Conflict matrix edge not found"
    });
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("resolveSlotConflict returns NOT_FOUND for a slot bound to a different workspace", async () => {
    const slot = createSlot({ winner_claim_id: CLAIM_ID_A, workspace_id: "workspace-other" });
    const claimA = createClaim({ object_id: CLAIM_ID_A, workspace_id: "workspace-other" });
    const { dependencies, updateWinnerSpy } = createDependencies({ slot, claims: [claimA], edges: [] });
    const service = new ArbitrationService(dependencies);

    await expect(service.resolveSlotConflict(slot.object_id, CLAIM_ID_A, WORKSPACE_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Slot not found"
    });
    expect(updateWinnerSpy).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when deleting a non-existent conflict edge", async () => {
    const { dependencies } = createDependencies();
    const service = new ArbitrationService(dependencies);

    await expect(service.deleteEdge(EDGE_ID, WORKSPACE_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Conflict matrix edge not found"
    });
  });

  it("marks claims contested when no decisive edge exists for same-scope conflict", async () => {
    const slot = createSlot({ winner_claim_id: CLAIM_ID_A });
    const claimA = createClaim({ object_id: CLAIM_ID_A, claim_status: ClaimLifecycleState.ACTIVE });
    const claimB = createClaim({ object_id: CLAIM_ID_B, claim_status: ClaimLifecycleState.ACTIVE });
    const { dependencies, transitionSpy, updateWinnerSpy } = createDependencies({
      slot,
      claims: [claimA, claimB],
      edges: []
    });
    const service = new ArbitrationService(dependencies);

    const result = await service.arbitrateSlot(slot.object_id);

    expect(result.decision).toBe("contested");
    expect(result.contested_claim_ids).toEqual([CLAIM_ID_A, CLAIM_ID_B]);
    expect(transitionSpy).toHaveBeenCalledTimes(2);
    expect(updateWinnerSpy).not.toHaveBeenCalled();
  });

  it("marks both claims contested when connected by incompatible_with", async () => {
    const slot = createSlot({ winner_claim_id: CLAIM_ID_A });
    const claimA = createClaim({ object_id: CLAIM_ID_A, claim_status: ClaimLifecycleState.ACTIVE });
    const claimB = createClaim({ object_id: CLAIM_ID_B, claim_status: ClaimLifecycleState.ACTIVE });
    const edge = createEdge({ source_claim_id: CLAIM_ID_A, target_claim_id: CLAIM_ID_B, edge_type: "incompatible_with" });
    const { dependencies, transitionSpy, updateWinnerSpy } = createDependencies({
      slot,
      claims: [claimA, claimB],
      edges: [edge]
    });
    const service = new ArbitrationService(dependencies);

    const result = await service.arbitrateSlot(slot.object_id);

    expect(result.decision).toBe("contested");
    expect(result.contested_claim_ids).toEqual([CLAIM_ID_A, CLAIM_ID_B]);
    expect(transitionSpy).toHaveBeenCalledTimes(2);
    expect(updateWinnerSpy).not.toHaveBeenCalled();
  });

  it("changes winner when challenger has exception_to edge and supersedes incumbent", async () => {
    const slot = createSlot({ winner_claim_id: CLAIM_ID_A });
    const claimA = createClaim({ object_id: CLAIM_ID_A, claim_status: ClaimLifecycleState.ACTIVE });
    const claimB = createClaim({ object_id: CLAIM_ID_B, claim_status: ClaimLifecycleState.ACTIVE });
    const edge = createEdge({ source_claim_id: CLAIM_ID_B, target_claim_id: CLAIM_ID_A, edge_type: "exception_to" });
    const { dependencies, transitionSpy, updateWinnerSpy, broadcastSpy } = createDependencies({
      slot,
      claims: [claimA, claimB],
      edges: [edge]
    });
    const service = new ArbitrationService(dependencies);

    const result = await service.arbitrateSlot(slot.object_id);

    expect(result.decision).toBe("winner_changed");
    expect(result.winner_claim_id).toBe(CLAIM_ID_B);
    expect(updateWinnerSpy).toHaveBeenCalledTimes(1);
    expect(transitionSpy).toHaveBeenCalledTimes(2);
    expect(transitionSpy).toHaveBeenCalledWith(
      CLAIM_ID_A,
      ClaimLifecycleState.SUPERSEDED,
      "arbitration_superseded",
      "system",
      { skipSlotElection: true }
    );
    expect(transitionSpy).toHaveBeenCalledWith(
      CLAIM_ID_B,
      ClaimLifecycleState.WINNER,
      "arbitration_winner",
      "system",
      { skipSlotElection: true }
    );
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves slot conflict with review cause and manual reason codes", async () => {
    const slot = createSlot({ winner_claim_id: CLAIM_ID_A });
    const claimA = createClaim({ object_id: CLAIM_ID_A, claim_status: ClaimLifecycleState.WINNER });
    const claimB = createClaim({ object_id: CLAIM_ID_B, claim_status: ClaimLifecycleState.CONTESTED });
    const { dependencies, transitionSpy, updateWinnerSpy, appendSpy } = createDependencies({
      slot,
      claims: [claimA, claimB],
      edges: []
    });
    const service = new ArbitrationService(dependencies);

    const updated = await service.resolveSlotConflict(slot.object_id, CLAIM_ID_B, WORKSPACE_ID);

    expect(updated.winner_claim_id).toBe(CLAIM_ID_B);
    expect(updateWinnerSpy).toHaveBeenCalledTimes(1);
    expect(transitionSpy).toHaveBeenCalledWith(
      CLAIM_ID_A,
      ClaimLifecycleState.SUPERSEDED,
      "manual_resolution_superseded",
      "review",
      { skipSlotElection: true }
    );
    expect(transitionSpy).toHaveBeenCalledWith(
      CLAIM_ID_B,
      ClaimLifecycleState.WINNER,
      "manual_resolution_winner",
      "review",
      { skipSlotElection: true }
    );
    expect(appendSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event_type: "soul.slot.winner_changed",
        caused_by: "review"
      })
    );
  });

  it("rejects resolveSlotConflict when winner claim is not in slot candidates", async () => {
    const slot = createSlot({ winner_claim_id: CLAIM_ID_A });
    const claimA = createClaim({ object_id: CLAIM_ID_A, claim_status: ClaimLifecycleState.WINNER });
    const { dependencies } = createDependencies({
      slot,
      claims: [claimA],
      edges: []
    });
    const service = new ArbitrationService(dependencies);

    await expect(service.resolveSlotConflict(slot.object_id, CLAIM_ID_B, WORKSPACE_ID)).rejects.toMatchObject({
      code: "VALIDATION",
      message: "winner_claim_id must match a candidate claim in slot"
    });
  });

  it("treats supports edge as non-conflict and keeps current winner", async () => {
    const slot = createSlot({ winner_claim_id: CLAIM_ID_A });
    const claimA = createClaim({ object_id: CLAIM_ID_A, claim_status: ClaimLifecycleState.WINNER });
    const claimB = createClaim({ object_id: CLAIM_ID_B, claim_status: ClaimLifecycleState.ACTIVE });
    const edge = createEdge({ source_claim_id: CLAIM_ID_B, target_claim_id: CLAIM_ID_A, edge_type: "supports" });
    const { dependencies, transitionSpy, updateWinnerSpy, broadcastSpy } = createDependencies({
      slot,
      claims: [claimA, claimB],
      edges: [edge]
    });
    const service = new ArbitrationService(dependencies);

    const result = await service.arbitrateSlot(slot.object_id);

    expect(result.decision).toBe("no_change");
    expect(result.winner_claim_id).toBe(CLAIM_ID_A);
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(updateWinnerSpy).not.toHaveBeenCalled();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it("treats derives_from edge as non-conflict and keeps current winner", async () => {
    const slot = createSlot({ winner_claim_id: CLAIM_ID_A });
    const claimA = createClaim({ object_id: CLAIM_ID_A, claim_status: ClaimLifecycleState.WINNER });
    const claimB = createClaim({ object_id: CLAIM_ID_B, claim_status: ClaimLifecycleState.ACTIVE });
    const edge = createEdge({ source_claim_id: CLAIM_ID_B, target_claim_id: CLAIM_ID_A, edge_type: "derives_from" });
    const { dependencies, transitionSpy, updateWinnerSpy, broadcastSpy } = createDependencies({
      slot,
      claims: [claimA, claimB],
      edges: [edge]
    });
    const service = new ArbitrationService(dependencies);

    const result = await service.arbitrateSlot(slot.object_id);

    expect(result.decision).toBe("no_change");
    expect(result.winner_claim_id).toBe(CLAIM_ID_A);
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(updateWinnerSpy).not.toHaveBeenCalled();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it("supports dryRun arbitration without mutating claim lifecycle or slot winner", async () => {
    const slot = createSlot({ winner_claim_id: CLAIM_ID_A });
    const claimA = createClaim({ object_id: CLAIM_ID_A, claim_status: ClaimLifecycleState.ACTIVE });
    const claimB = createClaim({ object_id: CLAIM_ID_B, claim_status: ClaimLifecycleState.ACTIVE });
    const edge = createEdge({ source_claim_id: CLAIM_ID_B, target_claim_id: CLAIM_ID_A, edge_type: "supersedes" });
    const { dependencies, transitionSpy, updateWinnerSpy, broadcastSpy } = createDependencies({
      slot,
      claims: [claimA, claimB],
      edges: [edge]
    });
    const service = new ArbitrationService(dependencies);

    const result = await service.arbitrateSlot(slot.object_id, { dryRun: true });

    expect(result.decision).toBe("winner_changed");
    expect(result.winner_claim_id).toBe(CLAIM_ID_B);
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(updateWinnerSpy).not.toHaveBeenCalled();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it("rebuilds conflict matrix and deletes orphaned edges", async () => {
    const claimA = createClaim({ object_id: CLAIM_ID_A });
    const claimB = createClaim({ object_id: CLAIM_ID_B });
    const validEdge = createEdge({ object_id: EDGE_ID, source_claim_id: CLAIM_ID_A, target_claim_id: CLAIM_ID_B });
    const orphanedEdge = createEdge({
      object_id: "edge-orphan",
      source_claim_id: "claim-missing",
      target_claim_id: CLAIM_ID_B,
      edge_type: "supports"
    });

    const { dependencies } = createDependencies({
      claims: [claimA, claimB],
      edges: [validEdge, orphanedEdge]
    });
    const service = new ArbitrationService(dependencies);

    const result = await service.rebuildConflictMatrix(WORKSPACE_ID);

    expect(result).toEqual({
      total_edges: 2,
      orphaned_deleted: 1,
      valid_edges: 1
    });

    await expect(service.listEdgesByWorkspace(WORKSPACE_ID)).resolves.toHaveLength(1);
  });
});