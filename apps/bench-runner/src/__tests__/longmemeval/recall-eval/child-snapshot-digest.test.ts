import { describe, expect, it } from "vitest";
import { resolveWorkspaceSliceSnapshotDigest } from
  "../../../runs/lifecycle/recall-eval/recall-eval-process/child-snapshot-digest.js";
import { WORKSPACE_A, WORKSPACE_B } from "./workspace-slice-fixture.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

describe("pager child snapshot digest lookup", () => {
  it("does not inject a digest when slices are skipped or null", () => {
    expect(resolveWorkspaceSliceSnapshotDigest(null, WORKSPACE_A)).toBeUndefined();
    expect(resolveWorkspaceSliceSnapshotDigest({
      sliceSnapshotDigests: Object.freeze({})
    }, WORKSPACE_A)).toBeUndefined();
  });

  it("cannot cross-bind another workspace's sealed digest", () => {
    const slices = Object.freeze({
      sliceSnapshotDigests: Object.freeze({
        [WORKSPACE_A]: DIGEST_A,
        [WORKSPACE_B]: DIGEST_B
      })
    });
    expect(resolveWorkspaceSliceSnapshotDigest(slices, WORKSPACE_A)).toBe(DIGEST_A);
    expect(resolveWorkspaceSliceSnapshotDigest(slices, WORKSPACE_B)).toBe(DIGEST_B);
    expect(resolveWorkspaceSliceSnapshotDigest(slices, "workspace-missing")).toBeUndefined();
    expect(resolveWorkspaceSliceSnapshotDigest({
      sliceSnapshotDigests: Object.freeze({ [WORKSPACE_B]: DIGEST_B })
    }, WORKSPACE_A)).toBeUndefined();
  });
});
