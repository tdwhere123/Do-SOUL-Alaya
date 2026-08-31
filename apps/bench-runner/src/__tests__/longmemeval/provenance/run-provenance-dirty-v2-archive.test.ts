import { describe, expect, it } from "vitest";
import {
  assertRecordedRunCodeIdentity,
  isLongMemEvalRunProvenanceGateEligible,
  LongMemEvalRunProvenanceSchema
} from "../../../runs/provenance/run.js";
import {
  createRunProvenanceFixture,
  registerRunProvenanceRootCleanup
} from "./run-provenance-fixture.js";

const roots = registerRunProvenanceRootCleanup();

describe("archive-era dirty v2 run provenance", () => {
  it("parses a dirty v2 sidecar and rejects it as a new write and gate", async () => {
    const fixture = await createRunProvenanceFixture(roots);
    const archiveV2 = LongMemEvalRunProvenanceSchema.parse({
      ...fixture.provenance,
      code: {
        ...fixture.provenance.code,
        worktree_clean: false,
        worktree_state_algorithm: "sha256-worktree-state-v2"
      }
    });
    expect(archiveV2.code.worktree_state_algorithm).toBe("sha256-worktree-state-v2");
    expect(archiveV2.code.worktree_clean).toBe(false);
    expect(isLongMemEvalRunProvenanceGateEligible(archiveV2)).toBe(false);
    expect(() => assertRecordedRunCodeIdentity(archiveV2.code)).toThrow(/algorithm/u);
  });
});
