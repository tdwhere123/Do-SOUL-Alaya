import {
  DelegatedWorkerRunSchema,
  ObligationTrustNarrativeEventType,
  WorkerTrustAssessmentSchema,
  type DelegatedWorkerRun
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { WorkerTrustAssessor, type TrustAssessmentContext } from "../../security/worker-trust-assessor.js";

const FIXED_NOW = "2026-04-15T10:00:00.000Z";

describe("WorkerTrustAssessor", () => {
  it("derives trust levels from the five-factor model and publishes worker.trust_assessed", async () => {
    const publish = vi.fn(async (entry) => ({
      ...entry,
      event_id: "event-1",
      created_at: FIXED_NOW
    }));
    const assessor = new WorkerTrustAssessor({
      eventPublisher: { publish },
      now: () => FIXED_NOW,
      generateAssessmentId: () => "assessment-1"
    });

    const cases: ReadonlyArray<{
      readonly name: string;
      readonly context: Omit<TrustAssessmentContext, "workerRun">;
      readonly expectedLevel: "high" | "standard" | "low" | "untrusted";
      readonly expectedFactorCount: number;
    }> = [
      {
        name: "all five factors",
        context: {
          hasGovernanceLease: true,
          hardConstraintCount: 2,
          toolSetRestricted: true,
          constitutionalAssetsBound: true,
          budgetStatus: { withinLimits: true }
        },
        expectedLevel: "high",
        expectedFactorCount: 5
      },
      {
        name: "three factors",
        context: {
          hasGovernanceLease: true,
          hardConstraintCount: 1,
          toolSetRestricted: true,
          constitutionalAssetsBound: false,
          budgetStatus: { withinLimits: false }
        },
        expectedLevel: "standard",
        expectedFactorCount: 3
      },
      {
        name: "one factor",
        context: {
          hasGovernanceLease: false,
          hardConstraintCount: 0,
          toolSetRestricted: false,
          constitutionalAssetsBound: false,
          budgetStatus: { withinLimits: true }
        },
        expectedLevel: "low",
        expectedFactorCount: 1
      },
      {
        name: "zero factors",
        context: {
          hasGovernanceLease: false,
          hardConstraintCount: 0,
          toolSetRestricted: false,
          constitutionalAssetsBound: false,
          budgetStatus: { withinLimits: false }
        },
        expectedLevel: "untrusted",
        expectedFactorCount: 0
      }
    ];

    for (const testCase of cases) {
      const assessment = await assessor.assess({
        workerRun: createWorkerRun(),
        ...testCase.context
      });

      expect(WorkerTrustAssessmentSchema.parse(assessment)).toEqual(assessment);
      expect(assessment.assessment_id).toBe("assessment-1");
      expect(assessment.assessed_at).toBe(FIXED_NOW);
      expect(assessment.trust_level).toBe(testCase.expectedLevel);
      expect(assessment.factors).toHaveLength(testCase.expectedFactorCount);
    }

    expect(publish).toHaveBeenCalledTimes(cases.length);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event_type: ObligationTrustNarrativeEventType.WORKER_TRUST_ASSESSED,
        entity_type: "worker_run",
        entity_id: "worker-run-1",
        workspace_id: "workspace-1",
        run_id: "principal-run-1",
        payload_json: expect.objectContaining({
          assessment_id: "assessment-1",
          worker_run_id: "worker-run-1",
          trust_level: "untrusted",
          factors: []
        })
      })
    );
  });
});

function createWorkerRun(overrides: Partial<DelegatedWorkerRun> = {}): DelegatedWorkerRun {
  return DelegatedWorkerRunSchema.parse({
    worker_run_id: "worker-run-1",
    principal_run_id: "principal-run-1",
    workspace_id: "workspace-1",
    requesting_run_id: "principal-run-1",
    engine_class: "coding_engine",
    state: "active",
    subtask_description: "Assess worker trust posture",
    local_surface_ref: "surface://worker/1",
    local_evidence_pointer: null,
    restricted_tool_set: ["read_file"],
    local_budget: {
      max_worker_delegations: 1,
      max_tool_calls: 5,
      max_output_tokens: 1024,
      max_wall_time_ms: 60_000
    },
    agreed_return_format: {
      allowed_return_kinds: ["analysis_note"],
      requires_structured_summary: true
    },
    principal_security_snapshot: {
      governance_lease_ref: "lease://principal/1",
      hard_constraint_refs: ["constraint://1"],
      denied_tool_categories: ["network"]
    },
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    ...overrides
  });
}
