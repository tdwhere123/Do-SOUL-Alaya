import type { RecallAdmissionPlane } from "../runtime/recall-service-types.js";
import { compareMemoryEntries } from "../runtime/recall-service-helpers.js";
import { sessionRouteEnabled } from "./session-route.js";
import type { CoarseCandidateDraft } from "./coarse-candidates.js";

export function rankCoarseCandidateDrafts(
  drafts: readonly Readonly<CoarseCandidateDraft>[]
): readonly Readonly<CoarseCandidateDraft>[] {
  return [...drafts].sort((left, right) => {
    const priorityDelta = draftPriority(right) - draftPriority(left);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    const structuralDelta = right.structuralScore - left.structuralScore;
    if (structuralDelta !== 0) {
      return structuralDelta;
    }
    return compareMemoryEntries(left.entry, right.entry);
  });
}

function draftPriority(draft: Readonly<CoarseCandidateDraft>): number {
  if (draft.admissionPlanes.includes("protected_winner")) {
    return 5;
  }
  if (draft.admissionPlanes.includes("object_probe")) {
    return 4;
  }
  // invariant: session route certainty ranks just above lexical evidence.
  if (sessionRouteEnabled() && draft.admissionPlanes.includes("session_surface_cohort")) {
    return 3.5;
  }
  if (draft.admissionPlanes.some((plane) =>
    plane === "evidence_anchor" ||
    plane === "domain_tag_cluster" ||
    plane === "session_surface_cohort" ||
    plane === "source_proximity" ||
    plane === "graph_expansion" ||
    plane === "path_expansion"
  )) {
    return 3;
  }
  if (
    draft.admissionPlanes.includes("lexical") ||
    draft.admissionPlanes.includes("lexical_anchor") ||
    draft.admissionPlanes.includes("entity_seed")
  ) {
    return 3;
  }
  // invariant: semantic_supplement has no lexical or structural anchor.
  // see also: packages/core/src/recall/supplements.ts:collectEmbeddingCoarseInjection.
  if (draft.admissionPlanes.includes("semantic_supplement")) {
    return 2;
  }
  return 1;
}

export function uniquePlanes(values: readonly RecallAdmissionPlane[]): readonly RecallAdmissionPlane[] {
  return [...new Set(values)];
}
