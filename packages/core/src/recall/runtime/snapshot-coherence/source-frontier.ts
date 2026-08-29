import { stableStringify } from "../../../shared/stable-stringify.js";
import {
  rejectSnapshotCoherence,
  type SnapshotLagBoundV1,
  type SnapshotRemainingEffectV1,
  type SnapshotValidTimeDomainV1,
  type SourceFrontierDeclarationV1
} from "./types.js";
import { compareSnapshotInstants } from "./digest.js";
import { requireSnapshotInstant, requireSnapshotToken } from "./tokens.js";

export function createSourceFrontierDeclaration(
  input: SourceFrontierDeclarationV1
): SourceFrontierDeclarationV1 {
  return Object.freeze({
    source_owner: requireSnapshotToken(input.source_owner, "duplicate_source_owner"),
    principal: requireSnapshotToken(input.principal, "mismatched_principal_scope"),
    authorized_scope: requireSnapshotToken(input.authorized_scope, "mismatched_principal_scope"),
    source_frontier: requireSnapshotToken(input.source_frontier, "incompatible_base_frontier"),
    valid_time_domain: freezeValidTime(input.valid_time_domain),
    generation: requireSnapshotToken(input.generation, "mixed_operator_generation"),
    operator_or_model_version: requireSnapshotToken(
      input.operator_or_model_version,
      "mixed_operator_generation"
    ),
    lag_bound: freezeLagBound(input.source_owner, input.lag_bound)
  });
}

export function verifySourceFrontierDeclaration(
  declaration: SourceFrontierDeclarationV1
): void {
  const rebuilt = createSourceFrontierDeclaration(declaration);
  if (stableStringify(rebuilt) !== stableStringify(declaration)) {
    rejectSnapshotCoherence("mixed_operator_generation", "source frontier mismatch");
  }
}

function freezeValidTime(domain: SnapshotValidTimeDomainV1): SnapshotValidTimeDomainV1 {
  if (domain.kind === "timeless") return Object.freeze({ kind: "timeless" as const });
  if (domain.kind === "open") {
    return Object.freeze({
      kind: "open" as const,
      from: requireSnapshotInstant(domain.from)
    });
  }
  if (domain.kind !== "bounded") {
    rejectSnapshotCoherence("mixed_operator_generation", "valid time domain");
  }
  const from = requireSnapshotInstant(domain.from);
  const to = requireSnapshotInstant(domain.to);
  if (compareSnapshotInstants(from, to) >= 0) {
    rejectSnapshotCoherence("mixed_operator_generation", "valid time bounds");
  }
  return Object.freeze({ kind: "bounded" as const, from, to });
}

function freezeLagBound(
  sourceOwner: string,
  bound: SnapshotLagBoundV1
): SnapshotLagBoundV1 {
  if (bound.kind === "exact") return Object.freeze({ kind: "exact" as const });
  if (bound.kind === "unavailable") return Object.freeze({ kind: "unavailable" as const });
  if (bound.kind === "not_applicable") {
    return Object.freeze({ kind: "not_applicable" as const });
  }
  if (bound.kind !== "bounded") {
    rejectSnapshotCoherence("mixed_operator_generation", "lag bound");
  }
  return Object.freeze({
    kind: "bounded" as const,
    remaining_effect: freezeRemainingEffect(sourceOwner, bound.remaining_effect)
  });
}

function freezeRemainingEffect(
  sourceOwner: string,
  effect: SnapshotRemainingEffectV1 | string
): SnapshotRemainingEffectV1 {
  if (typeof effect !== "object" || effect === null) {
    rejectSnapshotCoherence("mixed_operator_generation", "remaining effect");
  }
  const source_owner = requireSnapshotToken(effect.source_owner, "mixed_operator_generation");
  const effect_id = requireSnapshotToken(effect.effect_id, "mixed_operator_generation");
  if (source_owner !== sourceOwner) {
    rejectSnapshotCoherence("mixed_operator_generation", "remaining effect owner");
  }
  return Object.freeze({ source_owner, effect_id });
}
