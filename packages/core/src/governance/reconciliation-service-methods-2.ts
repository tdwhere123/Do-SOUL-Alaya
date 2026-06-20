import {
  addDecision,
  type ReconciliationDecision,
  type ReconciliationInput,
  type ReconciliationServiceMethodOwner,
  type ReconciliationVerdictApplier
} from "./reconciliation-service-internal.js";
import { reconciliationServiceDecide } from "./reconciliation-service-methods-3.js";
import { reconciliationServiceApplyUpdate } from "./reconciliation-service-methods-5.js";
import { reconciliationServiceAuditDrop } from "./reconciliation-service-methods-6.js";

export async function reconciliationServiceRunDecisionSection(owner: ReconciliationServiceMethodOwner, input: ReconciliationInput, applyVerdict: ReconciliationVerdictApplier): Promise<ReconciliationDecision> {
    const decision = await reconciliationServiceDecide(owner, input);

    if (decision.kind === "update" && decision.survivingObjectId !== undefined) {
      // UPDATE: the router creates the evidence_capsule first so the
      // refined row can cite it; then the in-place rewrite runs while
      // the lock is still held. If the rewrite cannot be applied the
      // fact must not be lost — degrade to ADD and re-drive the router
      // so it creates the memory_entry instead.
      const { incomingEvidenceRef } = await applyVerdict(decision);
      const applied = await reconciliationServiceApplyUpdate(
        owner,
        decision.survivingObjectId,
        input.incomingContent.trim(),
        input.incomingDomainTags,
        incomingEvidenceRef
      );
      if (applied) {
        return decision;
      }
      const degraded = addDecision(
        decision.bestSimilarity,
        true,
        "LLM UPDATE could not be applied — added with conflict scan"
      );
      await applyVerdict(degraded);
      return degraded;
    }

    if (decision.kind === "noop" && decision.survivingObjectId !== undefined) {
      // NOOP creates nothing — no evidence_capsule, no memory_entry.
      // The verdict is still surfaced to the router for the bench
      // sidecar remap; the router creates no object on this branch.
      await applyVerdict(decision);
      await reconciliationServiceAuditDrop(owner, input, decision.survivingObjectId, decision.bestSimilarity);
      return decision;
    }

    // ADD (or an unactionable update/noop without a target): the router
    // creates the evidence_capsule + memory_entry inside the lock.
    await applyVerdict(decision);
    return decision;
  }
