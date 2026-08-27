import type { AssociativeFactSlot } from "@do-soul/alaya-protocol";
import type {
  CandidateCoverageAtom,
  CandidateCoverageReceipt
} from "./coverage-atoms.js";

export const CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID =
  "content_owned_assertion_fact_key_v1";

export const CONTENT_OWNED_FACT_KEY_PROJECTION_ID = 1_000_000_001;

export function isContentOwnedAssertionFactAtom(
  atom: Readonly<CandidateCoverageAtom>
): boolean {
  if (atom.kind !== "fact_projection" || atom.evidence_object_id !== null) return false;
  if (atom.document_identity === null) return false;
  if (atom.independence_key !== atom.document_identity) return false;
  const projection = atom.projection;
  if (projection === null || projection.projection_kind !== "fact_key") return false;
  if (projection.projection_id !== CONTENT_OWNED_FACT_KEY_PROJECTION_ID) return false;
  const prefix = `${CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID}:`;
  if (!atom.independence_key.startsWith(prefix)) return false;
  const objectId = atom.independence_key.slice(prefix.length);
  if (objectId.length === 0 || objectId.trim() !== objectId) return false;
  return atom.atom_id === `fact:${objectId}:${String(CONTENT_OWNED_FACT_KEY_PROJECTION_ID)}`;
}

export function attachContentOwnedFactProjection(
  coverage: CandidateCoverageReceipt,
  input: { readonly objectId: string; readonly content: string }
): CandidateCoverageReceipt {
  const text = input.content.trim().normalize("NFC");
  if (text.length === 0) return coverage;
  const atomId = `fact:${input.objectId}:${String(CONTENT_OWNED_FACT_KEY_PROJECTION_ID)}`;
  if (coverage.atoms.some((atom) => atom.atom_id === atomId)) return coverage;
  const correlationKey = `${CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID}:${input.objectId}`;
  const slots = Object.freeze([
    Object.freeze({ role: "value" as const, text }) satisfies AssociativeFactSlot
  ]);
  const atom: CandidateCoverageAtom = Object.freeze({
    atom_id: atomId,
    kind: "fact_projection",
    strength: 1,
    independence_key: correlationKey,
    evidence_object_id: null,
    document_identity: correlationKey,
    projection: Object.freeze({
      projection_id: CONTENT_OWNED_FACT_KEY_PROJECTION_ID,
      projection_kind: "fact_key" as const,
      matched_fact_key_forms: Object.freeze([{ kind: "complete" as const }]),
      fact_slots: slots
    }),
    demand_roles: Object.freeze(["value"] as const),
    observation_channels: Object.freeze([])
  });
  return Object.freeze({
    ...coverage,
    atoms: Object.freeze([...coverage.atoms, atom])
  });
}
