import { vi } from "vitest";
import { ClaimLifecycleState, canonicalGovernanceSubject, type ClaimForm, type EventLogEntry, type Slot } from "@do-soul/alaya-protocol";
import { type ClaimFormInput, type ClaimServiceDependencies } from "../../governance/claims/claim-service.js";
import type { SlotElectionResult } from "../../surfaces/slot-service.js";

export function createClaimInput(overrides: Partial<ClaimFormInput> = {}): ClaimFormInput {
  return {
    created_by: "user_action",
    governance_subject_domain: "code_style",
    governance_subject_qualifiers: { language: "TypeScript" },
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    source_object_refs: ["synthesis-1"],
    workspace_id: "workspace-1",
    ...overrides
  };
}

export function createClaimForm(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    governance_subject: canonicalGovernanceSubject("code_style", { language: "typescript" }),
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    source_object_refs: ["synthesis-1"],
    workspace_id: "workspace-1",
    claim_status: ClaimLifecycleState.DRAFT,
    ...overrides
  };
}

export function createEventLogHistory(maxRevision: number): readonly EventLogEntry[] {
  return [
    {
      event_id: "event-history",
      event_type: "soul.claim.created",
      entity_type: "claim_form",
      entity_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "user_action",
      revision: maxRevision,
      payload_json: {
        object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
        object_kind: "claim_form",
        workspace_id: "workspace-1",
        run_id: null
      },
      created_at: "2026-03-21T00:00:00.000Z"
    }
  ];
}

export function createDependencies(overrides: Partial<ClaimServiceDependencies> = {}): {
  readonly dependencies: ClaimServiceDependencies;
  readonly appendSpy: ReturnType<typeof vi.fn>;
  readonly queryByEntitySpy: ReturnType<typeof vi.fn>;
  readonly broadcastSpy: ReturnType<typeof vi.fn>;
  readonly slotElectionSpy: ReturnType<typeof vi.fn>;
} {
  const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
    event_id: `event-${event.event_type}-${Math.random()}`,
    created_at: "2026-03-21T00:00:00.000Z",
    revision: 0,
    ...event
  }));
  const queryByEntitySpy = vi.fn(async () => [] as readonly EventLogEntry[]);
  const broadcastSpy = vi.fn(async () => {});
  const slotElectionSpy = vi.fn(async (): Promise<SlotElectionResult> => ({
    decision: "new_slot_created",
    reason: "first_claim_for_subject",
    slot: {
      object_id: "slot-1",
      object_kind: "slot",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-21T00:00:00.000Z",
      updated_at: "2026-03-21T00:00:00.000Z",
      created_by: "system",
      governance_subject: canonicalGovernanceSubject("code_style", { language: "typescript" }),
      claim_kind: "constraint",
      scope_class: "project",
      winner_claim_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
      incumbent_since: "2026-03-21T00:00:00.000Z",
      flip_conditions: [],
      workspace_id: "workspace-1"
    } satisfies Slot
  }));

  const dependencies: ClaimServiceDependencies = {
    now: () => "2026-03-21T01:00:00.000Z",
    generateObjectId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    claimFormRepo: {
      create: vi.fn((claim) => Object.freeze({ ...claim })),
      findById: vi.fn(async () => createClaimForm()),
      findByWorkspaceId: vi.fn(async () => []),
      findByStatus: vi.fn(async () => []),
      findByCanonicalKey: vi.fn(async () => []),
      updateStatus: vi.fn(async (_objectId, status, updatedAt) =>
        Object.freeze(createClaimForm({ claim_status: status, updated_at: updatedAt }))
      )
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: queryByEntitySpy
    },
    slotService: {
      onClaimActivated: slotElectionSpy
    },
    runtimeNotifier: {
      notifyEntry: broadcastSpy
    },
    ...overrides
  };

  return {
    dependencies,
    appendSpy,
    queryByEntitySpy,
    broadcastSpy,
    slotElectionSpy
  };
}
