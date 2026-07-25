import type { CandidateMemorySignal } from "../signals/candidate-memory-signal.js";

export const GARDEN_SOURCE_TURN_FALLBACK_ARTIFACT_PREFIX =
  "alaya:garden-turn-evidence:";
export const GARDEN_SOURCE_TURN_FALLBACK_SOURCE_HASH_PREFIX =
  "sha256:garden-source-turn-fallback-v1:";

export type GardenSourceTurnFallbackReason =
  | "empty_extraction"
  | "no_evidence_created";

export interface GardenSourceTurnFallbackReceiptInput {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly created_at: string;
  readonly source_observation: CandidateMemorySignal["source_observation"];
  readonly source_corpus: string;
  readonly reason: GardenSourceTurnFallbackReason;
  readonly truncated: boolean;
  readonly chars_clipped: number;
}

export interface GardenSourceTurnFallbackReceipt
  extends GardenSourceTurnFallbackReceiptInput {
  readonly digest: string;
  readonly preimage: string;
}

export function buildGardenSourceTurnFallbackReceiptPreimage(
  input: Readonly<GardenSourceTurnFallbackReceiptInput>
): string {
  return JSON.stringify({
    kind: "garden-source-turn-fallback-v1",
    signal_id: input.signal_id,
    workspace_id: input.workspace_id,
    run_id: input.run_id,
    surface_id: input.surface_id,
    created_at: input.created_at,
    source_observation: normalizeObservation(input.source_observation),
    reason: input.reason,
    truncated: input.truncated,
    chars_clipped: input.chars_clipped,
    source: input.source_corpus
  });
}

export function formatGardenSourceTurnFallbackArtifactRef(
  signalId: string
): string {
  return `${GARDEN_SOURCE_TURN_FALLBACK_ARTIFACT_PREFIX}${signalId}`;
}

export function readGardenSourceTurnFallbackArtifactSignalId(
  value: string | null
): string | null {
  if (value?.startsWith(GARDEN_SOURCE_TURN_FALLBACK_ARTIFACT_PREFIX) !== true) {
    return null;
  }
  const signalId = value.slice(GARDEN_SOURCE_TURN_FALLBACK_ARTIFACT_PREFIX.length);
  return signalId.trim().length > 0 && signalId === signalId.trim()
    ? signalId
    : null;
}

export function formatGardenSourceTurnFallbackSourceHash(
  digest: string
): string {
  return `${GARDEN_SOURCE_TURN_FALLBACK_SOURCE_HASH_PREFIX}${digest}`;
}

export function readGardenSourceTurnFallbackSourceHashDigest(
  value: string | null
): string | null {
  if (value?.startsWith(GARDEN_SOURCE_TURN_FALLBACK_SOURCE_HASH_PREFIX) !== true) {
    return null;
  }
  const digest = value.slice(GARDEN_SOURCE_TURN_FALLBACK_SOURCE_HASH_PREFIX.length);
  return isSha256(digest) ? digest : null;
}

export function hasGardenSourceTurnFallbackReceiptFormat(input: {
  readonly artifact_ref: string | null;
  readonly source_hash: string | null;
}): boolean {
  return readGardenSourceTurnFallbackArtifactSignalId(input.artifact_ref) !== null &&
    readGardenSourceTurnFallbackSourceHashDigest(input.source_hash) !== null;
}

export function readGardenSourceTurnFallbackReceipt(
  signal: Readonly<CandidateMemorySignal>
): Readonly<GardenSourceTurnFallbackReceipt> | null {
  // Lifecycle is intentionally a consumer gate: Soul admits only pre-
  // materialization states, while snapshot authority verifies the final row.
  if (!hasFallbackEnvelope(signal)) return null;
  const preservation = readRecord(signal.raw_payload.evidence_preservation);
  const sourceCorpus = readString(signal.raw_payload.full_turn_content);
  if (sourceCorpus === null || !hasValidPreservation(preservation)) return null;
  const input: GardenSourceTurnFallbackReceiptInput = {
    signal_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    surface_id: signal.surface_id,
    created_at: signal.created_at,
    source_observation: signal.source_observation,
    source_corpus: sourceCorpus,
    reason: preservation.reason,
    truncated: preservation.truncated,
    chars_clipped: preservation.chars_clipped
  };
  return Object.freeze({
    ...input,
    digest: preservation.source_receipt_sha256,
    preimage: buildGardenSourceTurnFallbackReceiptPreimage(input)
  });
}

export function verifyGardenSourceTurnFallbackReceipt(
  signal: Readonly<CandidateMemorySignal>,
  sha256: (preimage: string) => string
): Readonly<GardenSourceTurnFallbackReceipt> | null {
  const receipt = readGardenSourceTurnFallbackReceipt(signal);
  return receipt !== null && receipt.digest === sha256(receipt.preimage)
    ? receipt
    : null;
}

function hasFallbackEnvelope(signal: Readonly<CandidateMemorySignal>): boolean {
  return signal.source === "garden_compile" &&
    signal.signal_kind === "potential_evidence_anchor" &&
    signal.object_kind === "source_turn" &&
    signal.scope_hint === null &&
    signal.confidence === 1 &&
    signal.domain_tags.length === 1 &&
    signal.domain_tags[0] === "source-turn" &&
    allSignalRefsEmpty(signal) &&
    hasOnlyKeys(signal.raw_payload, ["evidence_preservation", "full_turn_content"]);
}

function allSignalRefsEmpty(signal: Readonly<CandidateMemorySignal>): boolean {
  return signal.evidence_refs.length === 0 &&
    signal.source_memory_refs.length === 0 &&
    signal.supersedes_refs.length === 0 &&
    signal.exception_to_refs.length === 0 &&
    signal.contradicts_refs.length === 0 &&
    signal.incompatible_with_refs.length === 0;
}

type Preservation = Readonly<{
  version: 1;
  reason: GardenSourceTurnFallbackReason;
  truncated: boolean;
  chars_clipped: number;
  source_receipt_sha256: string;
}>;

function hasValidPreservation(
  value: Readonly<Record<string, unknown>> | null
): value is Preservation {
  if (value === null || !hasOnlyKeys(value, [
    "chars_clipped",
    "reason",
    "source_receipt_sha256",
    "truncated",
    "version"
  ])) return false;
  const clipped = value.chars_clipped;
  return value.version === 1 &&
    (value.reason === "empty_extraction" ||
      value.reason === "no_evidence_created") &&
    typeof value.truncated === "boolean" &&
    typeof clipped === "number" &&
    Number.isSafeInteger(clipped) &&
    clipped >= 0 &&
    value.truncated === (clipped > 0) &&
    typeof value.source_receipt_sha256 === "string" &&
    isSha256(value.source_receipt_sha256);
}

function normalizeObservation(
  observation: CandidateMemorySignal["source_observation"]
) {
  return observation === null ? null : {
    observed_at: observation.observed_at,
    authority: observation.authority,
    source_event_id: observation.source_event_id
  };
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === required[index]);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
