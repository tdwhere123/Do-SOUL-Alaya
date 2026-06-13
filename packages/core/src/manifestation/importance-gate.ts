import { DYNAMICS_CONSTANTS, type MemoryEntry, type PathRelation } from "@do-soul/alaya-protocol";

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
 * see also: packages/core/src/memory/consolidation-planner.ts (merge candidate filter).
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

/**
 * The disposition the importance gate assigns to a single memory_entry, the
 * memory-side analogue of {@link ImportanceDisposition}. Consumed by the
 * autonomous-forgetting sweep (R3d) to decide whether a dormant memory is
 * `judged_useless` (safe to autonomously tombstone) or KEEP (never
 * auto-removable). Mechanical / non-LLM.
 *
 * - protected:   override-pinned or hazard decay profile — never auto-removable.
 * - report_only: strictly-governed durable tier (canon/consolidated) — never
 *                auto-removable; a governance subject must not be silently dropped.
 * - keep:        evidence-rich or well-supported — durable, never auto-removable.
 * - judged_useless: failed ALL keep-criteria — the ONLY memory disposition the
 *                autonomous sweep may terminalize (and only after the gate).
 */
export type MemoryImportanceDisposition = "protected" | "report_only" | "keep" | "judged_useless";

export interface MemoryImportanceClassification {
  readonly disposition: MemoryImportanceDisposition;
  readonly reason: string;
}

// invariant: pinned/hazard decay profiles are the memory-side override anchor —
// a human (pinned) or a safety hazard deliberately marked this memory durable,
// so the autonomous sweep must never drop it. Mirrors isOverridePinned for paths.
function isMemoryOverrideProtected(memory: Readonly<MemoryEntry>): boolean {
  return memory.decay_profile === "pinned" || memory.decay_profile === "hazard";
}

// invariant: canon and consolidated are the strictly-governed durable retention
// tiers — accepted, promoted truth. report_only mirrors the path-side
// governance_class === "strictly_governed" branch: never auto-act.
function isMemoryStrictlyGoverned(memory: Readonly<MemoryEntry>): boolean {
  return memory.retention_state === "canon" || memory.retention_state === "consolidated";
}

/**
 * Pure, side-effect-free classification of a single memory_entry against the
 * cheap-proxy importance signals (no LLM, no model). Evaluated in protection
 * order: the strongest protection wins.
 *
 * Field mapping:
 *   ① pinned/hazard decay profile           => protected
 *   ② retention_state canon/consolidated     => report_only
 *   ③ evidence_refs.length >= 1              => keep (durable: ANY evidence)
 *   ④ reinforcement_count >= 1               => keep (reinforced at least once)
 * invariant (redteam-I2): only a truly source-less (evidence_refs.length === 0)
 * AND never-reinforced (reinforcement_count === 0) memory is `judged_useless` —
 * the only disposition the autonomous-forgetting sweep may use to tombstone the
 * row. The memory gate is intentionally STRICTER than the path-side gate's
 * rich-basis (>=2) / well-supported thresholds: a memory is durable truth, and
 * "durable memories require source AND evidence" makes a single evidence ref
 * sufficient to forbid autonomous deletion.
 *
 * see also: packages/core/src/memory/memory-service/service.ts:MemoryService.autonomousTombstone,
 * packages/soul/src/garden/janitor.ts executeTombstoneGc.
 */
export function classifyMemoryImportance(
  memory: Readonly<MemoryEntry>
): MemoryImportanceClassification {
  if (isMemoryOverrideProtected(memory)) {
    return Object.freeze({ disposition: "protected", reason: "decay_profile_pinned_or_hazard" });
  }

  if (isMemoryStrictlyGoverned(memory)) {
    return Object.freeze({ disposition: "report_only", reason: "strictly_governed" });
  }

  // invariant (redteam-I2): "durable memories require source AND evidence" — so
  // ANY valid evidence ref makes the memory durable, not just a rich (>=2) basis.
  // A single-evidence durable fact must NEVER be autonomously deleted. Only a
  // memory that is truly source-less (evidence_refs.length === 0) AND was never
  // reinforced (reinforcement_count === 0) fails all keep-criteria.
  if (memory.evidence_refs.length >= 1) {
    return Object.freeze({ disposition: "keep", reason: "evidence_basis" });
  }

  if ((memory.reinforcement_count ?? 0) >= 1) {
    return Object.freeze({ disposition: "keep", reason: "reinforced" });
  }

  return Object.freeze({ disposition: "judged_useless", reason: "no_evidence_and_never_reinforced" });
}

/**
 * True when the mechanical memory importance gate clears a memory for
 * autonomous terminal removal (it is `judged_useless`). Every protected /
 * report_only / keep memory returns false and is NEVER auto-removable.
 */
export function isMemoryJudgedUseless(memory: Readonly<MemoryEntry>): boolean {
  return classifyMemoryImportance(memory).disposition === "judged_useless";
}

/**
 * True when a memory carries an EXPLICIT-KEEP protection: an override anchor
 * (decay_profile pinned/hazard) or a strictly-governed durable tier
 * (retention_state canon/consolidated). This is the precise predicate the
 * autonomous-forgetting disposition sweep checks BEFORE the `compressed` arm:
 * compression may override ordinary value signals (evidence-richness,
 * reinforcement) but must NEVER override an explicit-keep, because a
 * compressed member is deletable once a live capsule preserves its content,
 * and an explicitly-protected memory must not be deletable at all.
 *
 * It maps onto the strongest two importance dispositions (`protected` and
 * `report_only`) rather than the value-signal `keep` disposition, so it does
 * NOT shield an ordinary evidence-rich/reinforced memory from compression.
 * `consolidated` is treated as protected here (via isMemoryStrictlyGoverned):
 * a consolidated memory is itself higher-order durable truth and must not be
 * compress-deleted.
 *
 * see also: apps/core-daemon/src/forget-disposition-ports.ts computeForgetDisposition.
 */
export function isMemoryExplicitlyProtected(memory: Readonly<MemoryEntry>): boolean {
  return isMemoryOverrideProtected(memory) || isMemoryStrictlyGoverned(memory);
}
