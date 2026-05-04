import { describe, expect, it } from "vitest";
import { EventTypeSchema } from "../event-log.js";
import {
  BudgetEventType,
  BudgetEventTypeSchema,
  BudgetEventUnionSchema,
  parseBudgetEventPayload
} from "../events/budget.js";

const validTimestamp = "2026-03-25T00:00:00.000Z";

describe("Phase 3C event schemas", () => {
  it("keeps BudgetEventType enum complete and closed", () => {
    const expected = [
      "soul.budget.degraded",
      "soul.budget.bankruptcy_declared",
      "soul.budget.bankruptcy_resolved"
    ];

    expect(Object.values(BudgetEventType)).toEqual(expected);
    expect(BudgetEventTypeSchema.options).toEqual(expected);
    expect(() => BudgetEventTypeSchema.parse("soul.budget.unknown")).toThrow();
  });

  it("parses all budget payloads", () => {
    const degradedPayload = {
      run_id: "run-1",
      workspace_id: "workspace-1",
      lens_runtime_id: "lens-1",
      steps_applied: ["manifestation_downgrade_excerpt"],
      tokens_before: 1200,
      tokens_after: 700,
      budget_limit: 800,
      still_over_budget: false,
      occurred_at: validTimestamp
    } as const;
    expect(parseBudgetEventPayload(BudgetEventType.SOUL_BUDGET_DEGRADED, degradedPayload)).toEqual(
      degradedPayload
    );

    const declaredPayload = {
      bankruptcy_id: "bankruptcy-1",
      bankruptcy_kind: "soft",
      trigger_kind: "token_overflow",
      current_mode: "lean",
      trigger_summary: "Token estimate 1200 exceeds budget 800",
      mode_at_trigger: "full",
      task_surface_ref: "surface://task/main",
      protected_constraints_preserved: ["claim-1"],
      dropped_candidates: ["memory-1"],
      unresolved_conflicts: ["conflict-1"],
      required_actions: ["compress", "defer"],
      expires_at: "2026-03-25T01:00:00.000Z",
      run_id: "run-1",
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(
      parseBudgetEventPayload(BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED, declaredPayload)
    ).toEqual(declaredPayload);

    const resolvedPayload = {
      bankruptcy_id: "bankruptcy-1",
      proposal_id: "proposal-1",
      resolution_state: "auto_applied",
      option_id_applied: "option-1",
      run_id: "run-1",
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(
      parseBudgetEventPayload(BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED, resolvedPayload)
    ).toEqual(resolvedPayload);
  });

  it("throws for unknown budget event types", () => {
    expect(() =>
      parseBudgetEventPayload("soul.budget.unknown" as never, {
        occurred_at: validTimestamp
      })
    ).toThrow();
  });

  it("rejects negative degraded token counts", () => {
    expect(() =>
      parseBudgetEventPayload(BudgetEventType.SOUL_BUDGET_DEGRADED, {
        run_id: "run-1",
        workspace_id: "workspace-1",
        lens_runtime_id: "lens-1",
        steps_applied: [],
        tokens_before: -1,
        tokens_after: 10,
        budget_limit: 10,
        still_over_budget: false,
        occurred_at: validTimestamp
      })
    ).toThrow();
  });

  it("rejects invalid bankruptcy kinds", () => {
    expect(() =>
      parseBudgetEventPayload(BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED, {
        bankruptcy_id: "bankruptcy-1",
        bankruptcy_kind: "invalid_kind",
        trigger_kind: "token_overflow",
        current_mode: "lean",
        trigger_summary: "Token estimate 1200 exceeds budget 800",
        mode_at_trigger: "full",
        task_surface_ref: "surface://task/main",
        protected_constraints_preserved: ["claim-1"],
        dropped_candidates: ["memory-1"],
        unresolved_conflicts: [],
        required_actions: ["compress"],
        expires_at: null,
        run_id: "run-1",
        workspace_id: "workspace-1",
        occurred_at: validTimestamp
      })
    ).toThrow();
  });

  it("requires the declared payload recovery fields used for restart reconstruction", () => {
    expect(() =>
      parseBudgetEventPayload(BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED, {
        bankruptcy_id: "bankruptcy-1",
        bankruptcy_kind: "hard",
        trigger_kind: "strict_conflict",
        current_mode: "minimal",
        run_id: "run-1",
        workspace_id: "workspace-1",
        occurred_at: validTimestamp
      })
    ).toThrow();
  });

  it("discriminates correctly on type", () => {
    const event = {
      type: BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED,
      payload: {
        bankruptcy_id: "bankruptcy-1",
        proposal_id: "proposal-1",
        resolution_state: "accepted",
        option_id_applied: null,
        run_id: "run-1",
        workspace_id: "workspace-1",
        occurred_at: validTimestamp
      }
    } as const;

    expect(BudgetEventUnionSchema.parse(event)).toEqual(event);
  });

  it("accepts budget event types in EventType union", () => {
    expect(EventTypeSchema.parse(BudgetEventType.SOUL_BUDGET_DEGRADED)).toBe(
      BudgetEventType.SOUL_BUDGET_DEGRADED
    );
    expect(EventTypeSchema.parse(BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED)).toBe(
      BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED
    );
  });
});
