import { createHash } from "node:crypto";
import { productStateKeyFromIndexEntry, type FieldSnapshot, type IndexEntry } from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { productStateNodeId } from "../conditional-field/reference/bind-max-min.js";
import { indexEntryRevision } from "../conditional-field/index/project-accepting-index.js";

type ProjectionProgress = NonNullable<FieldEngineState["projection_progress"]>;

export function resumeIndexProjection(state: FieldEngineState, snapshot: FieldSnapshot): ProjectionProgress {
  const revision = createHash("sha256").update(JSON.stringify([
    snapshot.values, snapshot.seeds, snapshot.facets, state.resume_cursors, state.support_progress,
    [...state.claims], [...(state.claim_propositions ?? [])], state.support, state.derivations,
    state.grounding_progress?.input_digest, state.grounding_progress?.completed_work
  ])).digest("hex");
  const prior = state.projection_progress;
  return { revision, generation: (prior?.generation ?? 0) + (prior?.revision === revision ? 0 : 1),
    offset: prior?.revision === revision ? prior.offset : 0, delivered_entries: prior?.delivered_entries ?? {} };
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
