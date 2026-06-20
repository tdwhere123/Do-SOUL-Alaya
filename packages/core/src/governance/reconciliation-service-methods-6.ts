import { SignalEventType, SoulSignalTriagedPayloadSchema } from "@do-soul/alaya-protocol";
import {
  encodeAuditContent,
  errorMessage,
  type ReconciliationInput,
  type ReconciliationServiceMethodOwner
} from "./reconciliation-service-internal.js";

export async function reconciliationServiceAuditDrop(owner: ReconciliationServiceMethodOwner, input: ReconciliationInput, survivingObjectId: string, similarity: number): Promise<void> {
    try {
      await owner.deps.eventLog.append({
        event_type: SignalEventType.SOUL_SIGNAL_TRIAGED,
        entity_type: "candidate_memory_signal",
        entity_id: input.signalId,
        workspace_id: input.workspaceId,
        run_id: input.runId,
        caused_by: `reconciliation_noop:duplicate_of=${survivingObjectId}:similarity=${similarity.toFixed(3)}:dropped_content=${encodeAuditContent(input.incomingContent)}`,
        payload_json: SoulSignalTriagedPayloadSchema.parse({
          signal_id: input.signalId,
          workspace_id: input.workspaceId,
          run_id: input.runId,
          triage_result: "dropped"
        })
      });
    } catch (error) {
      reconciliationServiceWarn(owner, "reconciliation NOOP audit append failed", {
        signal_id: input.signalId,
        error: errorMessage(error)
      });
    }
  }

export function reconciliationServiceWarn(owner: ReconciliationServiceMethodOwner, message: string, meta: Record<string, unknown>): void {
    owner.deps.warn?.(message, meta);
  }
