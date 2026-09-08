import { describe, expect, it } from "vitest";

import {
  createRecallFiniteFieldChannelCapture,
  verifyRecallFiniteFieldChannelCapture
} from "../../../recall/field/finite-field-capture.js";

const SOURCE = `sha256:${"a".repeat(64)}` as const;

describe("production finite-field capture", () => {
  it("binds the producer snapshot without closing an unobserved channel", () => {
    const capture = createRecallFiniteFieldChannelCapture({
      source_snapshot_digest: SOURCE,
      channel: {
        channel_id: "object_embedding_workspace",
        status: "truncated",
        depth: 0,
        unseen_upper_bound: 1,
        observations: []
      }
    });

    expect(() => verifyRecallFiniteFieldChannelCapture(capture)).not.toThrow();
    expect(() => verifyRecallFiniteFieldChannelCapture({
      ...capture,
      source_snapshot_digest: `sha256:${"b".repeat(64)}`
    })).toThrow(/digest/u);
    expect(capture.channel).toMatchObject({ status: "truncated", unseen_upper_bound: 1 });
  });
});
