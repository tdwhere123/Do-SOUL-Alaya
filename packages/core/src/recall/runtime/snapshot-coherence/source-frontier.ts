import { stableStringify } from "../../../shared/stable-stringify.js";
import {
  rejectSnapshotCoherence,
  type SnapshotLagBoundV1,
  type SnapshotValidTimeDomainV1,
  type SourceFrontierDeclarationV1
} from "./types.js";

export function createSourceFrontierDeclaration(
  input: SourceFrontierDeclarationV1
): SourceFrontierDeclarationV1 {
  return Object.freeze({
    source_owner: requireToken(input.source_owner, "duplicate_source_owner"),
    principal: requireToken(input.principal, "mismatched_principal_scope"),
    authorized_scope: requireToken(input.authorized_scope, "mismatched_principal_scope"),
    source_frontier: requireToken(input.source_frontier, "incompatible_base_frontier"),
    valid_time_domain: freezeValidTime(input.valid_time_domain),
    generation: requireToken(input.generation, "mixed_operator_generation"),
    operator_or_model_version: requireToken(
      input.operator_or_model_version,
      "mixed_operator_generation"
    ),
    lag_bound: freezeLagBound(input.lag_bound)
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
      from: requireToken(domain.from, "mixed_operator_generation")
    });
  }
  if (domain.kind !== "bounded") {
    rejectSnapshotCoherence("mixed_operator_generation", "valid time domain");
  }
  const from = requireToken(domain.from, "mixed_operator_generation");
  const to = requireToken(domain.to, "mixed_operator_generation");
  if (!(from < to)) rejectSnapshotCoherence("mixed_operator_generation", "valid time bounds");
  return Object.freeze({ kind: "bounded" as const, from, to });
}

function freezeLagBound(bound: SnapshotLagBoundV1): SnapshotLagBoundV1 {
  if (bound.kind === "exact") return Object.freeze({ kind: "exact" as const });
  if (bound.kind === "unavailable") return Object.freeze({ kind: "unavailable" as const });
  if (bound.kind !== "bounded") {
    rejectSnapshotCoherence("mixed_operator_generation", "lag bound");
  }
  return Object.freeze({
    kind: "bounded" as const,
    remaining_effect: requireToken(bound.remaining_effect, "mixed_operator_generation")
  });
}

function requireToken(
  value: string,
  code: Parameters<typeof rejectSnapshotCoherence>[0]
): string {
  if (value.length === 0 || value.trim() !== value) rejectSnapshotCoherence(code);
  return value;
}
