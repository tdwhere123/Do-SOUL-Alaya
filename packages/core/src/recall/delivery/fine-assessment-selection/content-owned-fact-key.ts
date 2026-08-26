import type { AssociativeFactSlot } from "@do-soul/alaya-protocol";
import type {
  CandidateCoverageAtom,
  CandidateCoverageReceipt
} from "./coverage-atoms.js";

const CONTENT_OWNED_FACT_KEY_PROJECTION_ID = 1_000_000_001;

export function attachContentOwnedFactProjection(
  coverage: CandidateCoverageReceipt,
  input: { readonly objectId: string; readonly content: string }
): CandidateCoverageReceipt {
  if (coverage.atoms.some((atom) => atom.kind === "fact_projection")) return coverage;
  const text = input.content.trim().normalize("NFC");
  if (text.length === 0) return coverage;
  const slots = Object.freeze([
    Object.freeze({ role: "value" as const, text }) satisfies AssociativeFactSlot
  ]);
  const atom: CandidateCoverageAtom = Object.freeze({
    atom_id: `fact:${input.objectId}:${String(CONTENT_OWNED_FACT_KEY_PROJECTION_ID)}`,
    kind: "fact_projection",
    strength: 1,
    independence_key: `content:${input.objectId}`,
    evidence_object_id: null,
    document_identity: `content_fact_key:${input.objectId}`,
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
