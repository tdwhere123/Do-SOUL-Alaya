import { randomUUID } from "node:crypto";
import {
  ObligationTrustNarrativeEventType,
  WorkerTrustAssessmentSchema,
  WorkerTrustAssessedPayloadSchema,
  type DelegatedWorkerRun,
  type EventLogEntry,
  type TrustAssessmentFactor,
  type WorkerTrustAssessment,
  type WorkerTrustLevel
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "../event-publisher.js";

export interface TrustAssessmentContext {
  readonly workerRun: Readonly<DelegatedWorkerRun>;
  readonly hasGovernanceLease: boolean;
  readonly hardConstraintCount: number;
  readonly toolSetRestricted: boolean;
  readonly constitutionalAssetsBound: boolean;
  readonly budgetStatus: {
    readonly withinLimits: boolean;
  };
}

export interface WorkerTrustAssessorDependencies {
  readonly eventPublisher: Pick<EventPublisher, "publish">;
  readonly now?: () => string;
  readonly generateAssessmentId?: () => string;
}

const TRUST_FACTORS = [
  "governance_lease_active",
  "hard_constraints_present",
  "tool_set_restricted",
  "constitutional_assets_bound",
  "budget_within_limits"
] as const satisfies readonly TrustAssessmentFactor[];

export class WorkerTrustAssessor {
  public constructor(private readonly deps: WorkerTrustAssessorDependencies) {}

  public async assess(context: TrustAssessmentContext): Promise<Readonly<WorkerTrustAssessment>> {
    const factors = evaluateFactors(context);
    const assessment = WorkerTrustAssessmentSchema.parse({
      assessment_id: this.deps.generateAssessmentId?.() ?? randomUUID(),
      worker_run_id: context.workerRun.worker_run_id,
      workspace_id: context.workerRun.workspace_id,
      trust_level: deriveTrustLevel(factors.length),
      factors,
      factor_details: {
        governance_lease_active: context.hasGovernanceLease
          ? "Active governance lease found."
          : "No active governance lease.",
        hard_constraints_present:
          context.hardConstraintCount > 0
            ? `Resolved hard constraints: ${context.hardConstraintCount}.`
            : "No hard constraints resolved.",
        tool_set_restricted: context.toolSetRestricted
          ? "Restricted tool set is active."
          : "Restricted tool set is not active.",
        constitutional_assets_bound: context.constitutionalAssetsBound
          ? "Constitutional prompt assets are bound."
          : "Constitutional prompt assets are not bound.",
        budget_within_limits: context.budgetStatus.withinLimits
          ? "Narrative budget is within limits."
          : "Narrative budget exceeded limits."
      },
      assessed_at: this.deps.now?.() ?? new Date().toISOString()
    });

    await this.deps.eventPublisher.publish(createTrustAssessedEvent(context.workerRun, assessment));
    return assessment;
  }
}

function evaluateFactors(context: TrustAssessmentContext): readonly TrustAssessmentFactor[] {
  const factors: TrustAssessmentFactor[] = [];
  for (const factor of TRUST_FACTORS) {
    if (isFactorPresent(factor, context)) {
      factors.push(factor);
    }
  }
  return Object.freeze(factors);
}

function isFactorPresent(factor: TrustAssessmentFactor, context: TrustAssessmentContext): boolean {
  switch (factor) {
    case "governance_lease_active":
      return context.hasGovernanceLease;
    case "hard_constraints_present":
      return context.hardConstraintCount > 0;
    case "tool_set_restricted":
      return context.toolSetRestricted;
    case "constitutional_assets_bound":
      return context.constitutionalAssetsBound;
    case "budget_within_limits":
      return context.budgetStatus.withinLimits;
    default:
      return false;
  }
}

function deriveTrustLevel(presentFactorCount: number): WorkerTrustLevel {
  if (presentFactorCount === 5) {
    return "high";
  }
  if (presentFactorCount >= 3) {
    return "standard";
  }
  if (presentFactorCount >= 1) {
    return "low";
  }
  return "untrusted";
}

function createTrustAssessedEvent(
  workerRun: Readonly<DelegatedWorkerRun>,
  assessment: Readonly<WorkerTrustAssessment>
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: ObligationTrustNarrativeEventType.WORKER_TRUST_ASSESSED,
    entity_type: "worker_run",
    entity_id: workerRun.worker_run_id,
    workspace_id: workerRun.workspace_id,
    run_id: workerRun.principal_run_id,
    caused_by: "system",
    payload_json: WorkerTrustAssessedPayloadSchema.parse({
      assessment_id: assessment.assessment_id,
      worker_run_id: assessment.worker_run_id,
      trust_level: assessment.trust_level,
      factors: assessment.factors
    })
  };
}
