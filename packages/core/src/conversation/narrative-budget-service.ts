import {
  NarrativeConsolidationTriggeredPayloadSchema,
  NarrativeBudgetExceededPayloadSchema,
  ObligationTrustNarrativeEventType,
  type EventLogEntry,
  type NarrativeBudgetConfig
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "../runtime/event-publisher.js";

export interface NarrativeBudgetRepoPort {
  countDigestsByRun(runId: string): Promise<number>;
  totalDigestBytesByRun(runId: string): Promise<number>;
}

export interface NarrativeBudgetServiceDependencies {
  readonly repo: NarrativeBudgetRepoPort;
  readonly eventPublisher: Pick<EventPublisher, "publish">;
  readonly eventLogReader?: {
    hasNarrativeConsolidationTrigger(runId: string, digestCountBefore: number): Promise<boolean>;
  };
  readonly now?: () => string;
}

export class NarrativeBudgetService {
  private readonly triggerInFlightKeys = new Set<string>();

  public constructor(private readonly deps: NarrativeBudgetServiceDependencies) {}

  public async checkBudget(
    workspaceId: string,
    runId: string,
    config: NarrativeBudgetConfig
  ): Promise<Readonly<{ withinLimits: boolean; currentBytes: number; currentCount: number }>> {
    const [currentCount, currentBytes] = await Promise.all([
      this.deps.repo.countDigestsByRun(runId),
      this.deps.repo.totalDigestBytesByRun(runId)
    ]);
    const thresholdMaxBytes = applyThresholdLimit(
      config.max_total_digest_bytes,
      config.consolidation_threshold_pct
    );
    const thresholdMaxCount = applyThresholdLimit(
      config.max_digests_per_run,
      config.consolidation_threshold_pct
    );
    const withinLimits =
      currentBytes <= thresholdMaxBytes && currentCount <= thresholdMaxCount;

    if (!withinLimits) {
      await this.deps.eventPublisher.publish(createBudgetExceededEvent({
        workspaceId,
        runId,
        currentBytes,
        maxBytes: thresholdMaxBytes,
        currentCount,
        maxCount: thresholdMaxCount
      }));
    }

    return Object.freeze({
      withinLimits,
      currentBytes,
      currentCount
    });
  }

  public async triggerConsolidation(workspaceId: string, runId: string): Promise<void> {
    const digestCountBefore = await this.deps.repo.countDigestsByRun(runId);

    if (await this.hasMatchingTriggerInHistory(runId, digestCountBefore)) {
      return;
    }

    const inFlightKey = `${runId}:${digestCountBefore}`;
    if (this.triggerInFlightKeys.has(inFlightKey)) {
      return;
    }
    this.triggerInFlightKeys.add(inFlightKey);

    try {
      if (await this.hasMatchingTriggerInHistory(runId, digestCountBefore)) {
        return;
      }

      await this.deps.eventPublisher.publish(
        createConsolidationTriggeredEvent({
          workspaceId,
          runId,
          triggerReason: "budget_exceeded",
          digestCountBefore
        })
      );
    } catch (error) {
      throw error;
    } finally {
      this.triggerInFlightKeys.delete(inFlightKey);
    }
  }

  private async hasMatchingTriggerInHistory(
    runId: string,
    digestCountBefore: number
  ): Promise<boolean> {
    if (this.deps.eventLogReader === undefined) {
      return false;
    }

    return await this.deps.eventLogReader.hasNarrativeConsolidationTrigger(runId, digestCountBefore);
  }
}

function applyThresholdLimit(maxValue: number, thresholdPct: number): number {
  if (maxValue === 0) {
    return 0;
  }

  if (thresholdPct === 0) {
    return maxValue;
  }

  return Math.ceil((maxValue * thresholdPct) / 100);
}

function createBudgetExceededEvent(params: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly currentBytes: number;
  readonly maxBytes: number;
  readonly currentCount: number;
  readonly maxCount: number;
}): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: ObligationTrustNarrativeEventType.NARRATIVE_BUDGET_EXCEEDED,
    entity_type: "run",
    entity_id: params.runId,
    workspace_id: params.workspaceId,
    run_id: params.runId,
    caused_by: "system",
    payload_json: NarrativeBudgetExceededPayloadSchema.parse({
      workspace_id: params.workspaceId,
      run_id: params.runId,
      current_bytes: params.currentBytes,
      max_bytes: params.maxBytes,
      current_count: params.currentCount,
      max_count: params.maxCount
    })
  };
}

function createConsolidationTriggeredEvent(params: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly triggerReason: string;
  readonly digestCountBefore: number;
}): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: ObligationTrustNarrativeEventType.NARRATIVE_CONSOLIDATION_TRIGGERED,
    entity_type: "run",
    entity_id: params.runId,
    workspace_id: params.workspaceId,
    run_id: params.runId,
    caused_by: "system",
    payload_json: NarrativeConsolidationTriggeredPayloadSchema.parse({
      workspace_id: params.workspaceId,
      run_id: params.runId,
      trigger_reason: params.triggerReason,
      digest_count_before: params.digestCountBefore
    })
  };
}
