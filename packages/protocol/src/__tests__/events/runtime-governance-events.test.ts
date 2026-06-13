import { describe, expect, it } from "vitest";
import { PathGraphSnapshotCreatedPayloadSchema } from "../../events/runtime-governance.js";

const validTimestamp = "2026-04-17T08:00:00.000Z";

describe("PathGraphSnapshotCreatedPayload legacy compatibility", () => {
  // invariant: total_retired_paths is deprecated but rows persisted
  // before its retirement still carry it; the strict payload schema
  // MUST tolerate the optional field so EventLog replay does not throw.
  it("parses a legacy payload carrying total_retired_paths: 0", () => {
    const legacyPayload = {
      snapshot_id: "snap-legacy-1",
      workspace_id: "workspace-1",
      total_active_paths: 12,
      total_retired_paths: 0,
      snapshot_at: validTimestamp
    };
    const parsed = PathGraphSnapshotCreatedPayloadSchema.parse(legacyPayload);
    expect(parsed).toEqual(legacyPayload);
  });

  it("parses a fresh payload omitting total_retired_paths", () => {
    const freshPayload = {
      snapshot_id: "snap-fresh-1",
      workspace_id: "workspace-1",
      total_active_paths: 7,
      snapshot_at: validTimestamp
    };
    const parsed = PathGraphSnapshotCreatedPayloadSchema.parse(freshPayload);
    expect(parsed).toEqual(freshPayload);
    expect("total_retired_paths" in parsed).toBe(false);
  });
});
