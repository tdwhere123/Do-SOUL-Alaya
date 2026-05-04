import { describe, expect, it } from "vitest";
import { EventTypeSchema } from "../event-log.js";
import {
  DirtyStatePanicPayloadSchema,
  NarrativeBudgetExceededPayloadSchema,
  NarrativeConsolidationTriggeredPayloadSchema,
  ObligationCreatedPayloadSchema,
  ObligationExpiredPayloadSchema,
  ObligationFulfilledPayloadSchema,
  ObligationViolationBlockedPayloadSchema,
  ObligationTrustNarrativeEventType,
  ObligationTrustNarrativeEventTypeSchema,
  ObligationTrustNarrativeEventUnionSchema,
  WorkerTrustAssessedPayloadSchema,
  parseObligationTrustNarrativeEventPayload
} from "../events/obligation-trust-narrative.js";

const validTimestamp = "2026-04-15T00:00:00.000Z";

describe("Phase B event registry", () => {
  it("registers all Phase B event names and validates each payload type", () => {
    const expectedEventTypes = [
      "obligation.created",
      "obligation.fulfilled",
      "obligation.expired",
      "obligation.violation_blocked",
      "dirty_state.panic",
      "worker.trust_assessed",
      "narrative.budget_exceeded",
      "narrative.consolidation_triggered"
    ] as const;

    expect(Object.values(ObligationTrustNarrativeEventType)).toEqual(expectedEventTypes);
    expect(ObligationTrustNarrativeEventTypeSchema.options).toEqual(expectedEventTypes);
    expect(expectedEventTypes.every((eventType) => eventType.includes("."))).toBe(true);

    const createdPayload = {
      obligation_id: "obligation-1",
      kind: "safety_finding",
      state: "pending",
      description: "Address finding",
      source_run_id: "run-1",
      workspace_id: "workspace-1",
      target_entity_id: "claim-1",
      created_at: validTimestamp,
      expires_at: "2026-04-16T00:00:00.000Z"
    } as const;
    const fulfilledPayload = {
      obligation_id: "obligation-1",
      fulfilled_at: validTimestamp
    } as const;
    const expiredPayload = {
      obligation_id: "obligation-2",
      expired_at: validTimestamp
    } as const;
    const blockedPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      operation: "worker_complete",
      active_obligation_ids: ["obligation-1"],
      blocked_at: validTimestamp
    } as const;
    const panicPayload = {
      dossier_id: "dossier-1",
      worker_run_id: "worker-run-1",
      principal_run_id: "principal-run-1",
      trigger: "state_inconsistency",
      panic_source: "integration_gate",
      panic_summary: "capability mismatch",
      affected_entity_count: 1
    } as const;
    const trustPayload = {
      assessment_id: "assessment-1",
      worker_run_id: "worker-run-1",
      trust_level: "high",
      factors: [
        "governance_lease_active",
        "hard_constraints_present",
        "tool_set_restricted",
        "budget_within_limits",
        "constitutional_assets_bound"
      ]
    } as const;
    const budgetPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      current_bytes: 1200,
      max_bytes: 1000,
      current_count: 3,
      max_count: 2
    } as const;
    const consolidationPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      trigger_reason: "budget_exceeded",
      digest_count_before: 3
    } as const;

    expect(ObligationCreatedPayloadSchema.parse(createdPayload)).toEqual(createdPayload);
    expect(ObligationFulfilledPayloadSchema.parse(fulfilledPayload)).toEqual(fulfilledPayload);
    expect(ObligationExpiredPayloadSchema.parse(expiredPayload)).toEqual(expiredPayload);
    expect(ObligationViolationBlockedPayloadSchema.parse(blockedPayload)).toEqual(blockedPayload);
    expect(DirtyStatePanicPayloadSchema.parse(panicPayload)).toEqual(panicPayload);
    expect(WorkerTrustAssessedPayloadSchema.parse(trustPayload)).toEqual(trustPayload);
    expect(NarrativeBudgetExceededPayloadSchema.parse(budgetPayload)).toEqual(budgetPayload);
    expect(NarrativeConsolidationTriggeredPayloadSchema.parse(consolidationPayload)).toEqual(
      consolidationPayload
    );

    expect(parseObligationTrustNarrativeEventPayload(ObligationTrustNarrativeEventType.OBLIGATION_CREATED, createdPayload)).toEqual(
      createdPayload
    );
    expect(parseObligationTrustNarrativeEventPayload(ObligationTrustNarrativeEventType.OBLIGATION_FULFILLED, fulfilledPayload)).toEqual(
      fulfilledPayload
    );
    expect(parseObligationTrustNarrativeEventPayload(ObligationTrustNarrativeEventType.OBLIGATION_EXPIRED, expiredPayload)).toEqual(
      expiredPayload
    );
    expect(
      parseObligationTrustNarrativeEventPayload(ObligationTrustNarrativeEventType.OBLIGATION_VIOLATION_BLOCKED, blockedPayload)
    ).toEqual(blockedPayload);
    expect(parseObligationTrustNarrativeEventPayload(ObligationTrustNarrativeEventType.DIRTY_STATE_PANIC, panicPayload)).toEqual(
      panicPayload
    );
    expect(parseObligationTrustNarrativeEventPayload(ObligationTrustNarrativeEventType.WORKER_TRUST_ASSESSED, trustPayload)).toEqual(
      trustPayload
    );
    expect(
      parseObligationTrustNarrativeEventPayload(ObligationTrustNarrativeEventType.NARRATIVE_BUDGET_EXCEEDED, budgetPayload)
    ).toEqual(budgetPayload);
    expect(
      parseObligationTrustNarrativeEventPayload(ObligationTrustNarrativeEventType.NARRATIVE_CONSOLIDATION_TRIGGERED, consolidationPayload)
    ).toEqual(consolidationPayload);

    expect(
      ObligationTrustNarrativeEventUnionSchema.parse({
        type: ObligationTrustNarrativeEventType.OBLIGATION_CREATED,
        payload: createdPayload
      })
    ).toEqual({
      type: ObligationTrustNarrativeEventType.OBLIGATION_CREATED,
      payload: createdPayload
    });

    for (const eventType of expectedEventTypes) {
      expect(EventTypeSchema.parse(eventType)).toBe(eventType);
    }
  });

  it("rejects unknown names and malformed payloads", () => {
    expect(() => ObligationTrustNarrativeEventTypeSchema.parse("obligation.unknown")).toThrow();
    expect(() => EventTypeSchema.parse("dirty.state.panic")).toThrow();

    expect(() =>
      parseObligationTrustNarrativeEventPayload(ObligationTrustNarrativeEventType.OBLIGATION_CREATED, {
        obligation_id: "obligation-1",
        kind: "safety_finding",
        state: "pending",
        description: "missing fields",
        created_at: validTimestamp,
        expires_at: "2026-04-16T00:00:00.000Z"
      })
    ).toThrow();

    expect(() =>
      parseObligationTrustNarrativeEventPayload(ObligationTrustNarrativeEventType.DIRTY_STATE_PANIC, {
        dossier_id: "dossier-1",
        worker_run_id: "worker-run-1",
        principal_run_id: "principal-run-1",
        trigger: "manual",
        panic_source: "integration_gate",
        panic_summary: "",
        affected_entity_count: -1
      })
    ).toThrow();

    expect(() =>
      parseObligationTrustNarrativeEventPayload(ObligationTrustNarrativeEventType.WORKER_TRUST_ASSESSED, {
        assessment_id: "assessment-1",
        worker_run_id: "worker-run-1",
        trust_level: "trusted",
        factors: []
      })
    ).toThrow();
  });
});
