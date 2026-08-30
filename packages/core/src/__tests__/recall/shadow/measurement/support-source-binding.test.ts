import { describe, expect, it } from "vitest";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";
import {
  verifySupportMeasurementPreparedAuthorityV1
} from "../../../../recall/shadow/measurement/index.js";
import {
  PATH_GRAPH_GENERATION_SOURCE_OWNER
} from "../../../../recall/shadow/measurement/support-source-admission.js";
import {
  capturedPathGraphPreparedAuthority,
  cleanup
} from "../live-receipt-fixtures.js";

const GRAPH_A = digestRecallFieldIdentity({ graph: "a" });
const GRAPH_B = digestRecallFieldIdentity({ graph: "b" });
const SOURCE = digestRecallFieldIdentity({ source: "live-receipts" });
const OBSERVATIONS = digestRecallFieldIdentity({ observations: [] });

describe("support measurement source binding", () => {
  it("does not let one path_graph capability authorize two support graphs", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = prepared.snapshotReadLease.capabilities.find((bound) =>
      bound.source_owner === PATH_GRAPH_GENERATION_SOURCE_OWNER);
    expect(capability?.view_kind).toBe("captured");
    const evidence = {
      workspace_id: "workspace-1",
      query_condition: prepared.queryCondition,
      canonical_query_evidence: prepared.canonicalQueryEvidence,
      canonical_query_compilation: prepared.canonicalQueryCompilation,
      snapshot_vector: prepared.snapshotVector,
      snapshot_coherence_receipt: prepared.snapshotCoherenceReceipt,
      snapshot_read_lease: prepared.snapshotReadLease,
      support_source_capability: capability!,
      support_source_digest: SOURCE,
      support_observation_digest: OBSERVATIONS
    };
    const left = verifySupportMeasurementPreparedAuthorityV1({
      evidence: { ...evidence, support_graph_digest: GRAPH_A }
    });
    const right = verifySupportMeasurementPreparedAuthorityV1({
      evidence: { ...evidence, support_graph_digest: GRAPH_B }
    });
    expect(left.authority_digest).not.toBe(right.authority_digest);
    expect(left.request_digest).not.toBe(right.request_digest);
    expect(left.query_id).toBe(right.query_id);
    expect(left.snapshot_digest).toBe(right.snapshot_digest);
    cleanup(prepared);
  });
});
