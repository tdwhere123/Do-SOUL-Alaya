import { describe, expect, it, vi } from "vitest";
import {
  ClaimLifecycleState,
  ClaimKind,
  ScopeClass,
  canonicalGovernanceSubject,
  type ClaimForm,
  type EventLogEntry,
  type Slot
} from "@do-soul/alaya-protocol";
import {
  SlotService,
  type SlotServiceArbitrationResult,
  type SlotServiceDependencies
} from "../../surfaces/slot-service.js";

const CLAIM_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SLOT_ID_1 = "11111111-1111-4111-8111-111111111111";
const SLOT_ID_2 = "22222222-2222-4222-8222-222222222222";

function createActiveClaim(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: CLAIM_ID_1,
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
    workspace_id: "workspace-1",
    claim_status: ClaimLifecycleState.ACTIVE,
    ...overrides
  };
}

function createSlot(claim: ClaimForm, overrides: Partial<Slot> = {}): Slot {
  return {
    object_id: SLOT_ID_1,
    object_kind: "slot",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "system",
    governance_subject: claim.governance_subject,
    claim_kind: claim.claim_kind,
    scope_class: claim.scope_class,
    winner_claim_id: claim.object_id,
    incumbent_since: "2026-03-21T00:00:00.000Z",
    flip_conditions: [],
    workspace_id: claim.workspace_id,
    ...overrides
  };
}

function createDependencies(
  seedSlots: readonly Slot[] = [],
  overrides: Partial<SlotServiceDependencies> = {}
): {
  readonly dependencies: SlotServiceDependencies;
  readonly order: string[];
  readonly events: EventLogEntry[];
  readonly notifySpy: ReturnType<typeof vi.fn>;
} {
  const order: string[] = [];
  const slots = new Map(seedSlots.map((slot) => [slot.object_id, Object.freeze({ ...slot })]));
  const events: EventLogEntry[] = [];
  const notifySpy = vi.fn(async () => {});

  const dependencies: SlotServiceDependencies = {
    generateObjectId: () => (slots.size === 0 ? SLOT_ID_1 : SLOT_ID_2),
    now: () => "2026-03-21T01:00:00.000Z",
    slotRepo: {
      create: vi.fn(async (slot) => {
        order.push("repo_create");
        slots.set(slot.object_id, Object.freeze({ ...slot }));
        return Object.freeze({ ...slot });
      }),
      findById: vi.fn(async (objectId) => slots.get(objectId) ?? null),
      findByUniqueKey: vi.fn(async (canonicalKey, claimKind, scopeClass, workspaceId) => {
        for (const slot of slots.values()) {
          if (
            slot.governance_subject.canonical_key === canonicalKey &&
            slot.claim_kind === claimKind &&
            slot.scope_class === scopeClass &&
            slot.workspace_id === workspaceId
          ) {
            return slot;
          }
        }

        return null;
      }),
      findByWorkspace: vi.fn(async (workspaceId) =>
        [...slots.values()]
          .filter((slot) => slot.workspace_id === workspaceId)
          .sort((left, right) => left.object_id.localeCompare(right.object_id))
      ),
      findByWinnerClaimId: vi.fn(async (claimId) => {
        for (const slot of slots.values()) {
          if (slot.winner_claim_id === claimId) {
            return slot;
          }
        }

        return null;
      }),
      updateWinner: vi.fn(async (objectId, winnerClaimId, incumbentSince, updatedAt) => {
        order.push("repo_update");
        const existing = slots.get(objectId);
        if (existing === undefined) {
          throw new Error(`missing slot ${objectId}`);
        }

        const updated = Object.freeze({
          ...existing,
          winner_claim_id: winnerClaimId,
          incumbent_since: incumbentSince,
          updated_at: updatedAt
        });
        slots.set(objectId, updated);
        return updated;
      })
    },
    eventLogRepo: {
      append: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
        order.push("event_log");
        const created = {
          event_id: `event-${events.length + 1}`,
          created_at: "2026-03-21T01:00:00.000Z",
          revision: 0,
          ...event
        };
        events.push(created);
        return created;
      }),
      queryByEntity: vi.fn(async (entityType: string, entityId: string) =>
        events.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
      )
    },
    runtimeNotifier: {
      notifyEntry: notifySpy
    },
    ...overrides
  };

  return { dependencies, order, events, notifySpy };
}

