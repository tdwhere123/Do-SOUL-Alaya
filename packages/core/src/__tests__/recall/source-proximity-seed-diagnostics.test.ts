import { describe, expect, it, vi } from "vitest";
import {
  selectSourceProximitySeedDrafts,
  type CoarseCandidateDraft
} from "../../recall/coarse-filter/coarse-candidates.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("selectSourceProximitySeedDrafts", () => {
  it("warns when source proximity seed floors boost low-strength drafts", () => {
    const warn = vi.fn();
    const draft = createDraft("memory-session", ["session_surface_cohort"]);

    const seeds = selectSourceProximitySeedDrafts(
      new Map([[draft.entry.object_id, draft]]),
      warn
    );

    expect(seeds).toEqual([
      {
        draft,
        strength: 0.75
      }
    ]);
    expect(warn).toHaveBeenCalledWith(
      "source proximity seed floor applied",
      expect.objectContaining({
        selected_seed_count: 1,
        session_surface_cohort_count: 1
      })
    );
  });
});

function createDraft(
  objectId: string,
  admissionPlanes: CoarseCandidateDraft["admissionPlanes"]
): CoarseCandidateDraft {
  return {
    entry: createMemoryEntry({ object_id: objectId }),
    admissionPlanes,
    firstAdmissionPlane: admissionPlanes[0] ?? "lexical",
    sourceChannels: ["source_proximity_test"],
    structuralScore: 0,
    pathExpansionSources: Object.freeze([])
  };
}
