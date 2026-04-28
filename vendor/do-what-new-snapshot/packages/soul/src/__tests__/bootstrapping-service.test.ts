import { describe, expect, it, vi } from "vitest";
import type { BootstrappingPathTemplate } from "@do-what/protocol";
import { buildBootstrappingPathId, buildBootstrappingRecordId } from "../shared/bootstrapping-ids.js";
import { BootstrappingService } from "../garden/bootstrapping-service.js";

describe("BootstrappingService", () => {
  it("plans conservative learned paths for a new workspace without writes", async () => {
    const service = new BootstrappingService({
      templates: [createTemplate()],
      now: () => "2026-04-20T00:00:00.000Z"
    });

    await expect(service.planBootstrap("workspace-1")).resolves.toEqual({
      relations: [
        expect.objectContaining({
          path_id: buildBootstrappingPathId(
            "workspace-1",
            "workspace.bootstrap.conservative-start"
          ),
          workspace_id: "workspace-1",
          anchors: {
            source_anchor: {
              kind: "object",
              object_id: "workspace-1"
            },
            target_anchor: {
              kind: "object_facet",
              object_id: "workspace-1",
              facet_key: "conservative_start"
            }
          },
          constitution: {
            relation_kind: "supports",
            why_this_relation_exists: ["new workspace starts with conservative learned-path defaults"]
          },
          plasticity_state: expect.objectContaining({
            strength: 0.1,
            stability_class: "volatile"
          }),
          legitimacy: {
            evidence_basis: ["bootstrapping:workspace.bootstrap.conservative-start"],
            governance_class: "hint_only"
          },
          effect_vector: expect.objectContaining({
            default_manifestation_preference: "stance_bias"
          })
        })
      ],
      record: {
        record_id: buildBootstrappingRecordId("workspace-1"),
        workspace_id: "workspace-1",
        paths_planted: 1,
        template_ids_used: ["workspace.bootstrap.conservative-start"],
        planted_at: "2026-04-20T00:00:00.000Z"
      }
    });
  });

  it("uses full ISO timestamps for the default clock and shared bootstrap ids", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T12:34:56.789Z"));

    try {
      const service = new BootstrappingService({
        templates: [createTemplate()]
      });

      await expect(service.planBootstrap("workspace-1")).resolves.toEqual({
        relations: [
          expect.objectContaining({
            path_id: buildBootstrappingPathId(
              "workspace-1",
              "workspace.bootstrap.conservative-start"
            ),
            created_at: "2026-04-20T12:34:56.789Z",
            updated_at: "2026-04-20T12:34:56.789Z"
          })
        ],
        record: expect.objectContaining({
          record_id: buildBootstrappingRecordId("workspace-1"),
          planted_at: "2026-04-20T12:34:56.789Z"
        })
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function createTemplate(
  overrides: Partial<BootstrappingPathTemplate> = {}
): BootstrappingPathTemplate {
  return {
    template_id: "workspace.bootstrap.conservative-start",
    relation_kind: "supports",
    why_this_relation_exists: ["new workspace starts with conservative learned-path defaults"],
    source_anchor_template: {
      kind: "object",
      description: "workspace"
    },
    target_anchor_template: {
      kind: "object_facet",
      description: "conservative_start"
    },
    default_strength: 0.1,
    default_stability_class: "volatile",
    default_governance_class: "hint_only",
    default_manifestation_preference: "stance_bias",
    ...overrides
  };
}
