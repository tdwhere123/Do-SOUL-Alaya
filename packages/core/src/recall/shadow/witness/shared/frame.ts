import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { freezeShadow } from "../../envelope.js";
import { stableStringify } from "../../../../shared/stable-stringify.js";
import { assertCompletenessApplies } from "./completeness.js";
import { freezeEpistemic, isKnownZeroEpistemic } from "./epistemic.js";
import { freezeIdentity } from "./identity.js";
import { freezeProvenance } from "./provenance.js";
import type {
  TypedWitness,
  WitnessDomainKind,
  WitnessEpistemic,
  WitnessIdentityPins,
  WitnessProvenanceEntry
} from "./types.js";

export function freezePayload<P>(payload: P | null): P | null {
  if (payload === null || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) {
    return Object.freeze(payload.map((item) => freezePayloadValue(item))) as P;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    copy[key] = freezePayloadValue(value);
  }
  return freezeShadow(copy) as P;
}

export function assembleWitness<K extends WitnessDomainKind, P>(
  domain: K,
  identity: WitnessIdentityPins,
  provenance: readonly WitnessProvenanceEntry[],
  epistemic: WitnessEpistemic,
  payload: P | null
): TypedWitness<K, P> {
  const frozenIdentity = freezeIdentity(identity);
  const frozenEpistemic = freezeEpistemic(epistemic);
  if (isKnownZeroEpistemic(frozenEpistemic)) {
    assertCompletenessApplies(frozenEpistemic.completeness, domain, frozenIdentity);
  }
  return freezeShadow({
    domain,
    identity: frozenIdentity,
    provenance: freezeProvenance(provenance),
    epistemic: frozenEpistemic,
    payload: freezePayload(payload)
  });
}

export function freezeWitness<K extends WitnessDomainKind, P>(
  witness: TypedWitness<K, P>
): TypedWitness<K, P> {
  return assembleWitness(
    witness.domain,
    witness.identity,
    witness.provenance,
    witness.epistemic,
    witness.payload
  );
}

export function serializeWitness<K extends WitnessDomainKind, P>(
  witness: TypedWitness<K, P>
): string {
  return stableStringify(witnessJson(witness));
}

export function digestWitness<K extends WitnessDomainKind, P>(
  witness: TypedWitness<K, P>
): RecallFieldDigest {
  return digestRecallFieldIdentity(witnessJson(witness));
}

export function consumerView<K extends WitnessDomainKind, P>(
  witness: TypedWitness<K, P>
): Readonly<Record<string, unknown>> {
  const epistemic = witness.epistemic;
  const view: Record<string, unknown> = {
    domain: witness.domain,
    epistemic: epistemic.kind,
    payload: witness.payload
  };
  if (isKnownZeroEpistemic(epistemic)) {
    view.known_zero = true;
    view.completeness_owner = epistemic.completeness.owner;
  }
  if (epistemic.kind === "negative") view.named_negative = epistemic.named_negative;
  return freezeShadow(view);
}

function witnessJson<K extends WitnessDomainKind, P>(
  witness: TypedWitness<K, P>
): Readonly<Record<string, unknown>> {
  return {
    domain: witness.domain,
    identity: witness.identity,
    provenance: witness.provenance,
    epistemic: witness.epistemic,
    payload: witness.payload
  };
}

function freezePayloadValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezePayloadValue(item)));
  }
  const copy: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = freezePayloadValue(nested);
  }
  return freezeShadow(copy);
}
