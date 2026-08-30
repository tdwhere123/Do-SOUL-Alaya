import { ShadowContractError } from "../../../contract-primitives.js";
import { parseEpistemic } from "./epistemic.js";
import { assembleWitness } from "./frame.js";
import { parseIdentityPins } from "./identity.js";
import { parseProvenance } from "./provenance.js";
import type {
  TypedWitness,
  WitnessCreateInput,
  WitnessDomainKind,
  WitnessEpistemic
} from "./types.js";

export function createTypedWitness<K extends WitnessDomainKind, P>(
  domain: K,
  input: WitnessCreateInput<P>,
  requiredPins: readonly ("candidate_id" | "proposition_id")[],
  payloadFor: (epistemic: WitnessEpistemic, payload: P | null | undefined) => P | null
): TypedWitness<K, P> {
  const epistemic = parseEpistemic(input.epistemic);
  const payload = payloadFor(epistemic, input.payload);
  assertPayloadMatchesEpistemic(epistemic, payload);
  return assembleWitness(
    domain,
    parseIdentityPins(input.identity, requiredPins),
    parseProvenance(input.provenance),
    epistemic,
    payload
  );
}

export function rejectPayload(payload: unknown, label: string): null {
  if (payload !== undefined && payload !== null) {
    throw new ShadowContractError(`${label} cannot carry a payload`);
  }
  return null;
}

function assertPayloadMatchesEpistemic<P>(
  epistemic: WitnessEpistemic,
  payload: P | null
): void {
  if (epistemic.kind === "exact" || epistemic.kind === "conflict") return;
  if (payload !== null) {
    throw new ShadowContractError(`${epistemic.kind} cannot carry a payload`);
  }
}
