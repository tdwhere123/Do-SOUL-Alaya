import type { CandidateMemorySignal } from "../signals/candidate-memory-signal.js";

export const GARDEN_SOURCE_TURN_FALLBACK_ARTIFACT_PREFIX =
  "alaya:garden-turn-evidence:";
export const GARDEN_SOURCE_TURN_FALLBACK_SOURCE_HASH_PREFIX =
  "sha256:garden-source-turn-fallback-v1:";
export const GARDEN_SOURCE_TURN_FALLBACK_V2_SOURCE_HASH_PREFIX =
  "sha256:garden-source-turn-fallback-v2:";

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

export interface GardenSourceTurnFallbackRoleSpan {
  readonly role: "user" | "assistant";
  readonly start: number;
  readonly end: number;
}

export interface GardenSourceTurnFallbackV2ReceiptInput
  extends GardenSourceTurnFallbackReceiptInput {
  readonly source_role_spans: readonly Readonly<GardenSourceTurnFallbackRoleSpan>[];
}

export interface GardenSourceTurnFallbackV2Receipt
  extends GardenSourceTurnFallbackV2ReceiptInput {
  readonly digest: string;
  readonly preimage: string;
}

export type GardenSourceTurnFallbackVerifiedReceipt =
  | GardenSourceTurnFallbackReceipt
  | GardenSourceTurnFallbackV2Receipt;

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

