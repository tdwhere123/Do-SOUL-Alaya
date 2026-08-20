import { describe, expect, it } from "vitest";

import {
  createRecallFiniteFieldChannelCapture,
  materializeRecallRetrievalFieldCaptures,
  materializeRecallRetrievalFieldSeal,
  RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1,
  verifyRecallFiniteFieldChannelCapture
} from "../../../recall/field/finite-field-capture.js";
import { verifyRecallFiniteFieldSeal } from
  "../../../recall/field/finite-field-seal.js";

const SOURCE = `sha256:${"a".repeat(64)}` as const;

describe("production finite-field capture", () => {
  it("fills the fixed catalog without treating missing producers as observed zero", () => {
    const capture = createRecallFiniteFieldChannelCapture({
      source_snapshot_digest: SOURCE,
      channel: {
        channel_id: "object_embedding_pool",
        status: "complete",
        depth: 1,
        unseen_upper_bound: 0,
        observations: [{
          observation_id: "pool:memory-a",
          candidate_key: "workspace_local:memory_entry:memory-a",
          rank: 1
        }]
      }
    });

    const seal = materializeRecallRetrievalFieldSeal([capture]);
    const captures = materializeRecallRetrievalFieldCaptures([capture]);

    expect(seal.channel_catalog).toEqual(RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1);
    expect(captures).toHaveLength(RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1.length);
    expect(captures.map(({ channel }) => channel.channel_id))
      .toEqual(RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1);
    expect(seal.channels.find(({ channel_id }) =>
      channel_id === "object_embedding_pool")?.status).toBe("complete");
    expect(seal.channels.filter(({ channel_id }) =>
      channel_id !== "object_embedding_pool").every(({ status }) =>
      status === "unavailable")).toBe(true);
    expect(captures.find(({ channel }) => channel.channel_id === "synthesis_fts")
      ?.source_snapshot_digest).not.toBe(SOURCE);
    expect(() => verifyRecallFiniteFieldSeal(seal)).not.toThrow();
  });

  it("binds the producer snapshot and rejects duplicate channel owners", () => {
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
    expect(() => materializeRecallRetrievalFieldSeal([capture, capture]))
      .toThrow(/unique/u);
  });
});
