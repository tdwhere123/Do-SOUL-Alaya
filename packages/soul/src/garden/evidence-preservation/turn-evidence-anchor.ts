import {
  CandidateMemorySignalSchema,
  SignalKind,
  SignalSource,
  SignalState,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";

const RAW_PAYLOAD_MAX_SERIALIZED_CHARS = 16_384;
const GARDEN_TURN_EVIDENCE_ARTIFACT_PREFIX = "alaya:garden-turn-evidence:";

type EvidenceFallbackReason = "empty_extraction" | "no_evidence_created";

type EvidenceFallbackInput = Readonly<{
  turnContent: string;
  reason: EvidenceFallbackReason;
  signalId: string;
  workspaceId: string;
  runId: string;
  surfaceId: string | null;
  createdAt: string;
  sourceObservation: CandidateMemorySignal["source_observation"];
}>;

/** Build a host-originated evidence-only signal without asserting semantic truth. */
export function buildGardenTurnEvidenceFallback(
  input: EvidenceFallbackInput
): CandidateMemorySignal | null {
  const normalized = input.turnContent.trim();
  if (normalized.length === 0) return null;
  const rawPayload = buildBoundedRawPayload(normalized, input.reason);
  return CandidateMemorySignalSchema.parse({
    signal_id: input.signalId,
    workspace_id: input.workspaceId,
    run_id: input.runId,
    surface_id: input.surfaceId,
    source: SignalSource.GARDEN_COMPILE,
    signal_kind: SignalKind.POTENTIAL_EVIDENCE_ANCHOR,
    signal_state: SignalState.EMITTED,
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
    raw_payload: rawPayload,
    source_observation: input.sourceObservation,
    created_at: input.createdAt
  });
}

export function isGardenTurnEvidenceFallback(
  signal: CandidateMemorySignal
): boolean {
  if (
    signal.source !== SignalSource.GARDEN_COMPILE ||
    signal.signal_kind !== SignalKind.POTENTIAL_EVIDENCE_ANCHOR ||
    signal.object_kind !== "source_turn" ||
    signal.evidence_refs.length !== 0
  ) return false;
  const preservation = readRecord(signal.raw_payload.evidence_preservation);
  return readString(signal.raw_payload.full_turn_content) !== null &&
    preservation?.version === 1 &&
    (preservation.reason === "empty_extraction" || preservation.reason === "no_evidence_created") &&
    typeof preservation.truncated === "boolean" &&
    typeof preservation.chars_clipped === "number";
}

export function buildGardenTurnEvidenceArtifactRef(signalId: string): string {
  return `${GARDEN_TURN_EVIDENCE_ARTIFACT_PREFIX}${signalId}`;
}

function buildBoundedRawPayload(
  content: string,
  reason: EvidenceFallbackReason
): CandidateMemorySignal["raw_payload"] {
  let low = 1;
  let high = content.length;
  let best = buildRawPayload(content.slice(0, 1), content.length, reason);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = buildRawPayload(content.slice(0, middle), content.length, reason);
    if (JSON.stringify(candidate).length <= RAW_PAYLOAD_MAX_SERIALIZED_CHARS) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function buildRawPayload(
  source: string,
  originalLength: number,
  reason: EvidenceFallbackReason
) {
  return {
    full_turn_content: source,
    evidence_preservation: {
      version: 1,
      reason,
      truncated: source.length < originalLength,
      chars_clipped: originalLength - source.length
    }
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
