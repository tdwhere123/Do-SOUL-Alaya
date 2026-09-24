import { describe, expect, it } from "vitest";
import {
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  hashAddressableSourceSpanId,
  hashContentDigest,
  hashSourceRecordId,
  UTTERANCE_ATTRIBUTION_CONTRACT,
  type SourceAdmissionRequest
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 as fieldSha256 } from "../../shared/field-hash.js";
import { createInMemoryFieldStores } from "../../memory/evidence-create/field-stores.js";
import {
  createSourceAdmissionPort,
  retainedSourceScopeClass,
  retainedSourceSpeaker
} from "../../memory/evidence-create/source-admission.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const BODY = "Alpha line.\nBeta line shares Alpha.";

describe("source admission", () => {
  it("admits overlapping spans with distinct ids and replays the same tuple", () => {
    const admission = createPort();
    const first = admission.admit(request({
      spans: [
        { start_offset: 0, end_offset: 11, purpose: "sentence" },
        { start_offset: 6, end_offset: 21, purpose: "sentence" }
      ]
    }));
    const replay = admission.admit(request({
      spans: [
        { start_offset: 6, end_offset: 21, purpose: "sentence" },
        { start_offset: 0, end_offset: 11, purpose: "sentence" }
      ]
    }));

    expect(first.spans).toHaveLength(2);
    expect(first.spans[0]?.identity).not.toBe(first.spans[1]?.identity);
    expect(replay.record.identity).toBe(first.record.identity);
    expect(replay.spans.map((span) => span.identity).sort()).toEqual(
      first.spans.map((span) => span.identity).sort()
    );
    expect(first.record.identity).toBe(hashSourceRecordId({
      source_id: "src-1",
      source_version: "v1",
      content_digest: hashContentDigest(BODY, fieldSha256)
    }, fieldSha256));
    expect(first.spans[0]?.identity).toBe(hashAddressableSourceSpanId({
      record_id: first.record.identity,
      start_offset: 0,
      end_offset: 11,
      purpose: "sentence",
      producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID
    }, fieldSha256));
  });

  it("is idempotent for same-lineage replay and concurrent duplicates", async () => {
    const admission = createPort();
    const input = request();
    const [left, right] = await Promise.all([
      Promise.resolve(admission.admit(input)),
      Promise.resolve(admission.admit(input))
    ]);

    expect(left.record.identity).toBe(right.record.identity);
    expect(left.spans.map((span) => span.identity)).toEqual(
      right.spans.map((span) => span.identity)
    );
  });

  it("reinforces independent sources of the same bytes", () => {
    const admission = createPort();
    const first = admission.admit(request({ source_id: "src-a" }));
    const second = admission.admit(request({ source_id: "src-b" }));

    expect(first.record.content_digest).toBe(second.record.content_digest);
    expect(first.record.identity).not.toBe(second.record.identity);
  });

  it("rejects changed attribution on an existing in-memory source identity", () => {
    const stores = createInMemoryFieldStores();
    const admission = createSourceAdmissionPort({ sha256: fieldSha256, stores });
    const first = admission.admit(request());
    const attribution = { contract: UTTERANCE_ATTRIBUTION_CONTRACT, status: "captured" as const,
      issuer_scope: "authored-harness", utterances: [{ occurrence_id: "turn-1",
        utf8_span: [0, BODY.length] as const, conversation_ref: "conversation-1", author_ref: "person-1" }] };
    expect(() => admission.admit(request({ attribution_context: attribution }))).toThrow(/replay mismatch/);
    expect(stores.getStoredRecord("workspace-1", first.record.identity)?.record).toEqual(first.record);
  });

  it("admits a record-only root with null evidence_object_id and no minted capsule", () => {
    const admitted = createPort().admit(request({ evidence_object_id: null }));
    expect(admitted.record.evidence_object_id).toBeNull();
    expect(admitted.record.identity).toBe(hashSourceRecordId({
      source_id: "src-1",
      source_version: "v1",
      content_digest: hashContentDigest(BODY, fieldSha256)
    }, fieldSha256));
  });

  it("classifies a metadata correction without a later recorded time as a conflict", () => {
    const stores = createInMemoryFieldStores();
    const admission = createSourceAdmissionPort({ sha256: fieldSha256, stores });
    const first = admission.admit(request());
    expect(() => admission.admit(request({ source_version: "v2", attribution_context: {
      contract: UTTERANCE_ATTRIBUTION_CONTRACT, status: "captured", issuer_scope: "authored-harness",
      utterances: [{ occurrence_id: "turn-1", utf8_span: [0, BODY.length],
        conversation_ref: "conversation-1", author_ref: "person-1" }]
    } }))).toThrowError(expect.objectContaining({ name: "CoreError", code: "CONFLICT" }));
    expect(stores.getCurrentRecord("workspace-1", "src-1")?.identity).toBe(first.record.identity);
  });

  it("classifies null attribution on a new source as invalid input without storing it", () => {
    const stores = createInMemoryFieldStores();
    const admission = createSourceAdmissionPort({ sha256: fieldSha256, stores });
    expect(() => admission.admit(request({ attribution_context: null }))).toThrowError(
      expect.objectContaining({ name: "CoreError", code: "VALIDATION" })
    );
    expect(stores.getCurrentRecord("workspace-1", "src-1")).toBeNull();
  });

  it("admits unknown valid time without requiring event or valid time", () => {
    const admitted = createPort().admit(request({
      event_time: null,
      valid_from: null,
      valid_to: null
    }));

    expect(admitted.record.event_time).toBeNull();
    expect(admitted.record.valid_from).toBeNull();
    expect(admitted.record.valid_to).toBeNull();
  });

  it("retains a writer-supplied scope_class and omits an unknown or missing one", () => {
    expect(retainedSourceScopeClass("project")).toBe("project");
    expect(retainedSourceScopeClass("global_domain")).toBe("global_domain");
    expect(retainedSourceScopeClass("global_core")).toBe("global_core");
    expect(retainedSourceScopeClass("secret")).toBeUndefined();
    expect(retainedSourceScopeClass(null)).toBeUndefined();
    expect(createPort().admit(request({ scope_class: "project" })).record.scope_class).toBe("project");
    expect(createPort().admit(request()).record.scope_class).toBeUndefined();
  });

  it("retains a single speaker and omits mixed or unknown roles", () => {
    expect(retainedSourceSpeaker(["user"])).toBe("user");
    expect(retainedSourceSpeaker(["assistant", "assistant"])).toBe("assistant");
    expect(retainedSourceSpeaker(["system"])).toBe("system");
    expect(retainedSourceSpeaker(["user", "assistant"])).toBeUndefined();
    expect(retainedSourceSpeaker(["tool"])).toBeUndefined();
    expect(retainedSourceSpeaker(["user", "tool"])).toBeUndefined();
    expect(retainedSourceSpeaker(["assistant", "unknown"])).toBeUndefined();
    expect(retainedSourceSpeaker([])).toBeUndefined();
    const admitted = createPort().admit(request({ speaker: "user" }));
    expect(admitted.record.speaker).toBe("user");
    expect(createPort().admit(request()).record.speaker).toBeUndefined();
  });

  it("rejects inverted or out-of-range spans fail-closed", () => {
    const admission = createPort();
    expect(() => admission.admit(request({
      spans: [{ start_offset: 4, end_offset: 4, purpose: "line" }]
    }))).toThrow(/half-open|range/u);
    expect(() => admission.admit(request({
      spans: [{ start_offset: 0, end_offset: BODY.length + 1, purpose: "line" }]
    }))).toThrow(/outside|range/u);
  });
});

function createPort() {
  return createSourceAdmissionPort({
    sha256: fieldSha256,
    stores: createInMemoryFieldStores()
  });
}

function request(
  overrides: Partial<SourceAdmissionRequest> = {}
): SourceAdmissionRequest {
  return {
    workspace_id: "workspace-1",
    source_id: "src-1",
    source_version: "v1",
    content_bytes: BODY,
    evidence_object_id: null,
    recorded_at: CLOCK,
    event_time: null,
    valid_from: null,
    valid_to: null,
    spans: [{ start_offset: 0, end_offset: BODY.length, purpose: "native_structure" }],
    ...overrides
  };
}
