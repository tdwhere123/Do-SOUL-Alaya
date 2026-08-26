import {
  classifyQueryObligationStructuralRole,
  type AssociativeFactSlotRole
} from "@do-soul/alaya-protocol";
import { WH_WORDS } from "../../shared/fact-frame-grammar/clause-boundaries.js";
import { CJK_INTERROGATIVE_CUES } from
  "../../shared/fact-frame-grammar/interrogative-cues.js";
import { isCjkSegmentationCandidate, segmentCjkRun } from
  "../../shared/cjk-segmentation.js";
import {
  isRuleBasedGenericSpeaker,
  SUBJECT_PRONOUNS
} from "../../shared/fact-frame-grammar/result-slots.js";
import { regularRelationInflectionEquivalent } from "./facility/relation-inflection-alignment.js";
import { containsAlignedTokenSequence } from "./facility/token-sequence-alignment.js";

export const FACT_FRAME_SEMANTIC_FACTOR_OPERATOR_ID =
  "fact_frame_semantic_factor_projection_v1";

export type FactFrameSemanticFactor = Readonly<{
  readonly frame_index: number | null;
  readonly slot_index: number;
  readonly role: AssociativeFactSlotRole;
  readonly text: string;
  readonly normalized_text: string;
}>;

export type FactFrameSemanticDemandKind = "entity" | "relation" | "time";

export type FactFrameSemanticAlignment =
  | "exact_token_sequence_v1"
  | "porter_regular_plural_v1"
  | "porter_regular_relation_inflection_v1";

export function projectFactFrameSemanticFactors(
  slots: readonly Readonly<{ readonly role: AssociativeFactSlotRole; readonly text: string }>[],
  frameIndex: number | null = null
): readonly Readonly<FactFrameSemanticFactor>[] {
  return Object.freeze(slots.map((slot, slotIndex) => Object.freeze({
    frame_index: frameIndex,
    slot_index: slotIndex,
    role: slot.role,
    text: slot.text,
    normalized_text: normalizeSemanticText(slot.text)
  })));
}

export function semanticDemandKindForRole(
  role: AssociativeFactSlotRole
): FactFrameSemanticDemandKind | null {
  if (role === "relation") return "relation";
  if (role === "time") return "time";
  return role === "subject" || role === "value" || role === "qualifier"
    ? "entity"
    : null;
}

export function cleanFactFrameDemandFactor(
  factor: Readonly<FactFrameSemanticFactor>
): Readonly<FactFrameSemanticFactor> | null {
  if (semanticDemandKindForRole(factor.role) === null) return null;
  const surface = demandObligationSurface(factor);
  if (surface === null) return null;
  return surface === factor.normalized_text
    ? factor
    : Object.freeze({ ...factor, normalized_text: surface });
}

export function alignFactFrameSemanticFactor(params: Readonly<{
  readonly candidate: Readonly<FactFrameSemanticFactor>;
  readonly demand: Readonly<FactFrameSemanticFactor>;
  readonly demand_kind: FactFrameSemanticDemandKind;
  readonly allow_porter: boolean;
  readonly require_exact_role?: boolean;
}>): FactFrameSemanticAlignment | null {
  if (semanticDemandKindForRole(params.candidate.role) !== params.demand_kind ||
      (params.require_exact_role === true && params.candidate.role !== params.demand.role) ||
      params.candidate.normalized_text.length === 0 ||
      params.demand.normalized_text.length === 0) {
    return null;
  }
  const candidateTokens = canonicalTokens(params.candidate.normalized_text);
  const demandTokens = canonicalTokens(params.demand.normalized_text);
  if (containsAlignedTokenSequence(candidateTokens, demandTokens,
    (candidateToken, demandToken) => candidateToken === demandToken)) {
    return "exact_token_sequence_v1";
  }
  if (!params.allow_porter) return null;
  if (params.demand_kind === "relation" &&
      regularRelationInflectionEquivalent(
        params.candidate.normalized_text,
        params.demand.normalized_text
      )) {
    return "porter_regular_relation_inflection_v1";
  }
  if (params.demand_kind !== "entity") return null;
  return containsAlignedTokenSequence(candidateTokens, demandTokens,
    regularPluralEquivalent)
    ? "porter_regular_plural_v1"
    : null;
}

function regularPluralEquivalent(left: string, right: string): boolean {
  return left === right || regularSingular(left) === right || regularSingular(right) === left;
}

function regularSingular(token: string): string | null {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") &&
      !token.endsWith("ss") && !token.endsWith("us") && !token.endsWith("is")) {
    return token.slice(0, -1);
  }
  return null;
}

function demandObligationSurface(
  factor: Readonly<FactFrameSemanticFactor>
): string | null {
  if (classifyQueryObligationStructuralRole(factor.normalized_text) !== null) {
    return null;
  }
  const kept = canonicalTokens(factor.normalized_text)
    .filter((token) => !isDroppedObligationToken(token));
  if (kept.length === 0) return null;
  return semanticDemandKindForRole(factor.role) === "entity"
    ? kept.join(" ")
    : factor.normalized_text;
}

function isDroppedObligationToken(token: string): boolean {
  return WH_WORDS.has(token) ||
    SUBJECT_PRONOUNS.has(token) ||
    isRuleBasedGenericSpeaker(token) ||
    CJK_INTERROGATIVE_TOKEN_SET.has(token);
}

function normalizeSemanticText(value: string): string {
  return value.trim().replace(/[.]+$/u, "").replace(/\s+/gu, " ").toLocaleLowerCase();
}

function canonicalTokens(value: string): readonly string[] {
  const runs = value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const tokens: string[] = [];
  for (const run of runs) {
    if (!isCjkSegmentationCandidate(run)) {
      tokens.push(run);
      continue;
    }
    for (const piece of segmentCjkRun(run)) {
      const normalized = piece.trim().toLocaleLowerCase();
      if (normalized.length > 0) tokens.push(normalized);
    }
  }
  return Object.freeze(tokens);
}

const CJK_INTERROGATIVE_TOKEN_SET: ReadonlySet<string> = new Set(CJK_INTERROGATIVE_CUES);
