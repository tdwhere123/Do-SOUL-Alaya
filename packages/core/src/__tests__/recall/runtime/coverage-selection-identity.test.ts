import { describe, expect, it } from "vitest";
import { resolveCoverageIdentity } from "../../../recall/delivery/coverage-selection.js";

describe("coverage logical identity", () => {
  it("does not project memory gist or cohort onto same-id synthesis and global candidates", () => {
    const supplementary = {
      evidenceGistsByMemoryId: { shared: "memory gist" },
      sourceCohortKeys: { shared: "memory cohort" }
    };
    const local = candidate("workspace_local:memory_entry:shared");
    const synthesis = candidate(
      "workspace_local:synthesis_capsule:shared",
      "workspace_local",
      "synthesis_capsule"
    );
    const global = candidate("global:memory_entry:shared", "global", "memory_entry");

    expect(resolveCoverageIdentity(local, supplementary)).toEqual({
      objectKey: "memory_entry:shared",
      gistKey: "gist:memory gist",
      cohortKey: "memory cohort"
    });
    expect(resolveCoverageIdentity(synthesis, supplementary)).toEqual({
      objectKey: "synthesis_capsule:shared",
      gistKey: "object:workspace_local:synthesis_capsule:shared",
      cohortKey: null
    });
    expect(resolveCoverageIdentity(global, supplementary)).toEqual({
      objectKey: "memory_entry:shared",
      gistKey: "object:global:memory_entry:shared",
      cohortKey: null
    });
  });
});

function candidate(
  candidateKey: string,
  originPlane: "workspace_local" | "global" = "workspace_local",
  objectKind: "memory_entry" | "synthesis_capsule" = "memory_entry"
) {
  return {
    entry: { object_id: "shared", evidence_refs: [] },
    originPlane,
    objectKind,
    fusion: { candidate_key: candidateKey, fused_score: 1 }
  } as const;
}
