import {
  ComputeRecallGardenEventType,
  HealthEventKind,
  RecallEmbeddingSupplementDegradedPayloadSchema,
  type EventLogEntry
} from "@do-soul/alaya-protocol";

import { toErrorMessage } from "./helpers.js";
import type { EmbeddingRecallServiceDependencies } from "./types.js";

export interface EmbeddingRecallTelemetryDependencies {
  readonly eventLogRepo: EmbeddingRecallServiceDependencies["eventLogRepo"];
  readonly healthJournalRecorder: EmbeddingRecallServiceDependencies["healthJournalRecorder"];
  readonly provider: EmbeddingRecallServiceDependencies["provider"];
  readonly now: () => string;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

// Every write is best-effort: a sink failure warns but never aborts recall.
export class EmbeddingRecallTelemetry {
  public constructor(private readonly deps: EmbeddingRecallTelemetryDependencies) {}

  public async recordDegraded(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly reason: string;
    readonly baseCandidateCount: number;
    readonly fallbackCandidateCount: number;
  }): Promise<void> {
    try {
      await this.deps.eventLogRepo.append({
        event_type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED,
        entity_type: "recall_embedding_supplement",
        entity_id: params.queryId,
        workspace_id: params.workspaceId,
        run_id: params.runId,
        caused_by: "system",
        payload_json: RecallEmbeddingSupplementDegradedPayloadSchema.parse({
          workspace_id: params.workspaceId,
          run_id: params.runId,
          query_id: params.queryId,
          degradation_reason: params.reason,
          base_candidate_count: params.baseCandidateCount,
          fallback_candidate_count: params.fallbackCandidateCount,
          degraded_at: this.deps.now()
        })
      });
    } catch (error) {
      this.deps.warn("embedding supplement degraded telemetry failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        query_id: params.queryId,
        stage: "event_log",
        error: toErrorMessage(error)
      });
    }

    try {
      await this.deps.healthJournalRecorder?.record({
        event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
        workspace_id: params.workspaceId,
        run_id: params.runId,
        summary: "Embedding supplement degraded to keyword-only recall.",
        detail_json: {
          query_id: params.queryId,
          reason: params.reason,
          base_candidate_count: params.baseCandidateCount,
          fallback_candidate_count: params.fallbackCandidateCount,
          provider_kind: this.deps.provider.providerKind,
          model_id: this.deps.provider.modelId,
          embedding_enabled: this.deps.provider.isAvailable
        }
      });
    } catch (error) {
      this.deps.warn("embedding supplement degraded telemetry failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        query_id: params.queryId,
        stage: "health_journal",
        error: toErrorMessage(error)
      });
    }
  }

  public async appendTelemetrySafely(params: {
    readonly stage: "queried" | "merged";
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly queryId: string;
    readonly entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">;
  }): Promise<void> {
    try {
      await this.deps.eventLogRepo.append(params.entry);
    } catch (error) {
      this.deps.warn("embedding supplement telemetry failed", {
        workspace_id: params.workspaceId,
        run_id: params.runId,
        query_id: params.queryId,
        stage: params.stage,
        error: toErrorMessage(error)
      });
    }
  }
}
