import { sharedProductIdentity, type Derivation, type IndexEntry, type ProductUpdate } from "@do-soul/alaya-protocol";
import { productIdOfEntry } from "../../runtime/index-continuation.js";
import { hasDerivationForest, mixedPayloadGeneration } from "./explanation.js";
import { ExplanationDelivery } from "./explanation-delivery.js";
import type { AcceptingProjectionInput } from "./project-accepting-index.js";
import { retainedProjectionPreparationAdvanced, type RetainedProjectionPreparation } from "./facet-visit-accounting.js";

/** Proof selection and traversal share the page's remaining work and memory. */
export function projectPageExplanations(page: Readonly<{
  input: AcceptingProjectionInput; members: readonly IndexEntry[]; updates: readonly IndexEntry[];
  productUpdates: readonly ProductUpdate[]; retractions: readonly ProductUpdate[];
  remaining: number; available: number; memory: number;
  preparation_origin?: RetainedProjectionPreparation;
  facet_index?: RetainedProjectionPreparation["facet_index"];
  updatesFor: (entry: IndexEntry) => readonly ProductUpdate[];
}>): Readonly<{
  input: AcceptingProjectionInput; members: readonly IndexEntry[]; updates: readonly IndexEntry[];
  productUpdates: readonly ProductUpdate[]; remaining: number; available: number; explanations?: readonly Derivation[];
  terminal?: "invalid" | "capacity";
}> {
  let { input, members, updates, productUpdates, remaining, available } = page;
  if (!hasDerivationForest(input)
      || input.expand_payload === false || mixedPayloadGeneration(input.snapshot_id, input.payload_generation)) {
    return { input, members, updates, productUpdates, remaining, available };
  }
  const prior = input.explanation_progress;
  let chosen = [...updates, ...members];
  let samePage = false, retainCompleted = false;
  if (prior !== undefined && prior.pageBudget === input.budget.page_budget) {
    const pending = prior.page.filter(old => page.updatesFor(old).length > 0);
    const matching = pending.flatMap(old => {
      const found = chosen.find(entry => sameExplanationPage([old], [entry]));
      return found === undefined ? [] : [found];
    });
    if (matching.length > 0) {
      const ids = new Set(matching.map(productIdOfEntry));
      if (chosen.length > matching.length) remaining = Math.max(remaining, 1);
      members = members.filter(entry => ids.has(productIdOfEntry(entry)));
      updates = updates.filter(entry => ids.has(productIdOfEntry(entry)));
      productUpdates = productUpdates.filter(update => update.update_kind === "retraction"
        || ids.has(sharedProductIdentity(update.product)));
      chosen = matching;
      samePage = true;
      retainCompleted = pending.length > matching.length;
      if (retainCompleted) remaining = Math.max(remaining, 1);
    } else if (chosen.length === 0 && pending.length > 0) {
      samePage = true;
    }
  }
  const released = prior !== undefined && !samePage ? prior.retainedBytes : 0;
  if (prior !== undefined && !samePage) input.on_explanation_progress?.(undefined, -released, 0);
  const needsProof = chosen.some(entry => entry.explanation_ids.length > 0);
  // A retained cursor owns its selected page even before the first proof step.
  const baseBytes = !samePage && needsProof ? 96 + 128 * chosen.length : 0;
  if (baseBytes > page.memory + released) {
    members = members.map(entry => ({ ...entry, explanation_ids: [] }));
    return { input: { ...input, payload_work: "open", resource_work: "open" }, members, updates: [],
      productUpdates: productUpdates.filter(update => update.update_kind === "retraction"),
      remaining: Math.max(remaining, 1), available, explanations: [] };
  }
  const progress = samePage ? prior?.fork() : needsProof
    ? new ExplanationDelivery(chosen, input.derivation_forest ?? input.derivations ?? [],
      input.support, input.budget.page_budget, baseBytes, input.explanation_source_revision) : undefined;
  if (progress === undefined) return { input, members, updates, productUpdates, remaining, available, explanations: [] };
  const deliveryRetention = input.delivery_retention?.(members);
  const allowance = available;
  const delivered = progress.advance(allowance, page.memory + released - baseBytes);
  if (!delivered.complete && allowance < 1) input.on_atomic_work_block?.({
    phase: "explanation", required_work: 1, available_work: allowance });
  available -= delivered.work;
  const ready = delivered.complete && chosen.length > 0;
  const materializationWork = ready ? progress.materializationWork : 0;
  const materializationBlocked = ready && materializationWork > available;
  const preparationAdvanced = input.preparation_advanced === true || retainedProjectionPreparationAdvanced({
    grounding_progress: input.grounding_progress, explanation_progress: progress, facet_index: page.facet_index
  }, page.preparation_origin ?? { grounding_progress: input.grounding_progress,
    explanation_progress: prior, facet_index: input.projection_facet_index });
  // Finishing traversal can leave too little work to copy its arrays. Retain that
  // completed cursor for a fresh request; a repeated unadvanced shortage is terminal.
  const materializationRefused = materializationBlocked && !preparationAdvanced;
  const readyToDeliver = ready && !materializationBlocked;
  const terminal = delivered.invalid ? "invalid" : delivered.capacity_limited ? "capacity" : undefined;
  // Completed proofs can retain their cursor when another selected entry is still
  // pending. Price the actual surviving lifetime, rather than summing disjoint peaks.
  const survives = terminal === undefined && !materializationRefused && !(readyToDeliver && !retainCompleted);
  const retentionRefused = survives && deliveryRetention !== undefined
    && deliveryRetention.required_bytes > page.memory + released - baseBytes - delivered.bytes
      + deliveryRetention.releasable_bytes;
  const refused = materializationRefused || retentionRefused;
  const releaseReady = (readyToDeliver && !retainCompleted) || (ready && refused);
  const releasedNow = releaseReady || terminal !== undefined || retentionRefused;
  if (readyToDeliver && !refused) available -= materializationWork;
  input.on_explanation_progress?.(releasedNow ? undefined : progress,
    baseBytes + delivered.bytes - (releasedNow ? progress.retainedBytes : 0),
    delivered.work + (readyToDeliver && !refused ? materializationWork : 0), baseBytes + delivered.bytes);
  input = { ...input, explanation_progress: releasedNow ? undefined : progress };
  if (terminal !== undefined) return { input, members: [], updates: [], productUpdates: [],
    remaining, available, explanations: [], terminal };
  if (refused) {
    members = members.map(entry => ({ ...entry, explanation_ids: [] }));
    updates = updates.map(entry => ({ ...entry, explanation_ids: [] }));
    productUpdates = [...page.retractions, ...updates.flatMap(page.updatesFor)
      .filter(update => update.update_kind !== "payload")].slice(0, input.budget.page_budget);
    return { input: { ...input, explanation_materialization_refused: true }, members, updates,
      productUpdates, remaining, available, explanations: [] };
  }
  if (readyToDeliver) {
    const deliveredPage = progress.deliveredPage;
    const filtered = new Map(deliveredPage.map(entry => [productIdOfEntry(entry), entry]));
    members = members.map(entry => ({ ...entry, explanation_ids: filtered.get(productIdOfEntry(entry))?.explanation_ids ?? entry.explanation_ids }));
    updates = updates.map(entry => ({ ...entry, explanation_ids: filtered.get(productIdOfEntry(entry))?.explanation_ids ?? entry.explanation_ids }));
    productUpdates = [...page.retractions, ...updates.flatMap(page.updatesFor)].slice(0, input.budget.page_budget);
    if (progress.omitted && deliveredPage.every(entry => entry.explanation_ids.length === 0)) {
      input = { ...input, payload_work: "open" };
    }
    return { input, members, updates, productUpdates, remaining, available, explanations: progress.explanations };
  }
  // Membership remains usable while proof traversal continues. No partial forest or
  // dangling explanation root crosses the delivery boundary.
  members = members.map(entry => ({ ...entry, explanation_ids: [] }));
  return { input: { ...input, payload_work: "open", resource_work: "open" }, members, updates: [],
    productUpdates: productUpdates.filter(update => update.update_kind === "retraction"),
    remaining: Math.max(remaining, 1), available, explanations: [] };
}

function sameExplanationPage(left: readonly IndexEntry[], right: readonly IndexEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) =>
    productIdOfEntry(entry) === productIdOfEntry(right[index]!)
    && entry.explanation_ids.length === right[index]!.explanation_ids.length
    && entry.explanation_ids.every((id, at) => id === right[index]!.explanation_ids[at]));
}
