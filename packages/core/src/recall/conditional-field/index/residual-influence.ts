import {
  MILLIGRADE_TOP,
  type ClosureCertificate,
  type CoverageRegion,
  type ResidualCoverageRole,
  type ResidualInfluence,
  type ResidualSemanticEffect
} from "@do-soul/alaya-protocol";

export type ResidualClassificationContext = Readonly<{
  readonly sufficient_alternate_paths?: boolean;
  readonly certificate?: ClosureCertificate;
}>;

export function coverageRoleOf(region: CoverageRegion): ResidualCoverageRole {
  if (region.coverage_role !== undefined) return region.coverage_role;
  return region.kind === "discovery" ? "optional_accelerator" : "required";
}

export function semanticEffectsOf(region: CoverageRegion): readonly ResidualSemanticEffect[] {
  if (region.semantic_effects !== undefined && region.semantic_effects.length > 0) {
    return region.semantic_effects;
  }
  if (region.kind === "guard") return ["validity", "membership"];
  if (region.kind === "cursor") return ["membership", "order"];
  if (region.kind === "hypothesis" || region.kind === "program_branch") {
    return ["membership", "interpretation"];
  }
  if (region.kind === "output_obligation") return ["membership"];
  if (region.kind === "certificate") return [];
  return ["membership", "grade_bound"];
}

export function classifyResidualInfluence(
  region: CoverageRegion,
  context: ResidualClassificationContext = {},
  effect?: ResidualSemanticEffect
): ResidualInfluence {
  if (effect !== undefined && !semanticEffectsOf(region).includes(effect)) return "irrelevant";
  const optionalCovered = coverageRoleOf(region) === "optional_accelerator"
    && membershipCoveredByCertificate(context, effect);
  if (optionalCovered && region.status !== "open" && region.status !== "interrupted"
    && region.status !== "invalidated") {
    if (effect === "membership" || effect === "interpretation") return "irrelevant";
    if (effect === undefined) {
      const effects = semanticEffectsOf(region);
      if (effects.includes("grade_bound") || effects.includes("order")) return "influential";
      return "irrelevant";
    }
  }
  if (region.status === "unknown" || region.status === "unavailable") {
    return coverageRoleOf(region) === "required" ? "unresolved" : "influential";
  }
  if (region.status === "open" || region.status === "interrupted"
    || region.status === "cancelled" || region.status === "invalidated") {
    return "influential";
  }
  // not_applicable is a view exclusion, not observer exhaustion.
  if (region.status === "not_applicable") return "irrelevant";
  // Exhaustion means this observer has no remaining observations; it does not
  // certify other residuals (seed done is not source-domain coverage).
  return "irrelevant";
}

export function residualAffectsGrade(region: CoverageRegion): boolean {
  const effects = semanticEffectsOf(region);
  return effects.includes("grade_bound") || effects.includes("membership");
}

export function residualsInvalidateBounds(residuals: readonly CoverageRegion[]): boolean {
  return residuals.some((region) => region.status === "invalidated" && residualAffectsGrade(region));
}

export function sufficientAlternatePaths(
  _residuals: readonly CoverageRegion[],
  certificate?: ClosureCertificate
): boolean {
  // Exhausted required seed/source_domain is not an alternate-path certificate.
  return membershipCoveredByCertificate({ certificate }, "membership");
}

export function residualGradeUpper(
  residuals: readonly CoverageRegion[],
  context: ResidualClassificationContext = {}
): number | undefined {
  if (residualsInvalidateBounds(residuals)) return MILLIGRADE_TOP;
  let upper: number | undefined;
  for (const region of residuals) {
    const grade = classifyResidualInfluence(region, context, "grade_bound");
    const membership = classifyResidualInfluence(region, context, "membership");
    if (grade === "irrelevant" && membership === "irrelevant") continue;
    if (!residualAffectsGrade(region)) continue;
    const bound = region.conservative_bound_milligrades ?? region.high_milligrades ?? MILLIGRADE_TOP;
    upper = upper === undefined ? bound : Math.max(upper, bound);
  }
  return upper;
}

export function membershipCoveredByCertificate(
  context: ResidualClassificationContext,
  effect?: ResidualSemanticEffect
): boolean {
  const certificate = context.certificate;
  if (certificate === undefined) return false;
  if (effect === "grade_bound" || effect === "order" || effect === "claim"
    || effect === "refutation" || effect === "explanation" || effect === "payload"
    || effect === "validity") {
    return certificate.closed_effects.includes(effect);
  }
  return certificate.closed_effects.includes("membership");
}
