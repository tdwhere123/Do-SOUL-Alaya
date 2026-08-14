import { normalizeMemoryObjectKeySurface, type MemoryObjectKey } from "@do-soul/alaya-protocol";
import { formedKey } from "./form-key.js";
import { occupies } from "./occupancy.js";
import type { DraftMemoryObjectKey, MintableEvidence } from "../types.js";

export function mintOsfSurfaceKeys(input: Readonly<{
  readonly workspace_id: string;
  readonly owner_id: string;
  readonly memory_content: string;
  readonly evidence: Readonly<MintableEvidence>;
  readonly occupied: ReadonlySet<string>;
}>): readonly Readonly<MemoryObjectKey>[] {
  const graph = input.evidence.osf_graph;
  if (graph === null) return Object.freeze([]);
  const contentNormalized = normalizeMemoryObjectKeySurface(input.memory_content);
  return Object.freeze(graph.factors.flatMap((factor) => [
    ...(occupies(factor.surface, input.occupied, contentNormalized)
      ? []
      : formedKey(osfDraft(input, factor.factor_id, factor.surface, "surface"))),
    ...(normalizeMemoryObjectKeySurface(factor.semantic_identity) !==
        normalizeMemoryObjectKeySurface(factor.surface) &&
        !occupies(factor.semantic_identity, input.occupied, contentNormalized)
      ? formedKey(osfDraft(input, factor.factor_id, factor.semantic_identity, "identity"))
      : [])
  ]));
}

function osfDraft(
  input: Readonly<{
    readonly workspace_id: string;
    readonly owner_id: string;
    readonly evidence: Readonly<MintableEvidence>;
  }>,
  factorId: string,
  surface: string,
  role: "surface" | "identity"
): DraftMemoryObjectKey {
  return {
    workspace_id: input.workspace_id,
    owner_id: input.owner_id,
    key_type: role === "surface" ? "osf_surface" : "osf_identity",
    surface,
    language: /[\p{Script=Han}]/u.test(surface) ? "zh" : "en",
    source_kind: "osf_factor",
    source_ref: `evidence:${input.evidence.object_id}:osf:${factorId}:${role}`
  };
}
