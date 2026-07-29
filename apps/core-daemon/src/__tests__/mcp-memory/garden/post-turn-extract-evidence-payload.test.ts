import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupPostTurnExtractHarnesses,
  createHandlerHarness,
  postTurnRows,
  reportUsage,
  type PostTurnPayload
} from "./post-turn-extract-task-fixture.js";

afterEach(() => {
  cleanupPostTurnExtractHarnesses();
});

describe("post-turn extract evidence payload", () => {
  it("keeps skipped legacy memory refs but excludes evidence refs", async () => {
    const harness = await createHandlerHarness();

    const result = await reportUsage(harness.handler, {
      delivered_objects: [
        { object_id: "memory-a", usage_status: "skipped" },
        {
          object_id: "evidence-a",
          object_kind: "evidence_capsule",
          usage_status: "skipped"
        },
        {
          object_id: "memory-b",
          object_kind: "memory_entry",
          usage_status: "used"
        }
      ]
    });

    expect(result.ok).toBe(true);
    const payload = postTurnRows(harness.gardenTaskRepo)[0]!.payload as PostTurnPayload;
    expect(payload.target_object_refs).toEqual(["memory-a", "memory-b"]);
    expect(payload.turn_digest.context_manifest.delivered_object_ids).toEqual([
      "memory-a",
      "memory-b"
    ]);
  });

  it("emits no memory refs for an evidence-only payload", async () => {
    const harness = await createHandlerHarness();

    const result = await reportUsage(harness.handler, {
      usage_state: "skipped",
      delivered_objects: [
        {
          object_id: "evidence-a",
          object_kind: "evidence_capsule",
          usage_status: "skipped"
        }
      ]
    });

    expect(result.ok).toBe(true);
    const payload = postTurnRows(harness.gardenTaskRepo)[0]!.payload as PostTurnPayload;
    expect(payload.target_object_refs).toEqual([]);
    expect(payload.turn_digest.context_manifest.delivered_object_ids).toEqual([]);
  });
});
