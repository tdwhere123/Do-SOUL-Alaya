import { createHash } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  SignalState,
  buildGardenSourceTurnFallbackV2ReceiptPreimage,
  formatGardenSourceTurnFallbackArtifactRef,
  formatGardenSourceTurnFallbackV2SourceHash,
  type CandidateMemorySignal,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { SqliteSignalRepo } from "../../../repos/signal/signal-repo.js";
import type { StorageDatabase } from "../../../sqlite/db.js";
import {
  createEvidenceCapsule,
  type createEvidenceCapsuleRepo
} from "./evidence-capsule-repo-fixture.js";

export const USER_QUESTION = "Which backpack should I use for a rainy commute?";
export const ASSISTANT_RECOMMENDATION =
  "Choose the moss-green TrailShell pack; its roll-top keeps a laptop dry in rain. It also dries quickly overnight.";

type ProjectionMode = "user" | "assistant" | "assistant_only";
type EvidenceRepo = Awaited<ReturnType<typeof createEvidenceCapsuleRepo>>["repo"];

export async function seedFallbackV2(
  database: StorageDatabase,
  repo: EvidenceRepo,
  evidenceId: string,
  projectionRole: "user" | "assistant" = "user"
): Promise<{
  readonly signal: CandidateMemorySignal;
  readonly capsule: EvidenceCapsule;
}> {
  return seedFallbackV2Mode(database, repo, evidenceId, projectionRole);
}

export async function seedAssistantOnlyFallbackV2(
  database: StorageDatabase,
  repo: EvidenceRepo,
  evidenceId: string
): Promise<{
  readonly signal: CandidateMemorySignal;
  readonly capsule: EvidenceCapsule;
}> {
  return seedFallbackV2Mode(database, repo, evidenceId, "assistant_only");
}

async function seedFallbackV2Mode(
  database: StorageDatabase,
  repo: EvidenceRepo,
  evidenceId: string,
  mode: ProjectionMode
): Promise<{
  readonly signal: CandidateMemorySignal;
  readonly capsule: EvidenceCapsule;
}> {
  const signal = createFallbackV2Signal(mode);
  const materialized = await persistMaterializedSignal(database, signal);
  const capsule = createFallbackV2Capsule(evidenceId, materialized, mode);
  await repo.create(capsule, mode === "user" ? [] : [{
    projection_id: 1,
    projection_kind: "assistant_observation",
    content: ASSISTANT_RECOMMENDATION
  }]);
  return { signal: materialized, capsule };
}

function createFallbackV2Signal(mode: ProjectionMode): CandidateMemorySignal {
  const receiptInput = createFallbackV2ReceiptInput(mode);
  const digest = sha256(buildGardenSourceTurnFallbackV2ReceiptPreimage(receiptInput));
  return CandidateMemorySignalSchema.parse({
    signal_id: receiptInput.signal_id,
    workspace_id: receiptInput.workspace_id,
    run_id: receiptInput.run_id,
    surface_id: receiptInput.surface_id,
    source: "garden_compile",
    signal_kind: "potential_evidence_anchor",
    signal_state: "emitted",
    object_kind: "source_turn",
    scope_hint: null,
    domain_tags: ["source-turn"],
    confidence: 1,
    evidence_refs: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      full_turn_content: receiptInput.source_corpus,
      source_role_spans: receiptInput.source_role_spans,
      evidence_preservation: {
        version: 2,
        reason: receiptInput.reason,
        truncated: false,
        chars_clipped: 0,
        source_receipt_sha256: digest
      }
    },
    source_observation: receiptInput.source_observation,
    created_at: receiptInput.created_at
  });
}

function createFallbackV2ReceiptInput(mode: ProjectionMode) {
  const userContent = mode === "user" ? "Source fact" : USER_QUESTION;
  const assistantContent = mode === "user" ? "Acknowledged" : ASSISTANT_RECOMMENDATION;
  const corpus = mode === "assistant_only"
    ? `Assistant: ${assistantContent}`
    : `User: ${userContent}\nAssistant: ${assistantContent}`;
  const userEnd = 6 + userContent.length;
  const assistantStart = mode === "assistant_only"
    ? "Assistant: ".length
    : userEnd + "\nAssistant: ".length;
  return {
    signal_id: "signal-v2",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    created_at: "2026-03-20T00:00:00.000Z",
    source_observation: {
      observed_at: "2026-03-20T00:00:00.000Z",
      authority: "trusted_host_event" as const,
      source_event_id: "source-signal-v2"
    },
    source_corpus: corpus,
    source_role_spans: mode === "assistant_only"
      ? [{ role: "assistant" as const, start: assistantStart, end: corpus.length }]
      : [
        { role: "user" as const, start: 6, end: userEnd },
        { role: "assistant" as const, start: assistantStart, end: corpus.length }
      ],
    reason: "empty_extraction" as const,
    truncated: false,
    chars_clipped: 0
  };
}

