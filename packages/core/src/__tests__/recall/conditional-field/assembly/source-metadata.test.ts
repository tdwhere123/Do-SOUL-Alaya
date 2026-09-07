import { describe, expect, it } from "vitest";
import {
  captureIndexSourceMetadata,
  runConditionalFieldRecall,
  toSourceObserverRow
} from "../../../../recall/recall-service.js";
import { defaultBudget, SNAPSHOT_ID, INTERPRETATION_CLOCK } from "../reference/deployment.fixture.js";
import { BoundedIndexPayload } from "../../../../recall/runtime/index-payload.js";

function recall(metadata: boolean, memoryBytes = 1_000_000) {
  const row = toSourceObserverRow({
    object_id: "memory", sourceRevision: "rev", content: "needle source content",
    lifecycle_state: "active", scope_class: "project", dimension: "fact",
    ...(metadata ? {
      evidence_refs: ["capsule"],
      staged_warnings: [{ kind: "evidence_missing" as const, severity: "warning" as const,
        policy: "fixture", summary: "Source needs review", resolution_options: ["request_evidence" as const] }]
    } : {})
  });
  return runConditionalFieldRecall({
    workspace_id: "workspace", query_text: "needle", budget: defaultBudget({ memory_bytes: memoryBytes }),
    snapshot_id: SNAPSHOT_ID, interpretation_clock: INTERPRETATION_CLOCK,
    as_of: INTERPRETATION_CLOCK, expires_at: "2026-12-01T00:00:00.000Z",
    readers: {
      lexical: () => ({ ids: ["memory"], nativeVisits: 1, nativeBytes: 6,
        rowsRead: 1, bytesRead: 6, truncated: false }),
      source: () => ({ row, rowsRead: 1, bytesRead: Buffer.byteLength(JSON.stringify(row)), unavailable: false })
    }
  });
}

describe("bounded source metadata retention", () => {
  it("preserves source references and supplied warnings without changing association or minting witnesses", () => {
    const bare = recall(false);
    const enriched = recall(true);
    expect(enriched.entries).toHaveLength(1);
    expect(enriched.entries.map((entry) => [entry.object_id, entry.association_milligrades]))
      .toEqual(bare.entries.map((entry) => [entry.object_id, entry.association_milligrades]));
    expect(captureIndexSourceMetadata(enriched)).toMatchObject({ memory: {
      evidence_refs: ["capsule"], staged_warnings: [{ kind: "evidence_missing" }]
    } });
    expect(enriched.entries[0]?.explanation_ids).toEqual(bare.entries[0]?.explanation_ids);
    expect(JSON.stringify(enriched)).not.toContain("capsule");
  });

  it("does not retain source metadata outside the memory allowance", () => {
    const index = recall(true, 100);
    expect(captureIndexSourceMetadata(index)).toEqual({});
    expect(index.completeness.logical_index).not.toBe("complete");
  });

  it("replaces a cached body with an object hint without exposing source references", () => {
    const payload = new BoundedIndexPayload({
      sourceFacts: { memory: { object_id: "memory", content: "protected body", evidence_refs: ["private-ref"] } },
      previewCache: { memory: "protected body" }, readers: {}, workspaceId: "workspace",
      remainingMemoryBytes: 1000, manifestationFor: () => "hint"
    });
    expect(payload.finalize(recall(false).entries, 5).complete).toBe(true);
    expect(payload.previews.get("memory")).toBe("[memory ref: memory]");
    expect(payload.sourceMetadata).toEqual({});
  });
});
