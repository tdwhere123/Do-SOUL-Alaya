import {
  CandidateMemorySignalSchema,
  GardenProviderKind,
  type CandidateMemorySignal,
  type ConversationMessage
} from "@do-soul/alaya-protocol";
import {
  OFFICIAL_API_SIGNAL_LIMIT,
  clampConfidence,
  inspectRawOfficialApiSignalElements,
  parseOfficialApiSignalEntry,
  type OfficialApiSignalDraft
} from "../official-api-signal-parser.js";
import {
  normalizeSourceObservedAt,
  selectObservedTemporalProjection
} from "../temporal/observed-projection.js";
import { buildOfficialCandidateSignal } from "./signal-payload.js";
import {
  groundOfficialApiDraft,
  type OfficialApiSourceGroundingAudit
} from "./source-grounding.js";
import { buildOfficialApiSourceCorpus } from "../grounding/source-locator.js";
import { assessOfficialApiSourceTrust } from "./source-trust.js";

// invariant: cache-compatibility decisions pin formation behavior independently of raw JSON.
export const OFFICIAL_API_FORMATION_AUDIT_SEMANTICS_VERSION = "official-api-formation-audit-v2";

export type OfficialApiSignalAuditDisposition = "admitted" | "deferred" | "rejected" | "invalid";

export type OfficialApiSignalAuditStage =
  | "parse"
  | "created_at"
  | "source_observation"
  | "grounding"
  | "formation";

export interface OfficialApiSignalFormationAuditInput {
  readonly raw_json: string;
  readonly turn_content: string;
  readonly turn_messages?: readonly ConversationMessage[];
  readonly allow_legacy_single_user_source?: boolean;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly created_at: string;
  readonly source_observed_at?: string;
  readonly require_source_observed_at?: boolean;
  readonly signal_id_for: (index: number) => string;
}

export interface OfficialApiSignalFormationAuditEntry {
  readonly index: number;
  readonly disposition: OfficialApiSignalAuditDisposition;
  readonly stage: OfficialApiSignalAuditStage;
  readonly reason: string;
  readonly signal?: CandidateMemorySignal;
}

export interface OfficialApiSignalFormationAuditResult {
  readonly mode: "strict" | "salvage";
  readonly envelope: {
    readonly disposition: "admitted" | "invalid";
    readonly reason: "strict_envelope_parsed" | "salvage_elements_recovered" |
      "signals_array_missing" | "signals_envelope_unparseable";
  };
  readonly entries: readonly OfficialApiSignalFormationAuditEntry[];
}

interface AuditTiming {
  readonly createdAt: string | undefined;
  readonly sourceObservedAt: string | undefined;
  readonly sourceObservationInvalid: boolean;
}

type StrictEnvelopeInspection =
  | { readonly status: "parsed"; readonly candidates: readonly unknown[] }
  | { readonly status: "missing" }
  | null;

export function auditOfficialApiSignalFormation(
  input: OfficialApiSignalFormationAuditInput
): OfficialApiSignalFormationAuditResult {
  const timing = resolveAuditTiming(input);
  const strict = inspectStrictEnvelope(input.raw_json);
  if (strict?.status === "parsed") return auditStrictEntries(strict.candidates, input, timing);
  if (strict?.status === "missing") return invalidEnvelope("strict", "signals_array_missing");
  return auditSalvagedEntries(input, timing);
}

function inspectStrictEnvelope(content: string): StrictEnvelopeInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return isSignalsEnvelope(parsed)
    ? { status: "parsed", candidates: parsed.signals }
    : { status: "missing" };
}

function auditStrictEntries(
  candidates: readonly unknown[],
  input: OfficialApiSignalFormationAuditInput,
  timing: AuditTiming
): OfficialApiSignalFormationAuditResult {
  return {
    mode: "strict",
    envelope: { disposition: "admitted", reason: "strict_envelope_parsed" },
    entries: Object.freeze(candidates.map((candidate, index) =>
      index >= OFFICIAL_API_SIGNAL_LIMIT
        ? deferredEntry(index, "parse", "signal_limit_exceeded")
        : auditCandidate(candidate, index, input, timing)
    ))
  };
}

function auditSalvagedEntries(
  input: OfficialApiSignalFormationAuditInput,
  timing: AuditTiming
): OfficialApiSignalFormationAuditResult {
  const inspection = inspectRawOfficialApiSignalElements(input.raw_json);
  const elements = inspection.elements;
  if (elements.length === 0 && !inspection.truncated_final_element) {
    return invalidEnvelope("salvage", "signals_envelope_unparseable");
  }

  let admittedToParser = 0;
  const entries = elements.map((element, index) => {
    const candidate = parseSalvageElement(element);
    if (candidate === null) return invalidEntry(index, "parse", "salvage_element_unparseable");
    const draft = parseOfficialApiSignalEntry(candidate);
    if (draft === null) return invalidEntry(index, "parse", "entry_schema_invalid");
    if (admittedToParser >= OFFICIAL_API_SIGNAL_LIMIT) {
      return deferredEntry(index, "parse", "signal_limit_exceeded");
    }
    admittedToParser += 1;
    return auditDraft(draft, index, input, timing);
  });
  if (inspection.truncated_final_element) {
    entries.push(invalidEntry(entries.length, "parse", "salvage_element_truncated"));
  }
  return {
    mode: "salvage",
    envelope: elements.length === 0
      ? { disposition: "invalid", reason: "signals_envelope_unparseable" }
      : { disposition: "admitted", reason: "salvage_elements_recovered" },
    entries: Object.freeze(entries)
  };
}

