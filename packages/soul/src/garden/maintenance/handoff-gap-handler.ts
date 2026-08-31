import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  GapRecordSchema,
  HandoffRecordSchema,
  RetentionPolicy,
  type CandidateMemorySignal,
  type GapRecord,
  type HandoffRecord
} from "@do-soul/alaya-protocol";

export interface HandoffGapCreatedObject {
  readonly object_kind: "handoff_record" | "gap_record";
  readonly object_id: string;
}

export interface HandoffGapHandler {
  createFromSignal(signal: CandidateMemorySignal): HandoffGapCreatedObject;
  listHandoffs(): readonly GapOrHandoffRecord[];
  clearExpired(nowIso?: string): void;
}

export type GapOrHandoffRecord = Readonly<HandoffRecord> | Readonly<GapRecord>;

interface InMemoryHandoffGapHandlerOptions {
  readonly ttlMs?: number;
  readonly now?: () => string;
}

const GAP_OBJECT_KINDS = new Set(["gap", "gap_record", "context_gap"]);

export class InMemoryHandoffGapHandler implements HandoffGapHandler {
  private readonly ttlMs: number;
  private readonly now: () => string;
  private readonly handoffs = new Map<string, Readonly<HandoffRecord>>();
  private readonly gaps = new Map<string, Readonly<GapRecord>>();

  public constructor(options: InMemoryHandoffGapHandlerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 86_400_000;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public createFromSignal(signal: CandidateMemorySignal): HandoffGapCreatedObject {
    const nowIso = this.now();
    const expiresAt = new Date(Date.parse(nowIso) + this.ttlMs).toISOString();

    if (looksLikeGapSignal(signal)) {
      const record = GapRecordSchema.parse({
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
      });

      this.gaps.set(record.runtime_id, record);
      return {
        object_kind: "gap_record",
        object_id: record.runtime_id
      };
    }

    const handoff = HandoffRecordSchema.parse({
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
    });

    this.handoffs.set(handoff.runtime_id, handoff);

    return {
      object_kind: "handoff_record",
      object_id: handoff.runtime_id
    };
  }

  public listHandoffs(): readonly GapOrHandoffRecord[] {
    return [...this.handoffs.values(), ...this.gaps.values()];
  }

  public clearExpired(nowIso = this.now()): void {
    const nowMillis = Date.parse(nowIso);

    for (const [recordId, record] of this.handoffs.entries()) {
      if (record.expires_at !== null && Date.parse(record.expires_at) <= nowMillis) {
        this.handoffs.delete(recordId);
      }
    }

    for (const [recordId, record] of this.gaps.entries()) {
      if (record.expires_at !== null && Date.parse(record.expires_at) <= nowMillis) {
        this.gaps.delete(recordId);
      }
    }
  }
}

function looksLikeGapSignal(signal: CandidateMemorySignal): boolean {
  if (signal.raw_payload.gap_detected === true) {
    return true;
  }

  return GAP_OBJECT_KINDS.has(normalizeObjectKind(signal.object_kind));
}

function normalizeObjectKind(objectKind: string): string {
  return objectKind.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
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
