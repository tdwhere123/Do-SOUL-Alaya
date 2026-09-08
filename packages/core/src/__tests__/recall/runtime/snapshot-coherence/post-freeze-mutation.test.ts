import { describe, expect, it } from "vitest";
import { captureQueryCondition } from
  "../../../../recall/query/condition/query-condition-capture.js";
import {
  PREPARE_RETRIEVAL_CHANNEL_OWNERS,
  capturePreparedSnapshotCoherenceReceipt,
  capturePreparedSnapshotVector,
  digestRecallDecisionContractV1
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import {
  CLOCK_AS_OF,
  conditionDraft,
  testPin,
  testSha256
} from "../../query/query-condition-test-fixtures.js";

const RETRIEVAL_OWNERS = PREPARE_RETRIEVAL_CHANNEL_OWNERS;

describe("prepared snapshot retrieval declarations", () => {
  it("declares five FieldPrefix channels as unavailable without empty-retrieval logic", () => {
    const pin = testPin();
    const queryCondition = captureQueryCondition(conditionDraft(), {
      sha256: testSha256(),
      now: () => CLOCK_AS_OF,
      pin
    });
    const input = { queryCondition, pin, retrieval_channel_owners: RETRIEVAL_OWNERS };
    const vector = capturePreparedSnapshotVector(input);
    const receipt = capturePreparedSnapshotCoherenceReceipt(input);
    expect(receipt.coherence_state).toBe("unavailable");
    expect(receipt.vector_digest).toBe(vector.vector_digest);
    expect(receipt.reasons).toContain("source_unavailable");
    expect(receipt.reasons).not.toContain("retrieval_undeclared");
    expect(receipt.reasons).not.toContain("decision_contract_unknown");
    expect(vector.retrieval_channel_snapshots).toHaveLength(5);
    expect(vector.retrieval_channel_snapshots.map((channel) => channel.source_owner))
      .toEqual([...RETRIEVAL_OWNERS].sort((left, right) => left.localeCompare(right)));
    for (const channel of vector.retrieval_channel_snapshots) {
      expect(channel.lag_bound.kind).toBe("unavailable");
    }
    expect(vector.embedding_generation_and_model.lag_bound.kind).toBe("unavailable");
    expect(vector.path_graph_generation.lag_bound.kind).toBe("unavailable");
    expect(vector.temporal_index_generation.lag_bound.kind).toBe("unavailable");
    expect(vector.governance_frontier.lag_bound.kind).toBe("unavailable");
    expect(vector.projection_generation.lag_bound.kind).toBe("exact");
    expect(vector.decision_contract_digest).toBe(digestRecallDecisionContractV1());
    expect(vector.decision_contract_digest).not.toBe(queryCondition.identity);
    const otherCondition = captureQueryCondition(
      conditionDraft({ query_task_factors: ["task:other"] }),
      { sha256: testSha256(), now: () => CLOCK_AS_OF, pin }
    );
    expect(otherCondition.identity).not.toBe(queryCondition.identity);
    expect(capturePreparedSnapshotVector({
      queryCondition: otherCondition,
      pin,
      retrieval_channel_owners: RETRIEVAL_OWNERS
    }).decision_contract_digest).toBe(vector.decision_contract_digest);
    const undeclared = capturePreparedSnapshotCoherenceReceipt({ queryCondition, pin });
    expect(undeclared.reasons).toContain("retrieval_undeclared");
    expect(undeclared.receipt_digest).not.toBe(receipt.receipt_digest);
  });
});