function auditCandidate(
  candidate: unknown,
  index: number,
  input: OfficialApiSignalFormationAuditInput,
  timing: AuditTiming
): OfficialApiSignalFormationAuditEntry {
  const draft = parseOfficialApiSignalEntry(candidate);
  return draft === null
    ? invalidEntry(index, "parse", "entry_schema_invalid")
    : auditDraft(draft, index, input, timing);
}

function auditDraft(
  draft: OfficialApiSignalDraft,
  index: number,
  input: OfficialApiSignalFormationAuditInput,
  timing: AuditTiming
): OfficialApiSignalFormationAuditEntry {
  const timingEntry = timingFailure(index, input, timing);
  if (timingEntry !== null) return timingEntry;

  const normalizedTurnContent = input.turn_content.trim();
  const trustRejection = assessOfficialApiSourceTrust({
    hasSourceLocator: draft.source_locator !== undefined,
    turnContent: normalizedTurnContent,
    ...(input.turn_messages === undefined ? {} : { turnMessages: input.turn_messages }),
    ...(input.allow_legacy_single_user_source === undefined ? {} : {
      allowLegacySingleUserSource: input.allow_legacy_single_user_source
    })
  });
  if (trustRejection !== null) {
    return {
      index,
      disposition: "rejected",
      stage: "grounding",
      reason: trustRejection
    };
  }
  const groundingSourceText = draft.source_locator === undefined
    ? normalizedTurnContent
    : buildOfficialApiSourceCorpus(normalizedTurnContent, input.turn_messages!);
  const grounding = groundOfficialApiDraft(draft, groundingSourceText);
  if (grounding.status === "rejected") {
    return {
      index,
      disposition: "rejected",
      stage: "grounding",
      reason: grounding.audit.reasons[0] ?? "source_assertion_rejected"
    };
  }
  return formGroundedDraft(
    grounding.draft,
    grounding.audit,
    index,
    input,
    timing.sourceObservedAt!,
    timing.createdAt!
  );
}

function timingFailure(
  index: number,
  input: OfficialApiSignalFormationAuditInput,
  timing: AuditTiming
): OfficialApiSignalFormationAuditEntry | null {
  if (timing.createdAt === undefined) return invalidEntry(index, "created_at", "created_at_invalid");
  if (timing.sourceObservationInvalid) {
    return invalidEntry(index, "source_observation", "source_observed_at_invalid");
  }
  if (input.require_source_observed_at !== false && timing.sourceObservedAt === undefined) {
    return deferredEntry(index, "source_observation", "source_observed_at_missing");
  }
  return null;
}

function formGroundedDraft(
  draft: OfficialApiSignalDraft,
  sourceGrounding: OfficialApiSourceGroundingAudit,
  index: number,
  input: OfficialApiSignalFormationAuditInput,
  sourceObservedAt: string | undefined,
  createdAt: string
): OfficialApiSignalFormationAuditEntry {
  try {
    const signal = CandidateMemorySignalSchema.parse(buildOfficialCandidateSignal({
      draft,
      workspaceId: input.workspace_id,
      runId: input.run_id,
      surfaceId: input.surface_id,
      normalizedTurnContent: input.turn_content.trim(),
      groundingSourceText: draft.source_locator === undefined
        ? input.turn_content.trim()
        : buildOfficialApiSourceCorpus(input.turn_content.trim(), input.turn_messages!),
      confidence: clampConfidence(draft.confidence),
      temporalProjection: selectObservedTemporalProjection(
        draft.matched_text,
        draft.temporal_projection,
        sourceObservedAt
      ),
      distilledFact: draft.distilled_fact,
      providerKind: GardenProviderKind.OFFICIAL_API,
      signalId: input.signal_id_for(index),
      createdAt,
      sourceGrounding
    }));
    return { index, disposition: "admitted", stage: "formation", reason: "formed", signal };
  } catch {
    return invalidEntry(index, "formation", "candidate_signal_invalid");
  }
}

function resolveAuditTiming(input: OfficialApiSignalFormationAuditInput): AuditTiming {
  const sourceObservedAt = normalizeSourceObservedAt(input.source_observed_at);
  return {
    createdAt: normalizeSourceObservedAt(input.created_at),
    sourceObservedAt,
    sourceObservationInvalid: input.source_observed_at !== undefined && sourceObservedAt === undefined
  };
}

function invalidEnvelope(
  mode: OfficialApiSignalFormationAuditResult["mode"],
  reason: Extract<OfficialApiSignalFormationAuditResult["envelope"]["reason"],
    "signals_array_missing" | "signals_envelope_unparseable">
): OfficialApiSignalFormationAuditResult {
  return {
    mode,
    envelope: { disposition: "invalid", reason },
    entries: Object.freeze([])
  };
}

function invalidEntry(
  index: number,
  stage: OfficialApiSignalAuditStage,
  reason: string
): OfficialApiSignalFormationAuditEntry {
  return { index, disposition: "invalid", stage, reason };
}

function deferredEntry(
  index: number,
  stage: OfficialApiSignalAuditStage,
  reason: string
): OfficialApiSignalFormationAuditEntry {
  return { index, disposition: "deferred", stage, reason };
}

function parseSalvageElement(element: string): unknown | null {
  try {
    return JSON.parse(element);
  } catch {
    return null;
  }
}

function isSignalsEnvelope(value: unknown): value is { readonly signals: readonly unknown[] } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Array.isArray((value as { readonly signals?: unknown }).signals);
}
