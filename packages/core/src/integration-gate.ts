import {
  WorkerRuntimeEventType,
  RuntimeCapabilitiesSchema,
  WorkerIntegrationStatusPayloadSchema,
  type DelegatedWorkerRun,
  type EventLogEntry,
  type RuntimeCapabilities
} from "@do-soul/alaya-protocol";
import { EventPublisherPropagationError, type EventPublisher } from "./event-publisher.js";

export const WORKER_INTEGRATION_STATUS_EVENT_TYPE = WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS;

const DEFAULT_CRITICAL_MISMATCHES = ["supports_streaming_updates"] as const;

export interface ExpectedRuntimeCapabilityProfile {
  readonly kind: string;
  readonly capabilities: RuntimeCapabilities;
  readonly criticalMismatches: readonly (keyof RuntimeCapabilities)[];
}

export interface RuntimeCapabilityMismatch {
  readonly flag: keyof RuntimeCapabilities;
  readonly expected: boolean;
  readonly actual: boolean;
}

export interface IntegrationGateDecision {
  readonly workerRunId: string;
  readonly level: "ignore_drift" | "soft_stale" | "hard_stale";
  readonly reason: string;
  readonly detectedAt: string;
  readonly mismatches: readonly RuntimeCapabilityMismatch[];
}

export interface IntegrationGateDependencies {
  readonly expectedProfile: ExpectedRuntimeCapabilityProfile;
  readonly eventPublisher: Pick<EventPublisher, "publish">;
  readonly now?: () => string;
}

export class IntegrationGatePublicationError extends Error {
  public readonly decision: IntegrationGateDecision;
  public readonly durableDecisionCommitted: boolean;

  public constructor(
    decision: IntegrationGateDecision,
    cause: unknown,
    durableDecisionCommitted: boolean
  ) {
    super("Integration gate failed to publish worker.integration_status.", {
      cause: cause instanceof Error ? cause : undefined
    });
    this.name = "IntegrationGatePublicationError";
    this.decision = decision;
    this.durableDecisionCommitted = durableDecisionCommitted;
  }
}

export const VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE: ExpectedRuntimeCapabilityProfile = Object.freeze({
  kind: "claude_code",
  capabilities: RuntimeCapabilitiesSchema.parse({
    supports_resume: false,
    supports_interrupt: true,
    supports_streaming_updates: true,
    supports_tool_events: false,
    supports_permission_requests: false,
    supports_artifact_events: true,
    supports_terminal_events: false
  }),
  criticalMismatches: DEFAULT_CRITICAL_MISMATCHES
});

export class IntegrationGate {
  public constructor(private readonly deps: IntegrationGateDependencies) {}

  public async check(
    workerRun: Readonly<DelegatedWorkerRun>,
    actualCapabilities: RuntimeCapabilities
  ): Promise<IntegrationGateDecision> {
    const detectedAt = this.deps.now?.() ?? new Date().toISOString();
    const expectedCapabilities = this.deps.expectedProfile.capabilities;
    const mismatches = collectMismatches(expectedCapabilities, RuntimeCapabilitiesSchema.parse(actualCapabilities));

    if (mismatches.length === 0) {
      return {
        workerRunId: workerRun.worker_run_id,
        level: "ignore_drift",
        reason: "Runtime capabilities match declared baseline.",
        detectedAt,
        mismatches
      };
    }

    const criticalFlags = new Set<keyof RuntimeCapabilities>([
      ...DEFAULT_CRITICAL_MISMATCHES,
      ...this.deps.expectedProfile.criticalMismatches
    ]);
    const level = mismatches.some((mismatch) => criticalFlags.has(mismatch.flag))
      ? "hard_stale"
      : "soft_stale";
    const reason = mismatches
      .map((mismatch) => `${String(mismatch.flag)} expected=${mismatch.expected} actual=${mismatch.actual}`)
      .join(", ");
    const decision: IntegrationGateDecision = {
      workerRunId: workerRun.worker_run_id,
      level,
      reason,
      detectedAt,
      mismatches
    };

    try {
      await this.deps.eventPublisher.publish(createIntegrationStatusEvent(workerRun, decision));
    } catch (error) {
      throw new IntegrationGatePublicationError(
        decision,
        error,
        error instanceof EventPublisherPropagationError
      );
    }

    return decision;
  }
}

function collectMismatches(
  expected: RuntimeCapabilities,
  actual: RuntimeCapabilities
): readonly RuntimeCapabilityMismatch[] {
  const flags = Object.keys(expected) as Array<keyof RuntimeCapabilities>;

  return flags
    .filter((flag) => expected[flag] !== actual[flag])
    .map((flag) => ({
      flag,
      expected: expected[flag],
      actual: actual[flag]
    }));
}

function createIntegrationStatusEvent(
  workerRun: Readonly<DelegatedWorkerRun>,
  decision: IntegrationGateDecision
): Omit<EventLogEntry, "event_id" | "created_at"> {
  return {
    event_type: WORKER_INTEGRATION_STATUS_EVENT_TYPE,
    entity_type: "worker_run",
    entity_id: workerRun.worker_run_id,
    workspace_id: workerRun.workspace_id,
    run_id: workerRun.principal_run_id,
    caused_by: "system",
    revision: 0,
    payload_json: WorkerIntegrationStatusPayloadSchema.parse({
      workerRunId: decision.workerRunId,
      level: decision.level,
      reason: decision.reason,
      detectedAt: decision.detectedAt
    })
  };
}
