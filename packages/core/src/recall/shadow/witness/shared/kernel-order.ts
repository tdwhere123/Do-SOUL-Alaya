import { ShadowContractError } from "../../envelope.js";
import {
  completenessOwner,
  isKnownZeroEpistemic,
  isUnknownEpistemic
} from "./epistemic.js";
import { identitiesEqual } from "./identity.js";
import { samePayloadCell, type PayloadOps } from "./kernel-ops.js";
import type {
  TypedWitness,
  WitnessDomainKind,
  WitnessInformationOrder
} from "./types.js";

export function compareWitness<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>
): WitnessInformationOrder {
  assertSameDomain(left, right);
  if (!identitiesEqual(left.identity, right.identity) || !samePayloadCell(ops, left, right)) {
    return "incomparable";
  }
  const leftLeq = informationLeq(ops, left, right);
  const rightLeq = informationLeq(ops, right, left);
  if (leftLeq && rightLeq) return "equal";
  if (leftLeq) return "wider";
  if (rightLeq) return "narrower";
  return "incomparable";
}

export function informationLeq<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  wide: TypedWitness<K, P>,
  narrow: TypedWitness<K, P>
): boolean {
  if (!identitiesEqual(wide.identity, narrow.identity)) return false;
  if (!samePayloadCell(ops, wide, narrow)) return false;
  if (wide.epistemic.kind === "conflict") return narrow.epistemic.kind === "conflict";
  if (narrow.epistemic.kind === "conflict") return true;
  return epistemicPayloadLeq(ops, wide, narrow);
}

export function informationEqual<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>
): boolean {
  return informationLeq(ops, left, right) && informationLeq(ops, right, left);
}

export function epistemicClash<K extends WitnessDomainKind, P>(
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>
): boolean {
  const kinds = new Set([left.epistemic.kind, right.epistemic.kind]);
  if (kinds.has("not_applicable") && (kinds.has("exact") || kinds.has("negative"))) {
    return true;
  }
  if (kinds.has("negative") && kinds.has("exact")) return true;
  if (left.epistemic.kind === "negative" && right.epistemic.kind === "negative") {
    return left.epistemic.named_negative !== right.epistemic.named_negative;
  }
  return provenAbsenceClash(left, right);
}

export function assertSameDomain<K extends WitnessDomainKind, P>(
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>
): void {
  if (left.domain !== right.domain) {
    throw new ShadowContractError("witness domain mismatch");
  }
}

function epistemicPayloadLeq<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  wide: TypedWitness<K, P>,
  narrow: TypedWitness<K, P>
): boolean {
  const kind = wide.epistemic.kind;
  if (kind === "unavailable" || kind === "not_observed") {
    return unknownLeq(wide, narrow);
  }
  if (kind === "not_applicable") return narrow.epistemic.kind === "not_applicable";
  if (kind === "negative") return negativeLeq(wide, narrow);
  if (kind === "exact") return exactLeq(ops, wide, narrow);
  return false;
}

function unknownLeq<K extends WitnessDomainKind, P>(
  wide: TypedWitness<K, P>,
  narrow: TypedWitness<K, P>
): boolean {
  if (isUnknownEpistemic(narrow.epistemic)) {
    return wide.epistemic.kind === narrow.epistemic.kind;
  }
  return true;
}

function negativeLeq<K extends WitnessDomainKind, P>(
  wide: TypedWitness<K, P>,
  narrow: TypedWitness<K, P>
): boolean {
  return wide.epistemic.kind === "negative" &&
    narrow.epistemic.kind === "negative" &&
    wide.epistemic.named_negative === narrow.epistemic.named_negative;
}

function exactLeq<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  wide: TypedWitness<K, P>,
  narrow: TypedWitness<K, P>
): boolean {
  if (narrow.epistemic.kind !== "exact") return false;
  if (isKnownZeroEpistemic(wide.epistemic) && !isKnownZeroEpistemic(narrow.epistemic)) {
    return false;
  }
  if (isKnownZeroEpistemic(wide.epistemic) && isKnownZeroEpistemic(narrow.epistemic) &&
    completenessOwner(wide.epistemic) !== completenessOwner(narrow.epistemic)) {
    return false;
  }
  return payloadInformationLeq(ops, wide.payload, narrow.payload);
}

function payloadInformationLeq<P>(
  ops: PayloadOps<P>,
  wide: P | null,
  narrow: P | null
): boolean {
  if (wide === null && narrow === null) return true;
  if (wide === null || narrow === null) return false;
  return ops.leq(wide, narrow);
}

function provenAbsenceClash<K extends WitnessDomainKind, P>(
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>
): boolean {
  if (left.epistemic.kind !== "exact" || right.epistemic.kind !== "exact") return false;
  const leftAbsent = left.payload === null;
  const rightAbsent = right.payload === null;
  return leftAbsent !== rightAbsent;
}
