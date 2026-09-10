import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  InformationIndexSchema,
  type IndexEntry
} from "@do-soul/alaya-protocol";
import { BoundedIndexPayload } from "../../../../recall/runtime/index-payload.js";
import { encodeRecallResult } from "../../../../recall/recall-service.js";
import { SNAPSHOT_ID } from "../reference/deployment.fixture.js";

describe("memory payload hydrate revision pin", () => {
  it("rejects reader content when IndexEntry revision and source row revision differ", () => {
    const calls: string[] = [];
    const payload = new BoundedIndexPayload({
      readers: {
        source: ({ objectId }) => {
          calls.push(objectId);
          return {
            row: {
              object_id: objectId,
              sourceRevision: "rev2",
              content: "current body at rev2",
              lifecycle_state: "active"
            },
            rowsRead: 1,
            bytesRead: 20,
            unavailable: false
          };
        }
      },
      workspaceId: "workspace",
      remainingMemoryBytes: 10_000,
      manifestationFor: () => "excerpt"
    });
    const result = payload.finalize([memoryEntry("rev1")], 20);
    expect(calls).toEqual(["memory"]);
    expect(result.complete).toBe(false);
    expect(result.retryable).toBe(false);
    expect([...payload.previews.values()]).not.toContain("current body at rev2");
    expect(payload.previews.size).toBe(0);
  });

  it("does not deliver retained facts from a different memory revision", () => {
    const payload = new BoundedIndexPayload({
      sourceFacts: new Map([["memory", {
          object_id: "memory",
          source_revision: "rev2",
          content: "stale facts body"
        }]]),
      readers: {
        source: ({ objectId }) => ({
          row: {
            object_id: objectId,
            sourceRevision: "rev2",
            content: "reader body at rev2",
            lifecycle_state: "active"
          },
          rowsRead: 1,
          bytesRead: 20,
          unavailable: false
        })
      },
      workspaceId: "workspace",
      remainingMemoryBytes: 10_000,
      manifestationFor: () => "excerpt"
    });
    const result = payload.finalize([memoryEntry("rev1")], 20);
    expect(result.complete).toBe(false);
    expect([...payload.previews.values()]).not.toContain("stale facts body");
    expect([...payload.previews.values()]).not.toContain("reader body at rev2");
  });

  it("delivers content when the reader revision matches the IndexEntry", () => {
    const payload = new BoundedIndexPayload({
      readers: {
        source: ({ objectId }) => ({
          row: {
            object_id: objectId,
            sourceRevision: "rev1",
            content: "pinned body at rev1",
            lifecycle_state: "active"
          },
          rowsRead: 1,
          bytesRead: 20,
          unavailable: false
        })
      },
      workspaceId: "workspace",
      remainingMemoryBytes: 10_000,
      manifestationFor: () => "excerpt"
    });
    const result = payload.finalize([memoryEntry("rev1")], 20);
    expect(result.complete).toBe(true);
    expect([...payload.previews.values()]).toContain("pinned body at rev1");
  });

  it("does not encode an object-id preview onto a different memory revision", () => {
    const entry = memoryEntry("rev1");
    const encoded = encodeRecallResult(
      memoryIndex([entry]),
      new Map([["memory", "body at some other revision"]])
    );
    expect(encoded.candidates[0]?.content_preview).toBe("[payload omitted]");
    expect(encoded.candidates[0]?.content_preview).not.toBe("body at some other revision");
  });
});

function memoryIndex(entries: readonly IndexEntry[]) {
  return InformationIndexSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "payload-revision",
    snapshot_id: SNAPSHOT_ID,
    result_version: "v1",
    entries,
    completeness: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      logical_index: "complete",
      observed_coverage: "complete",
      transport: "complete",
      payload: "complete",
      representation: "complete"
    },
    continuation: null,
    representation: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      policy: "construct_index_then_page_then_payload",
      page_budget: 30,
      identity_tie_break: "serialization"
    }
  });
}

function memoryEntry(sourceRevision: string): IndexEntry {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target: {
      kind: "memory_entry",
      workspace_id: "workspace",
      object_id: "memory",
      source_revision: sourceRevision
    },
    object_id: "memory",
    hypothesis_id: "h0",
    output_binding: "default",
    role: "requested",
    association_milligrades: 1000,
    claim: "unknown",
    explanation_ids: []
  };
}