export function buildGardenSourceTurnFallbackV2ReceiptPreimage(
  input: Readonly<GardenSourceTurnFallbackV2ReceiptInput>
): string {
  return JSON.stringify({
    kind: "garden-source-turn-fallback-v2",
    signal_id: input.signal_id,
    workspace_id: input.workspace_id,
    run_id: input.run_id,
    surface_id: input.surface_id,
    created_at: input.created_at,
    source_observation: normalizeObservation(input.source_observation),
    reason: input.reason,
    truncated: input.truncated,
    chars_clipped: input.chars_clipped,
    source_role_spans: input.source_role_spans.map(normalizeRoleSpan),
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

export function formatGardenSourceTurnFallbackV2SourceHash(
  digest: string
): string {
  return `${GARDEN_SOURCE_TURN_FALLBACK_V2_SOURCE_HASH_PREFIX}${digest}`;
}

export function readGardenSourceTurnFallbackV2SourceHashDigest(
  value: string | null
): string | null {
  if (value?.startsWith(GARDEN_SOURCE_TURN_FALLBACK_V2_SOURCE_HASH_PREFIX) !== true) {
    return null;
  }
  const digest = value.slice(GARDEN_SOURCE_TURN_FALLBACK_V2_SOURCE_HASH_PREFIX.length);
  return isSha256(digest) ? digest : null;
}

export function hasGardenSourceTurnFallbackReceiptFormat(input: {
  readonly artifact_ref: string | null;
  readonly source_hash: string | null;
}): boolean {
  return readGardenSourceTurnFallbackArtifactSignalId(input.artifact_ref) !== null &&
    readGardenSourceTurnFallbackSourceHashDigest(input.source_hash) !== null;
}

export function hasGardenSourceTurnFallbackV2ReceiptFormat(input: {
  readonly artifact_ref: string | null;
  readonly source_hash: string | null;
}): boolean {
  return readGardenSourceTurnFallbackArtifactSignalId(input.artifact_ref) !== null &&
    readGardenSourceTurnFallbackV2SourceHashDigest(input.source_hash) !== null;
}

export function hasGardenSourceTurnFallbackAnyReceiptFormat(input: {
  readonly artifact_ref: string | null;
  readonly source_hash: string | null;
}): boolean {
  return hasGardenSourceTurnFallbackReceiptFormat(input) ||
    hasGardenSourceTurnFallbackV2ReceiptFormat(input);
}

export function readGardenSourceTurnFallbackReceipt(
  signal: Readonly<CandidateMemorySignal>
): Readonly<GardenSourceTurnFallbackVerifiedReceipt> | null {
  const preservation = readRecord(signal.raw_payload.evidence_preservation);
  return preservation?.version === 2
    ? readGardenSourceTurnFallbackV2Receipt(signal)
    : readGardenSourceTurnFallbackV1Receipt(signal);
}

function readGardenSourceTurnFallbackV2Receipt(
  signal: Readonly<CandidateMemorySignal>
): Readonly<GardenSourceTurnFallbackV2Receipt> | null {
  if (!hasV2FallbackEnvelope(signal)) return null;
  const preservation = readRecord(signal.raw_payload.evidence_preservation);
  const sourceCorpus = readString(signal.raw_payload.full_turn_content);
  if (sourceCorpus === null || !hasValidV2Preservation(preservation)) return null;
  const sourceRoleSpans = readV2RoleSpans(
    signal.raw_payload.source_role_spans,
    sourceCorpus
  );
  if (sourceRoleSpans === null) return null;
  const input = buildV2ReceiptInput(
    signal,
    sourceCorpus,
    sourceRoleSpans,
    preservation
  );
  return Object.freeze({
    ...input,
    digest: preservation.source_receipt_sha256,
    preimage: buildGardenSourceTurnFallbackV2ReceiptPreimage(input)
  });
}

function readGardenSourceTurnFallbackV1Receipt(
  signal: Readonly<CandidateMemorySignal>
): Readonly<GardenSourceTurnFallbackReceipt> | null {
  // Lifecycle is intentionally a consumer gate: Soul admits only pre-
  // materialization states, while snapshot authority verifies the final row.
  if (!hasV1FallbackEnvelope(signal)) return null;
  const preservation = readRecord(signal.raw_payload.evidence_preservation);
  const sourceCorpus = readString(signal.raw_payload.full_turn_content);
  if (sourceCorpus === null || !hasValidV1Preservation(preservation)) return null;
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
): Readonly<GardenSourceTurnFallbackVerifiedReceipt> | null {
  const receipt = readGardenSourceTurnFallbackReceipt(signal);
  return receipt !== null && receipt.digest === sha256(receipt.preimage)
    ? receipt
    : null;
}

export function isGardenSourceTurnFallbackV2Receipt(
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt> | null
): receipt is Readonly<GardenSourceTurnFallbackV2Receipt> {
  return receipt !== null && "source_role_spans" in receipt;
}

export {
  projectGardenSourceTurnFallbackV2AssistantObservations,
  projectGardenSourceTurnFallbackV2UserContent
} from "./garden-source-turn-fallback/role-span-projection.js";

function hasV1FallbackEnvelope(signal: Readonly<CandidateMemorySignal>): boolean {
  return hasCommonFallbackEnvelope(signal) &&
    hasOnlyKeys(signal.raw_payload, ["evidence_preservation", "full_turn_content"]);
}

function hasV2FallbackEnvelope(signal: Readonly<CandidateMemorySignal>): boolean {
  return hasCommonFallbackEnvelope(signal) &&
    signal.source_observation?.authority === "trusted_host_event" &&
    hasOnlyKeys(signal.raw_payload, [
      "evidence_preservation",
      "full_turn_content",
      "source_role_spans"
    ]);
}

function hasCommonFallbackEnvelope(signal: Readonly<CandidateMemorySignal>): boolean {
  return signal.source === "garden_compile" &&
    signal.signal_kind === "potential_evidence_anchor" &&
    signal.object_kind === "source_turn" &&
    signal.scope_hint === null &&
    signal.confidence === 1 &&
    signal.domain_tags.length === 1 &&
    signal.domain_tags[0] === "source-turn" &&
    allSignalRefsEmpty(signal);
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

type V2Preservation = Readonly<{
  version: 2;
  reason: GardenSourceTurnFallbackReason;
  truncated: false;
  chars_clipped: 0;
  source_receipt_sha256: string;
}>;

function hasValidV1Preservation(
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

function hasValidV2Preservation(
  value: Readonly<Record<string, unknown>> | null
): value is V2Preservation {
  return value !== null &&
    hasOnlyKeys(value, [
      "chars_clipped",
      "reason",
      "source_receipt_sha256",
      "truncated",
      "version"
    ]) &&
    value.version === 2 &&
    isFallbackReason(value.reason) &&
    value.truncated === false &&
    value.chars_clipped === 0 &&
    typeof value.source_receipt_sha256 === "string" &&
    isSha256(value.source_receipt_sha256);
}

function readV2RoleSpans(
  value: unknown,
  sourceCorpus: string
): readonly Readonly<GardenSourceTurnFallbackRoleSpan>[] | null {
  if (!hasWellFormedUtf16(sourceCorpus) ||
      !Array.isArray(value) ||
      value.length === 0) return null;
  const spans: Readonly<GardenSourceTurnFallbackRoleSpan>[] = [];
  let priorEnd = 0;
  for (const candidate of value) {
    const span = readV2RoleSpan(candidate, sourceCorpus, priorEnd);
    if (span === null) return null;
    spans.push(span);
    priorEnd = span.end;
  }
  return hasCanonicalRoleEnvelope(spans, sourceCorpus)
    ? Object.freeze(spans)
    : null;
}

function readV2RoleSpan(
  value: unknown,
  sourceCorpus: string,
  priorEnd: number
): Readonly<GardenSourceTurnFallbackRoleSpan> | null {
  const span = readRecord(value);
  if (span === null || !hasOnlyKeys(span, ["end", "role", "start"])) return null;
  const { role, start, end } = span;
  if ((role !== "user" && role !== "assistant") ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      start < priorEnd ||
      start < 0 ||
      end <= start ||
      end > sourceCorpus.length ||
      splitsCodePoint(sourceCorpus, start) ||
      splitsCodePoint(sourceCorpus, end) ||
      sourceCorpus.slice(start, end).trim().length === 0) return null;
  return Object.freeze({ role, start, end });
}

function hasCanonicalRoleEnvelope(
  spans: readonly Readonly<GardenSourceTurnFallbackRoleSpan>[],
  sourceCorpus: string
): boolean {
  let priorEnd = 0;
  for (const span of spans) {
    const separator = priorEnd === 0 ? "" : "\n";
    const prefix = `${separator}${roleLabel(span.role)}: `;
    if (sourceCorpus.slice(priorEnd, span.start) !== prefix) return false;
    priorEnd = span.end;
  }
  return priorEnd === sourceCorpus.length;
}

function roleLabel(role: GardenSourceTurnFallbackRoleSpan["role"]): string {
  return role === "user" ? "User" : "Assistant";
}

function splitsCodePoint(value: string, offset: number): boolean {
  return offset > 0 &&
    offset < value.length &&
    (value.codePointAt(offset - 1) ?? 0) > 0xFFFF;
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xD800 && current <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return false;
      index += 1;
    } else if (current >= 0xDC00 && current <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function buildV2ReceiptInput(
  signal: Readonly<CandidateMemorySignal>,
  sourceCorpus: string,
  sourceRoleSpans: readonly Readonly<GardenSourceTurnFallbackRoleSpan>[],
  preservation: V2Preservation
): GardenSourceTurnFallbackV2ReceiptInput {
  return {
    signal_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    surface_id: signal.surface_id,
    created_at: signal.created_at,
    source_observation: signal.source_observation,
    source_corpus: sourceCorpus,
    source_role_spans: sourceRoleSpans,
    reason: preservation.reason,
    truncated: preservation.truncated,
    chars_clipped: preservation.chars_clipped
  };
}

function isFallbackReason(value: unknown): value is GardenSourceTurnFallbackReason {
  return value === "empty_extraction" || value === "no_evidence_created";
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

function normalizeRoleSpan(
  span: Readonly<GardenSourceTurnFallbackRoleSpan>
) {
  return {
    role: span.role,
    start: span.start,
    end: span.end
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
