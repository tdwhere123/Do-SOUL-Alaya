import { recordRecallDegradation } from "../../runtime/diagnostics.js";
import { errorNameOf, toErrorMessage } from "../../runtime/recall-service-helpers.js";
import type {
  RecallDegradationReason,
  RecallServiceWarnPort
} from "../../runtime/recall-service-types.js";

export function recordEvidenceContextBulkFailure(
  params: Readonly<{
    readonly warn: RecallServiceWarnPort;
    readonly workspaceId: string;
    readonly degradationReasons?: Set<RecallDegradationReason>;
  }>,
  error: unknown
): void {
  params.warn("evidence context lookup for coverage and answer authority failed", {
    workspace_id: params.workspaceId,
    operation: "evidence_gist_lookup_for_coverage",
    errorName: errorNameOf(error),
    error: toErrorMessage(error)
  });
  recordRecallDegradation(params, "evidence_context_bulk_failed");
}
