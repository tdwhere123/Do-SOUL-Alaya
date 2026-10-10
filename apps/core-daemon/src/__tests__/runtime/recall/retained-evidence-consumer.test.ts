import { afterEach, describe, expect, it, vi } from "vitest";
import { fieldReceiptContractFields, hashContentDigest, hashSourceRecordId, indexEntryCacheKey,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID, SourceRecordIdentitySchema, sourceSemanticQueryIdentity,
  UNKNOWN_UTTERANCE_ATTRIBUTION } from "@do-soul/alaya-protocol";
import { assembleSourceSemanticLibraryIndex, encodeSourceSemanticLibraryResponse, fieldContractSha256,
  sourceSemanticLibraryQueryIdentity, sourceGoldRootIdentity } from "@do-soul/alaya-core";
import * as core from "@do-soul/alaya-core";
import { alternativeSelectionFixture, selectionExecutionBudget } from
  "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { CLOCK, workerRecall } from
  "../../../../../bench-runner/src/__tests__/longmemeval/measurement/source-semantic-library-measurement-fixture.js";
import { readRetainedEvidence, RetainedConsumerLedger, RETAINED_CONSUMER_BUDGET,
  type EvaluatorCompatibilityPremise, type RetainedConsumerPacket } from "./retained-evidence-consumer.test-support.js";

afterEach(() => vi.restoreAllMocks());

function authoredPackets() {
  const fixture = alternativeSelectionFixture(selectionExecutionBudget);
  const queryId = sourceSemanticQueryIdentity(fixture.semantics, fieldContractSha256);
  const premises: EvaluatorCompatibilityPremise[] = ["compatible", "unknown", "incompatible"].map(compatibility => ({
    id: "h", query_semantics_id: queryId, compatibility: compatibility as EvaluatorCompatibilityPremise["compatibility"] }));
  const packet = (positions: readonly number[]): RetainedConsumerPacket => {
    const sources = positions.map(position => fixture.sources[position]!);
    const proofs = sources.flatMap(source => source.package.proofs);
    const index = assembleSourceSemanticLibraryIndex({ query_id: sourceSemanticLibraryQueryIdentity(fixture.original),
      snapshot_id: `sha256:${"c".repeat(64)}`, interpretation_id: "authored-consumer-test", as_of: CLOCK,
      source_entries: [], proof_groups: sources.map(source => ({ entries: source.package.entries,
        explanations: source.package.explanations })), selected_entries: sources.map(source => source.package.entry),
      root_order: sources.map(source => {
        if (source.package.entry.target.kind !== "source_evidence") throw new Error("authored source root required");
        return sourceGoldRootIdentity(source.package.entry.target);
      }),
      truncated: false, open_residuals: false }).index;
    const previews = Object.fromEntries(index.entries.map(entry => {
      const source = sources.find(source => source.package.entry.target.kind === "source_evidence"
        && entry.target.kind === "source_evidence" && source.package.entry.target.root_id === entry.target.root_id)!;
      return [indexEntryCacheKey(entry), source.body];
    }));
    const response = encodeSourceSemanticLibraryResponse({ ...workerRecall(index, proofs), previews, request_budget: selectionExecutionBudget });
    // Source authority comes from authored source declarations, independently of the response's proof records.
    const trusted = sources.map(source => {
      const material = { source_id: source.id, source_version: "1", content_digest: hashContentDigest(source.body, fieldContractSha256) };
      return { body: source.body, record: SourceRecordIdentitySchema.parse({ ...material,
        ...fieldReceiptContractFields({ identity: hashSourceRecordId(material, fieldContractSha256),
          producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID, consumer: "projection_generation" }),
        schema_version: 1, workspace_id: "ws", evidence_object_id: null, recorded_at: CLOCK,
        event_time: null, valid_from: null, valid_to: null, scope_class: "project",
        operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION }) };
    });
    return { original_query: fixture.original, query_semantics: fixture.semantics,
      encoded_response: JSON.stringify(response), sources: trusted };
  };
  return { packets: [packet([0, 1]), packet([2])], premises };
}

