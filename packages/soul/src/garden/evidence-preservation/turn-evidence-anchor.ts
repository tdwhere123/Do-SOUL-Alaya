import { createHash } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  SignalKind,
  SignalSource,
  SignalState,
  buildGardenSourceTurnFallbackReceiptPreimage,
  formatGardenSourceTurnFallbackArtifactRef,
  formatGardenSourceTurnFallbackSourceHash,
  verifyGardenSourceTurnFallbackReceipt,
  type CandidateMemorySignal,
  type GardenSourceTurnFallbackReason,
  type GardenSourceTurnFallbackReceiptInput
} from "@do-soul/alaya-protocol";

const RAW_PAYLOAD_MAX_SERIALIZED_CHARS = 16_384;

type EvidenceFallbackInput = Readonly<{
  turnContent: string;
  reason: GardenSourceTurnFallbackReason;
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
  const rawPayload = buildBoundedRawPayload(normalized, input);
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
  if (!hasMaterializableFallbackState(signal.signal_state)) return false;
  return verifyGardenSourceTurnFallbackReceipt(signal, digest) !== null;
}

export function buildGardenTurnEvidenceArtifactRef(signalId: string): string {
  return formatGardenSourceTurnFallbackArtifactRef(signalId);
}

export function resolveVerifiedGardenTurnEvidenceSourceHash(
  signal: CandidateMemorySignal,
  sourceCorpus: string
): string | null {
  if (!isGardenTurnEvidenceFallback(signal)) return null;
  const receipt = verifyGardenSourceTurnFallbackReceipt(signal, digest);
  return receipt !== null && sourceCorpus === receipt.source_corpus
    ? formatGardenSourceTurnFallbackSourceHash(receipt.digest)
    : null;
}

function buildBoundedRawPayload(
  content: string,
  input: EvidenceFallbackInput
): CandidateMemorySignal["raw_payload"] {
  let low = 1;
  let high = content.length;
  let best = buildRawPayload(content.slice(0, 1), content.length, input);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = buildRawPayload(content.slice(0, middle), content.length, input);
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
  input: EvidenceFallbackInput
) {
  const preservation = {
    version: 1,
    reason: input.reason,
    truncated: source.length < originalLength,
    chars_clipped: originalLength - source.length
  } as const;
  return {
    full_turn_content: source,
    evidence_preservation: {
      ...preservation,
      source_receipt_sha256: digest(buildGardenSourceTurnFallbackReceiptPreimage(
        buildReceiptInput(input, source, preservation)
      ))
    }
  };
}

function buildReceiptInput(
  input: EvidenceFallbackInput,
  source: string,
  preservation: FallbackPreservation
): GardenSourceTurnFallbackReceiptInput {
  return {
    signal_id: input.signalId,
    workspace_id: input.workspaceId,
    run_id: input.runId,
    surface_id: input.surfaceId,
    created_at: input.createdAt,
    source_observation: input.sourceObservation,
    source_corpus: source,
    reason: preservation.reason,
    truncated: preservation.truncated,
    chars_clipped: preservation.chars_clipped
  };
}

type FallbackPreservation = Readonly<{
  version: 1;
  reason: GardenSourceTurnFallbackReason;
  truncated: boolean;
  chars_clipped: number;
}>;

function hasMaterializableFallbackState(
  state: CandidateMemorySignal["signal_state"]
): boolean {
  return state === SignalState.EMITTED ||
    state === SignalState.NORMALIZED ||
    state === SignalState.TRIAGED ||
    state === SignalState.COMPILED;
}

function digest(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}
