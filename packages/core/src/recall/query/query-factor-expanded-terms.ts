import {
  normalizeMemoryObjectKeySurface,
  type OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import {
  admitLexicalExpandedSurface,
  type RecallQueryProbes
} from "./recall-query-probes.js";

export function queryFactorFtsExtraEligibility(
  capture: Readonly<OpenSemanticFactorFormationCapture> | undefined
): "formed" | "not_formed" {
  // FTS extras are seeded in prepareQuerySeed before composition exists.
  if (capture === undefined || capture.status !== "formed" || capture.graph === null) {
    return "not_formed";
  }
  return "formed";
}

export function extendQueryProbesWithOpenSemanticFactors(
  probes: Readonly<RecallQueryProbes>,
  capture: Readonly<OpenSemanticFactorFormationCapture> | undefined
): Readonly<RecallQueryProbes> {
  if (queryFactorFtsExtraEligibility(capture) === "not_formed") {
    return probes;
  }
  if (capture === undefined || capture.graph === null) return probes;
  const present = new Set(
    [...probes.lexical_terms, ...probes.expanded_terms].map(normalizeMemoryObjectKeySurface)
  );
  const extras: string[] = [];
  for (const factor of capture.graph.factors) {
    for (const raw of [factor.semantic_identity, factor.surface]) {
      const admitted = admitLexicalExpandedSurface(normalizeMemoryObjectKeySurface(raw));
      if (admitted === null || present.has(admitted)) continue;
      present.add(admitted);
      extras.push(admitted);
    }
  }
  if (extras.length === 0) return probes;
  // Prepend so the existing expanded-term FTS slice cannot drop factor extras behind morphology.
  return Object.freeze({
    ...probes,
    expanded_terms: Object.freeze([...extras, ...probes.expanded_terms])
  });
}
