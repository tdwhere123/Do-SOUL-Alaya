import { DYNAMICS_CONSTANTS, type PathRelation } from "@do-soul/alaya-protocol";

/**
 * The minimum support_events_count at which a path is considered well-supported
 * (the "high support but quiet" cold-store signal, proxy ③). Sourced from
 * DYNAMICS_CONSTANTS — the normal->stable promotion threshold is the same
 * "this path has earned trust through repeated use" boundary, so a path past
 * it must never be deleted by consolidation, only cold-stored (left dormant).
 * see also: packages/protocol/src/soul/dynamics-constants.ts path_plasticity.
 */
const WELL_SUPPORTED_EVENTS_THRESHOLD =
  DYNAMICS_CONSTANTS.path_plasticity.normal_to_stable_support_count;

/**
 * The minimum distinct evidence sources at which a path's evidence is rich
 * enough that consolidation must keep it (proxy ②). A durable association that
 * cites two or more independent sources is not noise; it may stay dormant but
 * is never deleted. This honours "durable memory needs source + evidence".
 */
const RICH_EVIDENCE_BASIS_THRESHOLD = 2;

/**
 * The disposition the importance gate assigns to a single PathRelation. The
 * consolidation planner (S3a) and the recall/manifestation importance pass
 * (S4-core) both consume this so the cheap-proxy protection rules cannot drift
 * between the two call sites.
 *
 * - protected:   never merge, never delete, never demote. Override-pinned paths.
 * - report_only: strictly-governed paths — surface for human/governance review,
 *                never auto-act (no auto merge/delete).
 * - keep:        evidence-rich or well-supported-but-quiet. May stay dormant /
 *                be cold-stored, but consolidation must not delete it. It MAY be
 *                chosen as a merge survivor (it is durable), but never a loser.
 * - mergeable:   ordinary dormant path with no protection — eligible to be a
 *                merge loser (deleted) or retired.
 */
export type ImportanceDisposition = "protected" | "report_only" | "keep" | "mergeable";

export interface ImportanceClassification {
  readonly disposition: ImportanceDisposition;
  /**
   * The proxy signal that decided a non-mergeable disposition, for audit /
   * observability. Empty for "mergeable".
   */
  readonly reason: string;
}

// invariant: a pin is the override-rule signal OR the highest stability band.
// Either one means a human (or a governance decision) deliberately anchored
// this path, so consolidation must never touch it.
function isOverridePinned(path: PathRelation): boolean {
  return (
    path.lifecycle.override_rule !== undefined ||
    path.plasticity_state.stability_class === "pinned"
  );
}

/**
 * Pure, side-effect-free classification of a single PathRelation against the
 * cheap-proxy importance signals (no LLM, no model). Evaluated in protection
 * order: the strongest protection wins, so an override-pinned strictly-governed
 * path classifies as "protected" rather than "report_only".
 *
 * Mapping of design proxies (spine-activation-design.md:21) to real fields:
 *   ① override pin   -> lifecycle.override_rule / plasticity_state.stability_class === "pinned"  => protected
 *   ② evidence>=2    -> legitimacy.evidence_basis.length >= RICH_EVIDENCE_BASIS_THRESHOLD          => keep
 *   ③ supported+quiet-> plasticity_state.support_events_count >= WELL_SUPPORTED_EVENTS_THRESHOLD   => keep
 *   ④ strictly_gov   -> legitimacy.governance_class === "strictly_governed"                        => report_only
 *
 * see also: packages/core/src/consolidation-planner.ts (merge candidate filter).
 */
export function classifyPathImportance(path: PathRelation): ImportanceClassification {
  if (isOverridePinned(path)) {
    return Object.freeze({ disposition: "protected", reason: "override_pinned" });
  }

  if (path.legitimacy.governance_class === "strictly_governed") {
    return Object.freeze({ disposition: "report_only", reason: "strictly_governed" });
  }

  if (path.legitimacy.evidence_basis.length >= RICH_EVIDENCE_BASIS_THRESHOLD) {
    return Object.freeze({ disposition: "keep", reason: "evidence_basis_rich" });
  }

  if (path.plasticity_state.support_events_count >= WELL_SUPPORTED_EVENTS_THRESHOLD) {
    return Object.freeze({ disposition: "keep", reason: "well_supported_quiet" });
  }

  return Object.freeze({ disposition: "mergeable", reason: "" });
}

/**
 * True when consolidation may delete this path (as a merge loser or a
 * retirement). Only "mergeable" paths are deletable; "protected", "report_only",
 * and "keep" are never deleted by an automated cycle.
 */
export function isConsolidationDeletable(path: PathRelation): boolean {
  return classifyPathImportance(path).disposition === "mergeable";
}

/**
 * True when this path may serve as a merge survivor (the kept, evidence-richest
 * member of a cluster). A survivor must be durable, so "protected" and
 * "report_only" paths are excluded — a strictly-governed or pinned path must
 * not silently absorb other paths' provenance without governance review — while
 * "keep" and "mergeable" paths may survive.
 */
export function isConsolidationSurvivorEligible(path: PathRelation): boolean {
  const disposition = classifyPathImportance(path).disposition;
  return disposition === "keep" || disposition === "mergeable";
}
