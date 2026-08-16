import { describe, expect, it } from "vitest";
import {
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  hashAddressableSourceSpanId,
  hashContentDigest,
  hashSourceRecordId,
  type SourceAdmissionRequest
} from "@do-soul/alaya-protocol";
import { fieldSha256 } from "../../memory/evidence-create/field-hash.js";
import { createInMemoryFieldStores } from "../../memory/evidence-create/field-stores.js";
import { createSourceAdmissionPort } from "../../memory/evidence-create/source-admission.js";

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
