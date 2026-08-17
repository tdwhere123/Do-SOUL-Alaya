import type { PathPlasticityWatermarkRepo } from "@do-soul/alaya-storage";

/**
 * Compatibility state for residual path-plasticity Garden tasks and lookup
 * telemetry. Causal usage affects recall only through temporal receipt
 * projection; this module has no path mutation owner.
 */

/**
 * In-process per-workspace high-water mark for the path-plasticity
 * Librarian task. Without a watermark, every Librarian tick would process
 * the rolling 24h window and reapply each receipt repeatedly.
 *
 * Contract:
 *   - First tick on a workspace resolves `nowIso - initialLookbackMs`
 *     (default 24h) without advancing durable state.
 *   - The daemon marks `processedThroughIso` only after the Garden task
 *     succeeds. Failed or timed-out tasks therefore replay the same window
 *     after daemon restart instead of skipping usage rows.
 */
export interface PathPlasticityWatermarkRegistry {
  getSince(workspaceId: string, nowIso: string): string;
  markProcessed(
    workspaceId: string,
    processedThroughIso: string,
    processedAuditEventId: string | null,
    updatedAtIso: string
  ): void;
}

export function createPathPlasticityWatermarkRegistry(opts?: {
  readonly initialLookbackMs?: number;
  readonly watermarkRepo?: PathPlasticityWatermarkRepo;
}): PathPlasticityWatermarkRegistry {
  const lookbackMs = opts?.initialLookbackMs ?? 24 * 60 * 60 * 1000;
  const watermarks = new Map<string, string>();
  return {
    getSince(workspaceId: string, nowIso: string): string {
      const prior =
        opts?.watermarkRepo?.findByWorkspaceId(workspaceId)?.last_processed_reported_at ??
        watermarks.get(workspaceId);
      return prior ?? new Date(Date.parse(nowIso) - lookbackMs).toISOString();
    },
    markProcessed(
      workspaceId: string,
      processedThroughIso: string,
      processedAuditEventId: string | null,
      updatedAtIso: string
    ): void {
      const record = {
        workspace_id: workspaceId,
        last_processed_reported_at: processedThroughIso,
        last_processed_audit_event_id: processedAuditEventId,
        updated_at: updatedAtIso
      };
      opts?.watermarkRepo?.upsert(record);
      watermarks.set(workspaceId, processedThroughIso);
    }
  };
}

export interface PathPlasticityLookupTelemetrySnapshot {
  readonly lookup_count: number;
  readonly sample_count: number;
  readonly duration_p99_ms: number | null;
  readonly window_size: number;
}

export interface PathPlasticityLookupTelemetry {
  observe(durationMs: number): void;
  snapshot(): PathPlasticityLookupTelemetrySnapshot;
  reset(): void;
}

export function createPathPlasticityLookupTelemetry(options?: {
  readonly windowSize?: number;
}): PathPlasticityLookupTelemetry {
  const windowSize = options?.windowSize ?? 128;
  let lookupCount = 0;
  const durations: number[] = [];

  return {
    observe(durationMs: number): void {
      lookupCount += 1;
      durations.push(Math.max(0, durationMs));
      if (durations.length > windowSize) {
        durations.splice(0, durations.length - windowSize);
      }
    },
    snapshot(): PathPlasticityLookupTelemetrySnapshot {
      if (durations.length === 0) {
        return Object.freeze({
          lookup_count: lookupCount,
          sample_count: 0,
          duration_p99_ms: null,
          window_size: windowSize
        });
      }

      const sorted = [...durations].sort((left, right) => left - right);
      const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1);
      const durationP99 = sorted[index] ?? null;
      return Object.freeze({
        lookup_count: lookupCount,
        sample_count: durations.length,
        duration_p99_ms: durationP99,
        window_size: windowSize
      });
    },
    reset(): void {
      lookupCount = 0;
      durations.splice(0, durations.length);
    }
  };
}

export const defaultRecallPathPlasticityLookupTelemetry =
  createPathPlasticityLookupTelemetry();
