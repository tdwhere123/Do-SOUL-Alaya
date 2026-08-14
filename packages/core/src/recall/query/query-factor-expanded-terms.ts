import {
  normalizeMemoryObjectKeySurface,
  type OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "./recall-query-probes.js";

export function extendQueryProbesWithOpenSemanticFactors(
  probes: Readonly<RecallQueryProbes>,
  capture: Readonly<OpenSemanticFactorFormationCapture> | undefined
): Readonly<RecallQueryProbes> {
  if (capture === undefined || capture.status !== "formed" || capture.graph === null) {
    return probes;
  }
  const present = new Set(
    [...probes.lexical_terms, ...probes.expanded_terms].map(normalizeMemoryObjectKeySurface)
  );
  const extras: string[] = [];
  for (const factor of capture.graph.factors) {
    for (const raw of [factor.semantic_identity, factor.surface]) {
      const normalized = normalizeMemoryObjectKeySurface(raw);
      if (normalized.length === 0 || present.has(normalized)) continue;
      present.add(normalized);
      extras.push(normalized);
    }
  }
  if (extras.length === 0) return probes;
  // Prepend so the existing expanded-term FTS slice cannot drop factor extras behind morphology.
  return Object.freeze({
    ...probes,
    expanded_terms: Object.freeze([...extras, ...probes.expanded_terms])
  });
}
