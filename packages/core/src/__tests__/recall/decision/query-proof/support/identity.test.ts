import { describe, expect, it } from "vitest";
import { ShadowContractError } from "../../../../../recall/decision/contract-primitives.js";
import { createSupportHypergraph } from "../../../../../recall/decision/query-proof/support/index.js";
import { QUERY, SNAPSHOT } from "./fixtures.js";

describe("support identity guards", () => {
  it("rejects candidate_key, content hash, and hashed support as semantic binding identity", () => {
    const forbidden = [
      "workspace_local:memory_entry:obj-1",
      "global:memory_entry:obj-1",
      `sha256:${"c".repeat(64)}`,
      "verified_user_assertion:ev-1:sha256:deadbeef",
      "object:logical-1",
      "evidence:ev-1"
    ];
    for (const id of forbidden) {
      expect(() => createSupportHypergraph({
        query_id: QUERY,
        snapshot_digest: SNAPSHOT,
        nodes: [{ kind: "answer_binding", id }]
      })).toThrow(ShadowContractError);
      expect(() => createSupportHypergraph({
        query_id: QUERY,
        snapshot_digest: SNAPSHOT,
        nodes: [{ kind: "proposition", id }]
      })).toThrow(ShadowContractError);
    }
  });

  it("rejects content hash as an evidence unit mint", () => {
    expect(() => createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [{ kind: "evidence_unit", id: `sha256:${"d".repeat(64)}` }]
    })).toThrow(/content hash/u);
  });

  it("allows a candidate_key only on candidate_projection", () => {
    const receipt = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "candidate_projection", id: "workspace_local:memory_entry:obj-1" },
        { kind: "answer_binding", id: "binding.person.alice" }
      ]
    });
    expect(receipt.nodes.map((node) => node.kind)).toEqual([
      "answer_binding",
      "candidate_projection"
    ]);
  });
});
