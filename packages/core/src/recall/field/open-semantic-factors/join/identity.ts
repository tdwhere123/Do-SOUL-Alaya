import { extractTemporalTerms } from "@do-soul/alaya-graph-algorithms";
import { normalizeMemoryObjectKeySurface, type OpenSemanticFactor } from
  "@do-soul/alaya-protocol";
import {
  isRuleBasedGenericSpeaker,
  isRuleBasedLocationResultValue
} from "../../../../shared/query-fact-frame-extraction-rules.js";
import type { OpenSemanticFactorArgumentMapping } from "../argument-alignment.js";

export const OPEN_SEMANTIC_SOURCE_BOUND_JOIN_OPERATOR_ID =
  "source_bound_join_identity_v1" as const;

export type OpenSemanticJoinPropositionMatch = Readonly<{
  readonly query_proposition_id: string;
  readonly evidence_proposition_id: string;
  readonly predicate_alignment: Readonly<{
    readonly query_factor_id: string;
    readonly evidence_factor_id: string;
    readonly operator_id: typeof OPEN_SEMANTIC_SOURCE_BOUND_JOIN_OPERATOR_ID;
  }>;
  readonly argument_mappings: readonly Readonly<OpenSemanticFactorArgumentMapping>[];
}>;

export function isLocationResultSurface(surface: string): boolean {
  return isRuleBasedLocationResultValue(surface);
}

export function isTemporalFactor(factor: Readonly<OpenSemanticFactor>): boolean {
  return extractTemporalTerms(factor.surface).length > 0 ||
    extractTemporalTerms(factor.semantic_identity).length > 0;
}

function isGenericSpeakerIdentity(identity: string): boolean {
  return isRuleBasedGenericSpeaker(identity);
}

function sourceBoundJoinKey(surface: string, identity: string): string {
  return `${normalizeMemoryObjectKeySurface(surface)}\0${normalizeMemoryObjectKeySurface(identity)}`;
}

export function joinKeysFromMappings(
  mappings: readonly Readonly<OpenSemanticFactorArgumentMapping>[]
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const mapping of mappings) {
    if (mapping.query_reference_kind === "variable") continue;
    if (isGenericSpeakerIdentity(mapping.evidence_surface) ||
        isGenericSpeakerIdentity(mapping.evidence_semantic_identity)) {
      continue;
    }
    keys.add(sourceBoundJoinKey(mapping.evidence_surface, mapping.evidence_semantic_identity));
  }
  return keys;
}

export function factorJoinKey(factor: Readonly<OpenSemanticFactor>): string {
  return sourceBoundJoinKey(factor.surface, factor.semantic_identity);
}
