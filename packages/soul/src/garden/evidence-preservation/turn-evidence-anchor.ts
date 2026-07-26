import { createHash } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  ConversationMessageSchema,
  SignalKind,
  SignalSource,
  SignalState,
  buildGardenSourceTurnFallbackReceiptPreimage,
  buildGardenSourceTurnFallbackV2ReceiptPreimage,
  formatGardenSourceTurnFallbackArtifactRef,
  formatGardenSourceTurnFallbackSourceHash,
  formatGardenSourceTurnFallbackV2SourceHash,
  isGardenSourceTurnFallbackV2Receipt,
  projectGardenSourceTurnFallbackV2UserContent,
  verifyGardenSourceTurnFallbackReceipt,
  type CandidateMemorySignal,
  type ConversationMessage,
  type GardenSourceTurnFallbackRoleSpan,
  type GardenSourceTurnFallbackReason,
  type GardenSourceTurnFallbackReceiptInput,
  type GardenSourceTurnFallbackV2ReceiptInput
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
  turnMessages?: readonly ConversationMessage[];
}>;

/** Build a host-originated evidence-only signal without asserting semantic truth. */
export function buildGardenTurnEvidenceFallback(
  input: EvidenceFallbackInput
): CandidateMemorySignal | null {
  const v2RawPayload = buildCompleteV2RawPayload(input);
  const normalized = input.turnContent.trim();
  if (v2RawPayload === null && normalized.length === 0) return null;
  const rawPayload = v2RawPayload ??
    buildBoundedRawPayload(normalized, input);
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

export interface VerifiedGardenTurnEvidenceProjection {
  readonly sourceHash: string;
  readonly userContent: string | null;
}

export function resolveVerifiedGardenTurnEvidenceProjection(
  signal: CandidateMemorySignal,
  sourceCorpus: string
): Readonly<VerifiedGardenTurnEvidenceProjection> | null {
  if (!hasMaterializableFallbackState(signal.signal_state)) return null;
  const receipt = verifyGardenSourceTurnFallbackReceipt(signal, digest);
  if (receipt === null || sourceCorpus !== receipt.source_corpus) return null;
  return Object.freeze({
    sourceHash: isGardenSourceTurnFallbackV2Receipt(receipt)
      ? formatGardenSourceTurnFallbackV2SourceHash(receipt.digest)
      : formatGardenSourceTurnFallbackSourceHash(receipt.digest),
    userContent: isGardenSourceTurnFallbackV2Receipt(receipt)
      ? projectGardenSourceTurnFallbackV2UserContent(receipt)
      : null
  });
}

function buildCompleteV2RawPayload(
  input: EvidenceFallbackInput
): CandidateMemorySignal["raw_payload"] | null {
  const document = buildTrustedSourceDocument(input);
  if (document === null || !hasWellFormedUtf16(document.sourceCorpus)) return null;
  const preservation = {
    version: 2,
    reason: input.reason,
    truncated: false,
    chars_clipped: 0
  } as const;
  const receiptInput: GardenSourceTurnFallbackV2ReceiptInput = {
    ...buildReceiptInput(input, document.sourceCorpus, preservation),
    source_role_spans: document.sourceRoleSpans
  };
  const rawPayload = {
    full_turn_content: document.sourceCorpus,
    source_role_spans: document.sourceRoleSpans,
    evidence_preservation: {
      ...preservation,
      source_receipt_sha256: digest(
        buildGardenSourceTurnFallbackV2ReceiptPreimage(receiptInput)
      )
    }
  };
  return JSON.stringify(rawPayload).length <= RAW_PAYLOAD_MAX_SERIALIZED_CHARS
    ? rawPayload
    : null;
}

function buildTrustedSourceDocument(
  input: EvidenceFallbackInput
): SourceTurnDocument | null {
  if (input.sourceObservation?.authority !== "trusted_host_event" ||
      input.turnMessages === undefined ||
      input.turnMessages.length === 0) return null;
  const messages: ConversationMessage[] = [];
  for (const candidate of input.turnMessages) {
    const parsed = ConversationMessageSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.content.trim().length === 0) return null;
    messages.push(parsed.data);
  }
  if (!messages.some((message) => message.role === "user")) return null;
  return formatSourceTurnMessages(messages);
}

function formatSourceTurnMessages(
  messages: readonly ConversationMessage[]
): SourceTurnDocument {
  const fragments: string[] = [];
  const sourceRoleSpans: GardenSourceTurnFallbackRoleSpan[] = [];
  let offset = 0;
  for (const [index, message] of messages.entries()) {
    const content = message.content.trim();
    const prefix = `${index === 0 ? "" : "\n"}${roleLabel(message.role)}: `;
    fragments.push(prefix, content);
    const start = offset + prefix.length;
    const end = start + content.length;
    sourceRoleSpans.push(Object.freeze({ role: message.role, start, end }));
    offset = end;
  }
  return Object.freeze({
    sourceCorpus: fragments.join(""),
    sourceRoleSpans: Object.freeze(sourceRoleSpans)
  });
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
  preservation: ReceiptPreservation
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

type ReceiptPreservation = Readonly<{
  reason: GardenSourceTurnFallbackReason;
  truncated: boolean;
  chars_clipped: number;
}>;

interface SourceTurnDocument {
  readonly sourceCorpus: string;
  readonly sourceRoleSpans: readonly Readonly<GardenSourceTurnFallbackRoleSpan>[];
}

function roleLabel(role: ConversationMessage["role"]): "User" | "Assistant" {
  return role === "user" ? "User" : "Assistant";
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
