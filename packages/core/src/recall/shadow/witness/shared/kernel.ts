import { ShadowContractError } from "../../envelope.js";
import {
  completenessOwner,
  conflictEpistemic,
  exactEpistemic,
  isKnownZeroEpistemic,
  isUnknownEpistemic,
  knownZeroEpistemic
} from "./epistemic.js";
import { assembleWitness } from "./frame.js";
import { assertIdentityPreserved } from "./identity.js";
import { samePayloadCell, type PayloadOps } from "./kernel-ops.js";
import {
  assertSameDomain,
  epistemicClash,
  informationEqual,
  informationLeq
} from "./kernel-order.js";
import { extendProvenance, unionProvenance } from "./provenance.js";
import type {
  TypedWitness,
  WitnessDomainKind,
  WitnessEpistemic,
  WitnessProvenanceEntry
} from "./types.js";

export function refineWitness<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  from: TypedWitness<K, P>,
  to: TypedWitness<K, P>
): TypedWitness<K, P> {
  assertSameDomain(from, to);
  assertIdentityPreserved(from.identity, to.identity);
  assertSameCell(ops, from, to);
  const provenance = extendProvenance(from.provenance, to.provenance);
  if (shouldConflict(ops, from, to)) {
    return conflictWitness(ops, from, to, provenance);
  }
  if (informationEqual(ops, from, to) || informationLeq(ops, from, to)) {
    return assembleWitness(to.domain, to.identity, provenance, to.epistemic, to.payload);
  }
  if (informationLeq(ops, to, from)) {
    throw new ShadowContractError("widening is illegal refinement");
  }
  throw new ShadowContractError("incomparable witnesses are not a refinement");
}

export function meetWitness<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>
): TypedWitness<K, P> {
  assertSameDomain(left, right);
  assertIdentityPreserved(left.identity, right.identity);
  assertSameCell(ops, left, right);
  const provenance = unionProvenance(left.provenance, right.provenance);
  if (left.epistemic.kind === "conflict" || right.epistemic.kind === "conflict") {
    return conflictWitness(ops, left, right, provenance);
  }
  if (epistemicClash(left, right) || payloadRefineConflict(ops, left, right)) {
    return conflictWitness(ops, left, right, provenance);
  }
  if (left.epistemic.kind === "exact" && right.epistemic.kind === "exact") {
    return meetExact(ops, left, right, provenance);
  }
  return meetNonExact(ops, left, right, provenance);
}

export function joinWitness<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>
): TypedWitness<K, P> {
  assertSameDomain(left, right);
  assertIdentityPreserved(left.identity, right.identity);
  assertSameCell(ops, left, right);
  if (!joinableExact(left) || !joinableExact(right)) {
    throw new ShadowContractError("join would fabricate a value");
  }
  const payload = ops.join(left.payload as P, right.payload as P);
  return assembleWitness(
    left.domain,
    left.identity,
    unionProvenance(left.provenance, right.provenance),
    exactEpistemic(),
    payload
  );
}

function meetExact<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>,
  provenance: readonly WitnessProvenanceEntry[]
): TypedWitness<K, P> {
  if (left.payload === null && right.payload === null) {
    return assembleWitness(
      left.domain,
      left.identity,
      provenance,
      meetKnownZeroEpistemic(left.epistemic, right.epistemic),
      null
    );
  }
  if (left.payload === null || right.payload === null) {
    return conflictWitness(ops, left, right, provenance);
  }
  const met = ops.meet(left.payload, right.payload);
  if (met === "conflict") return conflictWitness(ops, left, right, provenance);
  return assembleWitness(
    left.domain,
    left.identity,
    provenance,
    meetExactEpistemic(ops, left, right, met),
    met
  );
}

function meetNonExact<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>,
  provenance: readonly WitnessProvenanceEntry[]
): TypedWitness<K, P> {
  if (informationLeq(ops, left, right)) {
    return assembleWitness(right.domain, right.identity, provenance, right.epistemic, right.payload);
  }
  if (informationLeq(ops, right, left)) {
    return assembleWitness(left.domain, left.identity, provenance, left.epistemic, left.payload);
  }
  if (left.epistemic.kind === right.epistemic.kind && isUnknownEpistemic(left.epistemic)) {
    return assembleWitness(left.domain, left.identity, provenance, left.epistemic, null);
  }
  throw new ShadowContractError("incomparable epistemic meet");
}

function shouldConflict<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  from: TypedWitness<K, P>,
  to: TypedWitness<K, P>
): boolean {
  return epistemicClash(from, to) || payloadRefineConflict(ops, from, to);
}

function payloadRefineConflict<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>
): boolean {
  if (left.payload === null || right.payload === null) return false;
  const refineConflict = ops.refineConflict ?? ops.contradictory;
  return refineConflict(left.payload, right.payload);
}

function meetExactEpistemic<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>,
  payload: P
): WitnessEpistemic {
  const mapped = ops.epistemicFor?.(payload);
  if (mapped !== undefined) return mapped;
  if (isKnownZeroEpistemic(left.epistemic) && isKnownZeroEpistemic(right.epistemic)) {
    return meetKnownZeroEpistemic(left.epistemic, right.epistemic);
  }
  return exactEpistemic();
}

function meetKnownZeroEpistemic(
  left: WitnessEpistemic,
  right: WitnessEpistemic
): WitnessEpistemic {
  const leftOwner = completenessOwner(left);
  const rightOwner = completenessOwner(right);
  if (leftOwner !== null && rightOwner !== null && leftOwner !== rightOwner) {
    throw new ShadowContractError("completeness owner mismatch");
  }
  const owner = leftOwner ?? rightOwner;
  return owner === null ? exactEpistemic() : knownZeroEpistemic(owner);
}

function conflictWitness<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>,
  provenance: readonly WitnessProvenanceEntry[]
): TypedWitness<K, P> {
  const payload = ops.conflictPayload?.(left.payload, right.payload) ?? null;
  return assembleWitness(left.domain, left.identity, provenance, conflictEpistemic(), payload);
}

function joinableExact<K extends WitnessDomainKind, P>(
  witness: TypedWitness<K, P>
): boolean {
  return witness.epistemic.kind === "exact" && witness.payload !== null;
}

function assertSameCell<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>
): void {
  if (!samePayloadCell(ops, left, right)) {
    throw new ShadowContractError("identity pin change is illegal refinement");
  }
}
