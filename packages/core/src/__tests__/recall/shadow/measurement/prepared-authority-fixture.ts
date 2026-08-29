import { buildDefaultPolicy } from
  "../../../../recall/runtime/orchestration.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../../../recall/runtime/query/field-query-session.js";
import { prepareRecallRequest } from
  "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../recall/runtime/query/recall-request-time.js";
import type { PreparedRecallRequest } from
  "../../../../recall/runtime/recall-service-runner-types.js";
import type { PreparedMeasurementAuthorityEvidenceV1 } from
  "../../../../recall/shadow/measurement/index.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { createDependencies, createTaskSurface } from
  "../../recall-service-test-fixtures.js";
import { D1_REQUEST } from "../d1/d1-proof-fixture.js";

const NOW = "2026-08-29T00:00:00.000Z";

export async function prepareMeasurementEvidenceFixture(): Promise<PreparedRecallRequest> {
  const { dependencies } = createDependencies([]);
  return await prepareRecallRequest({
    dependencies,
    warn: () => undefined,
    now: () => NOW,
    buildDefaultPolicy: () => buildDefaultPolicy({
      strategy: "analyze",
      taskSurfaceRef: createTaskSurface().runtime_id,
      now: () => NOW,
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
    }),
    fieldQuerySession: createSeededTestOnlyInMemoryFieldQuerySession(
      fieldContractSha256,
      "workspace-1"
    ),
    sha256: fieldContractSha256
  }, {
    taskSurface: createTaskSurface(),
    workspaceId: "workspace-1",
    strategy: "analyze"
  }, captureRecallRequestTime({ now: () => NOW }));
}

export function measurementEvidence(
  prepared: PreparedRecallRequest,
  lexical = false
): PreparedMeasurementAuthorityEvidenceV1 {
  return Object.freeze({
    workspace_id: "workspace-1",
    query_condition: prepared.queryCondition,
    canonical_query_evidence: prepared.canonicalQueryEvidence,
    canonical_query_compilation: prepared.canonicalQueryCompilation,
    snapshot_vector: prepared.snapshotVector,
    snapshot_coherence_receipt: prepared.snapshotCoherenceReceipt,
    snapshot_read_lease: prepared.snapshotReadLease,
    ...(lexical ? {
      lexical_request_pin: Object.freeze({
        workspace_id: "workspace-1",
        request_digest: D1_REQUEST,
        field_prefix: "lexical_relaxed" as const,
        candidate_key_domain: "memory_object_id" as const
      })
    } : {})
  });
}

export function releaseMeasurementEvidenceFixture(prepared: PreparedRecallRequest): void {
  prepared.releaseProjectionPin();
  prepared.projectionPinLease.stop();
}
