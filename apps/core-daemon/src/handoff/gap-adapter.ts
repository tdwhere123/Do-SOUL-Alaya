import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  GapRecordSchema,
  HandoffRecordSchema,
  RetentionPolicy,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import {
  type HandoffGapCreatedObject,
  type HandoffGapHandler,
  type GapOrHandoffRecord
} from "@do-soul/alaya-soul";
import { SqliteHandoffGapRepo } from "@do-soul/alaya-storage";

// ---------------------------------------------------------------------------
// Gap detection helpers — replicated from InMemoryHandoffGapHandler
// ---------------------------------------------------------------------------

const GAP_OBJECT_KINDS = new Set(["gap", "gap_record", "context_gap"]);

function normalizeObjectKind(objectKind: string): string {
  return objectKind.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function looksLikeGapSignal(signal: CandidateMemorySignal): boolean {
  if (signal.raw_payload.gap_detected === true) {
    return true;
  }
  return GAP_OBJECT_KINDS.has(normalizeObjectKind(signal.object_kind));
}

function buildSignalSummary(signal: CandidateMemorySignal): string {
  const excerpt = signal.raw_payload.excerpt;
  if (typeof excerpt === "string" && excerpt.trim().length > 0) {
    return excerpt.trim();
  }

  const matchedText = signal.raw_payload.matched_text;
  if (typeof matchedText === "string" && matchedText.trim().length > 0) {
    return matchedText.trim();
  }

  return `Signal ${signal.signal_id} (${signal.signal_kind})`;
}

// ---------------------------------------------------------------------------
// SqliteHandoffGapAdapter
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 86_400_000;

export class SqliteHandoffGapAdapter implements HandoffGapHandler {
  private readonly repo: SqliteHandoffGapRepo;
  private readonly ttlMs: number;

  public constructor(repo: SqliteHandoffGapRepo, ttlMs = DEFAULT_TTL_MS) {
    this.repo = repo;
    this.ttlMs = ttlMs;
  }

  public createFromSignal(signal: CandidateMemorySignal): HandoffGapCreatedObject {
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.parse(nowIso) + this.ttlMs).toISOString();

    if (looksLikeGapSignal(signal)) {
      const record = this.repo.createGap(
        GapRecordSchema.parse({
          runtime_id: randomUUID(),
          object_kind: ControlPlaneObjectKind.GAP_RECORD,
          task_surface_ref: signal.surface_id,
          expires_at: expiresAt,
          derived_from: signal.signal_id,
          retention_policy: RetentionPolicy.RUN_SCOPED,
          gap_kind: "context_gap",
          detected_in_run_id: signal.run_id,
          surface_id: signal.surface_id,
          description: buildSignalSummary(signal),
          ttl_ms: this.ttlMs,
          recurrence_runs: null,
          recurrence_surfaces: null,
          governance_impact: null,
          unresolved_age_ms: null,
          upgrade_candidate: null
        })
      );

      return { object_kind: "gap_record", object_id: record.runtime_id };
    }

    const handoff = this.repo.createHandoff(
      HandoffRecordSchema.parse({
        runtime_id: randomUUID(),
        object_kind: ControlPlaneObjectKind.HANDOFF_RECORD,
        task_surface_ref: signal.surface_id,
        expires_at: expiresAt,
        derived_from: signal.signal_id,
        retention_policy: RetentionPolicy.RUN_SCOPED,
        handoff_kind: "run_handoff",
        source_run_id: signal.run_id,
        target_run_id: null,
        surface_id: signal.surface_id,
        ttl_ms: this.ttlMs,
        recurrence_runs: null,
        recurrence_surfaces: null,
        governance_impact: null,
        unresolved_age_ms: null,
        upgrade_candidate: null
      })
    );

    return { object_kind: "handoff_record", object_id: handoff.runtime_id };
  }

  public listHandoffs(): readonly GapOrHandoffRecord[] {
    return this.repo.listAll();
  }

  public clearExpired(nowIso?: string): void {
    this.repo.deleteExpired(nowIso ?? new Date().toISOString());
  }
}

// ---------------------------------------------------------------------------
// HandoffGap cleanup port factory for Janitor integration
// ---------------------------------------------------------------------------

export interface HandoffGapCleanupPort {
  findExpiredObjects(
    nowIso: string
  ): Promise<ReadonlyArray<{ object_kind: string; object_id: string; expires_at: string }>>;
  removeExpiredObjects(
    objects: ReadonlyArray<{ object_kind: string; object_id: string; expires_at: string }>
  ): Promise<void>;
}

export function buildHandoffGapCleanupPort(repo: SqliteHandoffGapRepo): HandoffGapCleanupPort {
  return {
    findExpiredObjects: async (nowIso: string) => {
      return repo.findExpiredObjects(nowIso);
    },
    removeExpiredObjects: async (
      objects: ReadonlyArray<{ object_kind: string; object_id: string; expires_at: string }>
    ) => {
      for (const obj of objects) {
        repo.deleteById(obj.object_id);
      }
    }
  };
}