describe("retained delivered evidence consumer", () => {
  it("uses only delivered verified inputs under an explicit compatibility premise and preserves native qualifications", () => {
    const { packets, premises } = authoredPackets();
    const verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
    const result = readRetainedEvidence(packets, premises);
    expect(result).toMatchObject({ status: "completed", failure: null, native_answer_upgrade: false, native_continuations_executed: 0 });
    expect(result.packets.map(packet => packet.readouts.map(readout => readout.complete_alternatives)))
      .toEqual([[[0], [], []], [[], [], []]]);
    expect(result.packets.map(packet => packet.support?.evidence_inputs.filter(input => input.status === "supported")
      .map(({ alternative, input }) => [alternative, input]))).toEqual([[[0, 0], [0, 1]], [[1, 0], [1, 1]]]);
    for (const [index, packet] of result.packets.entries()) {
      const response = JSON.parse(packets[index]!.encoded_response);
      expect(packet.native_qualifiers).toEqual(response.slot_qualifiers);
      expect(packet.support).toMatchObject({ answer: "unrepresented", operation: "not_executed", compatibility: "unknown", distinctness: "unknown" });
      expect(packet.offline_reader_exposure).toMatchObject({ request_continuation: null, page_purpose: "membership",
        delivery_id: response.delivery_id, initial: { session_id: expect.any(String) } });
      for (const citation of packet.citations) {
        expect(citation.target).toEqual(response.results[citation.slot].target);
        expect(citation.delivered_text).toBe(response.results[citation.slot].content_preview);
        expect(response.slot_qualifiers[citation.slot].witnesses).toContainEqual({
          conditional_computation_id: citation.conditional_computation_id, binding_id: citation.binding_id });
      }
      expect(packet.proof_attempts.every(attempt => attempt.status === "verified")).toBe(true);
    }
    expect(verify).toHaveBeenCalledTimes(3);
    const allowances = verify.mock.calls.map(call => call[5]!);
    expect(allowances[1]!.work_units).toBeLessThan(allowances[0]!.work_units);
    expect(allowances[2]!.memory_bytes).toBeLessThan(allowances[1]!.memory_bytes);
    expect(result.resource_usage.work_units).toBeLessThanOrEqual(RETAINED_CONSUMER_BUDGET.work_units);
    expect(result.resource_usage.memory_bytes).toBeLessThanOrEqual(RETAINED_CONSUMER_BUDGET.memory_bytes);
    expect(Object.values(result.costs).reduce((sum, cost) => sum + cost.work_units, 0)).toBe(result.resource_usage.work_units);
    expect(result.costs.proof_verification.work_units).toBeGreaterThan(0);
  });

  it.each(["swapped_result", "missing_qualifier", "duplicate_result", "foreign_query", "source_body", "source_record", "proof_witness"] as const)(
    "stops with an inspectable prefix for %s corruption", corruption => {
      const { packets, premises } = authoredPackets(), packet = structuredClone(packets[0]!);
      const response = JSON.parse(packet.encoded_response);
      if (corruption === "swapped_result") response.results.reverse();
      if (corruption === "missing_qualifier") response.slot_qualifiers.pop();
      if (corruption === "duplicate_result") response.results[1] = response.results[0];
      if (corruption === "foreign_query") Object.assign(packet, { original_query: "A different question." });
      if (corruption === "source_body") Object.assign(packet.sources[0]!, { body: "A different source body." });
      if (corruption === "source_record") Object.assign(packet.sources[0]!.record, { source_version: "2" });
      if (corruption === "proof_witness") {
        const proof = response.proofs[0], root = proof.binding_results[0].explanation_ids[0];
        proof.derivations.find((derivation: { derivation_id: string }) => derivation.derivation_id === root)
          .observation_ids.push("undelivered-observation");
      }
      Object.assign(packet, { encoded_response: JSON.stringify(response) });
      const result = readRetainedEvidence([packet], premises);
      expect(result.status).toBe("stopped"); expect(result.failure).not.toBeNull();
      expect(result.packets).toHaveLength(1);
      expect(result.packets[0]!.readouts).toEqual([]);
      expect(result.resource_usage.work_units).toBeLessThanOrEqual(RETAINED_CONSUMER_BUDGET.work_units);
    });

  it("does not treat an undelivered trusted root or a foreign evaluator premise as evidence", () => {
    const { packets, premises } = authoredPackets();
    const partial = { ...packets[1]!, sources: [...packets[1]!.sources, ...packets[0]!.sources] };
    expect(readRetainedEvidence([partial], premises).packets[0]!.readouts[0]!.conditional_evidence_complete).toBe(false);
    const result = readRetainedEvidence([packets[0]!], [{ ...premises[0]!, query_semantics_id: `sha256:${"a".repeat(64)}` }]);
    expect(result).toMatchObject({ status: "stopped", failure: { phase: "conditional_evidence" } });
    expect(result.packets[0]!.readouts).toEqual([]);
  });

  it("stops before proof verification when the cumulative reader allowance cannot admit its input", () => {
    const { packets, premises } = authoredPackets(), verify = vi.spyOn(core, "deliveredSourceSemanticLibraryProof");
    const budget = { work_units: 1_000, memory_bytes: 100_000 };
    const ledger = new RetainedConsumerLedger(budget);
    ledger.phase = "artifact_decode";
    ledger.charge(500, 1_000, "prior container decode");
    const result = readRetainedEvidence(packets, premises, ledger);
    expect(result.status).toBe("stopped"); expect(result.failure).not.toBeNull();
    expect(verify).not.toHaveBeenCalled();
    expect(result.resource_usage.work_units).toBeLessThanOrEqual(budget.work_units);
    expect(result.resource_usage.memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
    expect(result.costs.artifact_decode).toEqual({ work_units: 500, memory_bytes: 1_000 });
    expect(Object.values(result.costs).reduce((sum, cost) => sum + cost.work_units, 0)).toBe(result.resource_usage.work_units);
  });
});
