import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { readSchemaGroundedContent } from "../schema-grounding.js";
import {
  requiresGardenSourceGrounding,
  resolveGardenSignalGrounding
} from "../grounding/signal-source-grounding.js";
import { SOURCE_ASSERTION_MAX_CHARS } from "../grounding/source-assertion.js";

export function buildTopicKey(signal: CandidateMemorySignal): string {
  const primaryTag = signal.domain_tags[0] ?? "signal";
  const basis = `${primaryTag}_${signal.object_kind}`.toLowerCase();
  const topicKey = basis.replace(/[^a-z0-9_.-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");

  return topicKey.length === 0 ? `signal_${signal.signal_id}` : topicKey;
}

export function buildSignalSummary(signal: CandidateMemorySignal): string {
  const schemaGroundedContent = readSchemaGroundedContent(signal);
  if (schemaGroundedContent !== null) {
    return schemaGroundedContent;
  }

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

// invariant: MemoryEntry.content / Claim.proposition_digest /
// Synthesis.summary store a distilled fact, not raw turn. Raw turn lives
// in EvidenceCapsule.gist / .excerpt. Caller (LLM / user / bench harness)
// may supply raw_payload.distilled_fact directly; otherwise a rule-based
// fallback takes the first two sentences capped at DISTILLED_FACT_MAX_CHARS.
// Single source of truth for the distilled-fact length budget: the
// official-API garden provider clamps raw_payload.distilled_fact to this
// same constant. see also: garden/compute-provider.ts.
// invariant: kept <= AUDIT_DROPPED_CONTENT_MAX_CHARS (500) in
// packages/core/src/governance/reconciliation-service.ts so a dropped fact stays
// fully reconstructable from the reconciliation audit row.
export const DISTILLED_FACT_MAX_CHARS = SOURCE_ASSERTION_MAX_CHARS;
const DISTILLED_FACT_MAX_SENTENCES = 2;

export function buildDistilledFact(signal: CandidateMemorySignal): string {
  if (signal.source === "garden_compile" && requiresGardenSourceGrounding(signal)) {
    return buildGroundedGardenFact(signal);
  }
  const providedDistilled = signal.raw_payload.distilled_fact;
  if (typeof providedDistilled === "string") {
    const trimmed = providedDistilled.trim();
    if (trimmed.length > 0) {
      // A caller-supplied distilled_fact is already a resolved
      // one-assertion fact; use it verbatim when within cap. The "..."
      // truncation belongs only to ruleDistillFromRaw (raw -> distilled).
      // An over-cap supplied fact is not the normal path once the
      // provider clamps to DISTILLED_FACT_MAX_CHARS — clamp defensively.
      return trimmed.length <= DISTILLED_FACT_MAX_CHARS
        ? trimmed
        : trimmed.slice(0, DISTILLED_FACT_MAX_CHARS);
    }
  }
  return ruleDistillFromRaw(buildSignalSummary(signal));
}

function buildGroundedGardenFact(signal: CandidateMemorySignal): string {
  const grounding = resolveGardenSignalGrounding(signal);
  if (grounding.status !== "grounded" || grounding.assertion.length > DISTILLED_FACT_MAX_CHARS) {
    return "";
  }
  return grounding.assertion;
}

// see also: buildDistilledFact — fallback path when caller does not supply
// raw_payload.distilled_fact. Sentence boundary scan covers Latin (.!?;)
// and CJK (。！？；) terminators; falls back to char-count slice when no
// terminator is found in the first 2x window.
function ruleDistillFromRaw(raw: string): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "";
  }
  const sentenceRegex = /[^.!?;。！？；]+[.!?;。！？；]+/gu;
  const sentences = normalized.match(sentenceRegex) ?? [];
  // invariant: always take at most DISTILLED_FACT_MAX_SENTENCES sentences
  // even when the raw fits inside the char cap. Distilled fact is the
  // *first claim* of a turn, not the entire turn.
  if (sentences.length >= DISTILLED_FACT_MAX_SENTENCES) {
    const head = sentences.slice(0, DISTILLED_FACT_MAX_SENTENCES).join("").trim();
    if (head.length > 0 && head.length <= DISTILLED_FACT_MAX_CHARS) {
      return head;
    }
    return `${head.slice(0, DISTILLED_FACT_MAX_CHARS - 3)}...`;
  }
  if (normalized.length <= DISTILLED_FACT_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, DISTILLED_FACT_MAX_CHARS - 3)}...`;
}

export function appendSummarySuffix(summary: string, suffix?: string): string {
  if (suffix === undefined) {
    return summary;
  }

  return `${summary} ${suffix}`;
}
