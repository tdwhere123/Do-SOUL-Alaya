import { productStateKeyFromIndexEntry, type FieldSnapshot, type IndexEntry } from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { productStateNodeId } from "../conditional-field/reference/bind-max-min.js";
import { indexEntryRevision } from "../conditional-field/index/project-accepting-index.js";

type ProjectionProgress = NonNullable<FieldEngineState["projection_progress"]>;

export function resumeIndexProjection(state: FieldEngineState, snapshot: FieldSnapshot): ProjectionProgress {
  const references = [state.binding.kind === "bound" ? state.binding.values : snapshot.values,
    state.binding.kind === "bound" ? state.binding.guaranteed_values : null,
    state.ordered_identities, state.seeds, state.facets,
    state.claims, state.claim_propositions, state.transitions, state.derivations, state.transition_derivations
  ];
  const prior = state.projection_progress;
  const same = prior !== undefined && references.every((reference, index) => reference === prior.input_references[index]);
  const generation = (prior?.generation ?? 0) + (same ? 0 : 1);
  return { revision: `projection-generation:${generation}`, input_references: references, generation,
    offset: same ? prior!.offset : 0, delivered_entries: prior?.delivered_entries ?? {} };
}

export function retainIndexDelivery(
  progress: ProjectionProgress,
  entries: readonly IndexEntry[],
  first: boolean
): Readonly<{ progress: ProjectionProgress; bytes: number }> {
  const delivered = { ...progress.delivered_entries };
  let bytes = first ? 256 : 0;
  for (const entry of entries) {
    const key = productStateNodeId(productStateKeyFromIndexEntry(entry));
    if (delivered[key] === undefined) bytes += 128 + Buffer.byteLength(key, "utf8");
    // Open observation can refine an already emitted product; retain only its latest semantic revision.
    delivered[key] = indexEntryRevision(entry);
  }
  return { progress: { ...progress, delivered_entries: delivered }, bytes };
}
