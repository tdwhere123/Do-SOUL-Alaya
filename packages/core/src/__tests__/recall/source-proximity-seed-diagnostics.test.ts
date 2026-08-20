import { describe, expect, it, vi } from "vitest";
import {
  DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP,
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

  it("does not let direct evidence consume the bounded memory seed slots", () => {
    const memoryDraft = createDraft("memory-seed", ["session_surface_cohort"]);
    const directEvidenceDrafts = Array.from({ length: 12 }, (_, index) => ({
      ...createDraft(`evidence-${index}`, ["evidence_anchor"]),
      objectKind: "evidence_capsule" as const
    }));
    const drafts = new Map(
      [...directEvidenceDrafts, memoryDraft].map((draft) => [draft.entry.object_id, draft])
    );

    const seeds = selectSourceProximitySeedDrafts(drafts);

    expect(seeds).toEqual([
      {
        draft: memoryDraft,
        strength: 0.75
      }
    ]);
  });
  it("orders equal-strength seeds by semantic identity, not replay timestamps", () => {
    const alpha = {
      ...createDraft("memory-z", ["session_surface_cohort"]),
      entry: createMemoryEntry({
        object_id: "memory-z",
        content: "alpha",
        created_at: "2026-03-20T00:00:02.000Z"
      })
    };
    const beta = {
      ...createDraft("memory-a", ["session_surface_cohort"]),
      entry: createMemoryEntry({
        object_id: "memory-a",
        content: "beta",
        created_at: "2026-03-20T00:00:01.000Z"
      })
    };

    const seeds = selectSourceProximitySeedDrafts(
      new Map([
        [alpha.entry.object_id, alpha],
        [beta.entry.object_id, beta]
      ])
    );

    expect(seeds.map(({ draft }) => draft.entry.object_id)).toEqual([
      "memory-z",
      "memory-a"
    ]);
  });

  it("keeps the bounded seed cutoff stable across activation jitter", () => {
    const dominant = Array.from(
      { length: DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP - 1 },
      (_, index) => {
        const draft = createDraft(`dominant-${index}`, ["evidence_anchor"]);
        return {
          ...draft,
          entry: createMemoryEntry({
            object_id: draft.entry.object_id,
            content: `dominant-${index}`,
            activation_score: 1
          })
        };
      }
    );
    const alpha = {
      ...createDraft("memory-z", ["evidence_anchor"]),
      entry: createMemoryEntry({
        object_id: "memory-z",
        content: "alpha",
        activation_score: 0.9324999723600726
      })
    };
    const beta = {
      ...createDraft("memory-a", ["evidence_anchor"]),
      entry: createMemoryEntry({
        object_id: "memory-a",
        content: "beta",
        activation_score: 0.9324999994735418
      })
    };
    const selectIds = (drafts: readonly CoarseCandidateDraft[]) =>
      selectSourceProximitySeedDrafts(
        new Map(drafts.map((draft) => [draft.entry.object_id, draft]))
      ).map(({ draft }) => draft.entry.object_id);

    const selected = selectIds([...dominant, alpha, beta]);
    expect(selected).toContain("memory-z");
    expect(selected).not.toContain("memory-a");
    expect(selectIds([...dominant, beta, alpha])).toEqual(selected);
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