async function persistMaterializedSignal(
  database: StorageDatabase,
  signal: CandidateMemorySignal
): Promise<CandidateMemorySignal> {
  const signalRepo = new SqliteSignalRepo(database);
  await signalRepo.create(signal);
  await signalRepo.updateState(signal.signal_id, SignalState.MATERIALIZED);
  return CandidateMemorySignalSchema.parse({
    ...signal,
    signal_state: SignalState.MATERIALIZED
  });
}

function createFallbackV2Capsule(
  evidenceId: string,
  signal: CandidateMemorySignal,
  mode: ProjectionMode
): EvidenceCapsule {
  const receipt = createFallbackV2ReceiptInput(mode);
  const userSpan = receipt.source_role_spans.find((item) => item.role === "user");
  const excerpt = userSpan === undefined
    ? receipt.source_corpus
    : receipt.source_corpus.slice(userSpan.start, userSpan.end);
  return createEvidenceCapsule({
    object_id: evidenceId,
    lifecycle_state: "active",
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    evidence_health_state: "verified",
    gist: receipt.source_corpus,
    excerpt,
    source_hash: formatGardenSourceTurnFallbackV2SourceHash(receiptDigest(signal)),
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: formatGardenSourceTurnFallbackArtifactRef(signal.signal_id)
    },
    run_id: signal.run_id,
    workspace_id: signal.workspace_id,
    surface_id: signal.surface_id
  });
}

export function tamperAssistantObservationProof(
  database: StorageDatabase,
  proof: Readonly<{ readonly signal: CandidateMemorySignal; readonly capsule: EvidenceCapsule }>,
  tamper: "digest" | "source_hash" | "workspace" | "span" | "content"
): void {
  if (tamper === "content" || tamper === "workspace") {
    const column = tamper === "content" ? "content" : "workspace_id";
    const value = tamper === "content"
      ? "tampered Assistant recommendation"
      : "other-workspace";
    database.connection.prepare(`
      UPDATE evidence_search_projections
      SET ${column} = ?
      WHERE evidence_object_id = ? AND projection_kind = 'assistant_observation'
    `).run(value, proof.capsule.object_id);
    return;
  }
  if (tamper === "source_hash") {
    database.connection.prepare("UPDATE evidence_capsules SET source_hash = ? WHERE object_id = ?")
      .run("sha256:garden-source-turn-fallback-v2:tampered", proof.capsule.object_id);
    return;
  }
  tamperSignalReceipt(database, proof.signal, tamper);
}

function tamperSignalReceipt(
  database: StorageDatabase,
  signal: CandidateMemorySignal,
  tamper: "digest" | "span"
): void {
  const rawPayload = signal.raw_payload;
  const preservation = rawPayload.evidence_preservation as Record<string, unknown>;
  const nextPayload = tamper === "digest"
    ? {
      ...rawPayload,
      evidence_preservation: { ...preservation, source_receipt_sha256: "0".repeat(64) }
    }
    : {
      ...rawPayload,
      source_role_spans: (rawPayload.source_role_spans as readonly Record<string, unknown>[]).map((span) =>
        span.role === "assistant" ? { ...span, start: Number(span.start) + 1 } : span
      )
    };
  database.connection.prepare("UPDATE signals SET raw_payload_json = ? WHERE signal_id = ?")
    .run(JSON.stringify(nextPayload), signal.signal_id);
}

export function ownerMatch(objectId: string) {
  return { object_id: objectId };
}

export function assistantMatch(objectId: string) {
  return {
    object_id: objectId,
    matched_projection: {
      projection_id: 1,
      projection_kind: "assistant_observation" as const
    }
  };
}

function receiptDigest(signal: CandidateMemorySignal): string {
  const preservation = signal.raw_payload.evidence_preservation as {
    readonly source_receipt_sha256: string;
  };
  return preservation.source_receipt_sha256;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
