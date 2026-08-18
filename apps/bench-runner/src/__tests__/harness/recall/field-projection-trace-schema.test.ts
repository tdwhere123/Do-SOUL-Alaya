import { describe, expect, it } from "vitest";

import { FieldProjectionTraceSchema } from
  "../../../harness/recall/field/field-projection-diagnostics-schema.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const CANDIDATE = "hidden-evidence";

describe("field projection trace schema", () => {
  it("strips only a legacy extra stop object from historical traces", () => {
    const parsed = FieldProjectionTraceSchema.parse(traceWith({
      stop: { legacy: true }
    }));

    expect(Object.hasOwn(parsed, "stop")).toBe(false);
    expect(parsed.candidate_keys).toEqual([CANDIDATE]);
    expect(parsed.activation.opened_candidate_keys).toEqual([CANDIDATE]);
  });

  it("still rejects an unknown sibling key after stripping stop", () => {
    expect(() => FieldProjectionTraceSchema.parse(traceWith({
      stop: { legacy: true },
      unknown_extra: true
    }))).toThrow(/unrecognized/i);
  });
});

function traceWith(extra: Readonly<Record<string, unknown>>) {
  return {
    generation_id: DIGEST,
    condition_digest: DIGEST,
    candidate_keys: [CANDIDATE],
    candidate_activation: {},
    candidate_receipts: {},
    activation: {
      workspace_id: "workspace-1",
      generation_id: DIGEST,
      condition_digest: DIGEST,
      seed_ids: [],
      opened_candidate_keys: [CANDIDATE],
      stop_disposition: "certified",
      frontier: "closed"
    },
    ...extra
  };
}
