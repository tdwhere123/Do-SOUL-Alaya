import type { AssociativeFactFrame } from "../../associative-fact-frame.js";
import { groundEvidenceFactFrameObligation } from "../evidence-osf-semantic-completeness.js";
import { normalizeMemoryObjectKeySurface } from "../../../memory/memory-object-key.js";
import type { OpenSemanticFactorGraphProposal } from "../../../relations/open-semantic-factor-graph.js";
import { factFramePreservesSourceObligations } from "./declarative-normalizer.js";

/** Compiles only the independently qualified source obligation, never model identities. */
export function compileSourceFrameSemanticGraph(
  source: string,
  frame: AssociativeFactFrame
): OpenSemanticFactorGraphProposal | null {
  if (!factFramePreservesSourceObligations(source, frame)) return null;
  const obligation = groundEvidenceFactFrameObligation(source, frame);
  if (obligation === null) return null;
  const slots = [obligation.predicate, ...obligation.arguments];
  return {
    schema_version: 2,
    source_kind: "evidence",
    factors: slots.map((slot, index) => ({
      factor_id: index === 0 ? "predicate" : `argument_${index - 1}`,
      surface: slot.surface,
      source_occurrence: sourceOccurrence(source, slot.surface, slot.source_span[0]),
      semantic_identity: normalizeMemoryObjectKeySurface(slot.surface)
    })),
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "fact_frame",
      predicate_factor_id: "predicate",
      arguments: obligation.arguments.map((slot, index) => ({
        position: index,
        binding_identity: slot.role,
        reference_kind: "factor",
        reference_id: `argument_${index}`
      }))
    }]
  };
}

function sourceOccurrence(source: string, surface: string, expectedStart: number): number {
  let occurrence = 0;
  let cursor = 0;
  while (cursor <= expectedStart) {
    const start = source.indexOf(surface, cursor);
    if (start === expectedStart) return occurrence;
    if (start < 0 || start > expectedStart) break;
    occurrence += 1;
    cursor = start + surface.length;
  }
  throw new Error("qualified source slot has no exact occurrence");
}
