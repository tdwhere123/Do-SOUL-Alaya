import { randomUUID } from "node:crypto";

import {
  addDecision,
  errorMessage,
  type ReconciliationDecision,
  type ReconciliationInput,
  type ReconciliationServiceMethodOwner,
  type ReconciliationVerdictApplier
} from "./reconciliation-service-internal.js";
import { reconciliationServiceRunDecisionSection } from "./reconciliation-service-methods-2.js";
import { reconciliationServiceWarn } from "./reconciliation-service-methods-6.js";

export async function reconciliationServiceRunWithDecision(owner: ReconciliationServiceMethodOwner, input: ReconciliationInput, applyVerdict: ReconciliationVerdictApplier): Promise<ReconciliationDecision> {
    return await owner.mutex.runExclusive(input.workspaceId, async () => {
      if (owner.lease === undefined) {
        return await reconciliationServiceRunDecisionSection(owner, input, applyVerdict);
      }
      const ownerToken = randomUUID();
      const nowDate = owner.now();
      const acquired = owner.lease.tryAcquire(
        input.workspaceId,
        ownerToken,
        nowDate.toISOString(),
        new Date(nowDate.getTime() + owner.leaseTtlMs).toISOString()
      );
      if (acquired === null) {
        // A live reconcile for this workspace is held by another process.
        // Degrade to a direct ADD with a conflict scan rather than block
        // or risk an interleaved decision; the fact stays durable.
        reconciliationServiceWarn(owner, "reconciliation lease busy — degrading to ADD", {
          workspace_id: input.workspaceId,
          signal_id: input.signalId
        });
        const degraded = addDecision(
          0,
          true,
          "reconciliation lease held by another process — added with conflict scan"
        );
        await applyVerdict(degraded);
        return degraded;
      }
      try {
        return await reconciliationServiceRunDecisionSection(owner, input, applyVerdict);
      } finally {
        try {
          owner.lease.release(input.workspaceId, ownerToken);
        } catch (error) {
          // A failed release is not fatal: the TTL reclaims the lease.
          reconciliationServiceWarn(owner, "reconciliation lease release failed", {
            workspace_id: input.workspaceId,
            error: errorMessage(error)
          });
        }
      }
    });
  }