describe("SlotService", () => {
  it("creates a new slot and sets first active claim as winner", async () => {
    const claim = createActiveClaim();
    const { dependencies } = createDependencies();
    const service = new SlotService(dependencies);

    const result = await service.onClaimActivated(claim);

    expect(result.decision).toBe("new_slot_created");
    expect(result.slot.winner_claim_id).toBe(claim.object_id);
    expect(result.slot.scope_class).toBe(ScopeClass.PROJECT);
  });

  it("returns contested for same-scope challenger without override", async () => {
    const incumbent = createActiveClaim({ object_id: CLAIM_ID_1 });
    const challenger = createActiveClaim({ object_id: CLAIM_ID_2 });
    const existingSlot = createSlot(incumbent, { object_id: SLOT_ID_1 });
    const { dependencies } = createDependencies([existingSlot]);
    const service = new SlotService(dependencies);

    const result = await service.onClaimActivated(challenger);

    expect(result.decision).toBe("contested");
    expect(result.reason).toContain("same_scope_conflict");
    expect(result.slot.object_id).toBe(SLOT_ID_1);
  });

  it("delegates same-scope conflicts to arbitration service when available", async () => {
    const incumbent = createActiveClaim({ object_id: CLAIM_ID_1 });
    const challenger = createActiveClaim({ object_id: CLAIM_ID_2 });
    const existingSlot = createSlot(incumbent, { object_id: SLOT_ID_1 });
    const arbitrationSlot = createSlot(challenger, {
      object_id: SLOT_ID_1,
      winner_claim_id: CLAIM_ID_2,
      updated_at: "2026-03-21T01:00:00.000Z"
    });
    const arbitrationSpy = vi.fn(
      async (): Promise<SlotServiceArbitrationResult> => ({
        slot: arbitrationSlot,
        decision: "winner_changed",
        winner_claim_id: CLAIM_ID_2,
        contested_claim_ids: [],
        reason: "decisive_edge_priority"
      })
    );

    const { dependencies } = createDependencies([existingSlot], {
      arbitrationService: {
        arbitrateSlot: arbitrationSpy
      }
    });

    const service = new SlotService(dependencies);
    const result = await service.onClaimActivated(challenger);

    expect(arbitrationSpy).toHaveBeenCalledWith(SLOT_ID_1);
    expect(result.decision).toBe("auto_won");
    expect(result.slot.winner_claim_id).toBe(CLAIM_ID_2);
    expect(result.reason).toBe("decisive_edge_priority");
  });
  it("auto-wins on cross-scope escalation to higher priority", async () => {
    const incumbent = createActiveClaim({ object_id: CLAIM_ID_1, scope_class: ScopeClass.GLOBAL_DOMAIN });
    const challenger = createActiveClaim({ object_id: CLAIM_ID_2, scope_class: ScopeClass.PROJECT });
    const existingSlot = createSlot(incumbent, { object_id: SLOT_ID_1, scope_class: ScopeClass.GLOBAL_DOMAIN });
    const { dependencies } = createDependencies([existingSlot]);
    const service = new SlotService(dependencies);

    const result = await service.onClaimActivated(challenger);

    expect(result.decision).toBe("auto_won");
    expect(result.reason).toBe("scope_escalation");
    expect(result.slot.scope_class).toBe(ScopeClass.PROJECT);
    expect(result.slot.winner_claim_id).toBe(CLAIM_ID_2);
  });

  it("keeps incumbent on lower-priority cross-scope challenger", async () => {
    const incumbent = createActiveClaim({ object_id: CLAIM_ID_1, scope_class: ScopeClass.PROJECT });
    const challenger = createActiveClaim({ object_id: CLAIM_ID_2, scope_class: ScopeClass.GLOBAL_CORE });
    const existingSlot = createSlot(incumbent, { object_id: SLOT_ID_1, scope_class: ScopeClass.PROJECT });
    const { dependencies } = createDependencies([existingSlot]);
    const service = new SlotService(dependencies);

    const result = await service.onClaimActivated(challenger);

    expect(result.decision).toBe("no_change");
    expect(result.slot.object_id).toBe(SLOT_ID_1);
    expect(result.slot.winner_claim_id).toBe(CLAIM_ID_1);
  });

  it("changes winner on user_override in same scope", async () => {
    const incumbent = createActiveClaim({ object_id: CLAIM_ID_1 });
    const challenger = createActiveClaim({ object_id: CLAIM_ID_2, precedence_basis: "user_override" });
    const existingSlot = createSlot(incumbent, { object_id: SLOT_ID_1 });
    const { dependencies, events } = createDependencies([existingSlot]);
    const service = new SlotService(dependencies);

    const result = await service.onClaimActivated(challenger);

    expect(result.decision).toBe("auto_won");
    expect(result.reason).toBe("user_override");
    expect(result.slot.winner_claim_id).toBe(CLAIM_ID_2);
    expect(events.map((event) => event.event_type)).toContain("soul.slot.winner_changed");
  });

  it("writes EventLog before winner update mutation", async () => {
    const incumbent = createActiveClaim({ object_id: CLAIM_ID_1 });
    const challenger = createActiveClaim({ object_id: CLAIM_ID_2, precedence_basis: "user_override" });
    const existingSlot = createSlot(incumbent, { object_id: SLOT_ID_1 });
    const { dependencies, order } = createDependencies([existingSlot]);
    const service = new SlotService(dependencies);

    await service.onClaimActivated(challenger);

    expect(order).toEqual(["event_log", "repo_update"]);
  });
  it("writes EventLog before repo mutation", async () => {
    const claim = createActiveClaim();
    const { dependencies, order } = createDependencies();
    const service = new SlotService(dependencies);

    await service.onClaimActivated(claim);

    expect(order).toEqual(["event_log", "repo_create"]);
  });

  it("emits slot created event", async () => {
    const claim = createActiveClaim();
    const { dependencies, events, notifySpy } = createDependencies();
    const service = new SlotService(dependencies);

    await service.onClaimActivated(claim);

    expect(events.map((event) => event.event_type)).toEqual(["soul.slot.created"]);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("findById returns the slot when the workspace matches", async () => {
    const claim = createActiveClaim();
    const slot = createSlot(claim, { workspace_id: "workspace-1" });
    const { dependencies } = createDependencies([slot]);
    const service = new SlotService(dependencies);

    await expect(service.findById(slot.object_id, "workspace-1")).resolves.toEqual(slot);
  });

  it("findById returns NOT_FOUND for a slot bound to a different workspace", async () => {
    const claim = createActiveClaim();
    const slot = createSlot(claim, { workspace_id: "workspace-1" });
    const { dependencies } = createDependencies([slot]);
    const service = new SlotService(dependencies);

    await expect(service.findById(slot.object_id, "workspace-b")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Slot not found"
    });
  });
});
