import { describe, expect, it } from "vitest";
import {
  RECALL_PROTOCOL_VERSION_INCOMPATIBLE_MESSAGE,
  RECALL_SOURCE_EVIDENCE_INCOMPATIBLE_MESSAGE,
  assertRecallConsumerCompatibility,
  consumerSupportsSourceEvidence
} from "../../../recall/runtime/recall-consumer-compatibility.js";

describe("recall consumer compatibility", () => {
  it("defaults omitted protocol_version to 1 and omitted capability flags to mixed v1 support", () => {
    expect(consumerSupportsSourceEvidence({})).toBe(true);
    expect(() => assertRecallConsumerCompatibility({})).not.toThrow();
    expect(() => assertRecallConsumerCompatibility({ result_kind_view: "mixed" })).not.toThrow();
    expect(() => assertRecallConsumerCompatibility({ result_kind_view: "source_only" })).not.toThrow();
    expect(() => assertRecallConsumerCompatibility({ result_kind_view: "memory_only" })).not.toThrow();
  });

  it("keeps explicit protocol_version, supports_source_evidence=false, and supported_result_kinds checks strict", () => {
    expect(() => assertRecallConsumerCompatibility({ protocol_version: 2 })).toThrow(
      RECALL_PROTOCOL_VERSION_INCOMPATIBLE_MESSAGE
    );
    expect(() => assertRecallConsumerCompatibility({ protocol_version: 2, result_kind_view: "memory_only" })).toThrow(
      RECALL_PROTOCOL_VERSION_INCOMPATIBLE_MESSAGE
    );
    expect(() => assertRecallConsumerCompatibility({ supports_source_evidence: false })).toThrow(
      RECALL_SOURCE_EVIDENCE_INCOMPATIBLE_MESSAGE
    );
    expect(() => assertRecallConsumerCompatibility({ supported_result_kinds: ["memory_entry"] })).toThrow(
      RECALL_SOURCE_EVIDENCE_INCOMPATIBLE_MESSAGE
    );
    expect(() => assertRecallConsumerCompatibility({
      supports_source_evidence: false,
      result_kind_view: "memory_only"
    })).not.toThrow();
    expect(() => assertRecallConsumerCompatibility({
      supports_source_evidence: true,
      supported_result_kinds: ["memory_entry"]
    })).not.toThrow();
  });
});
