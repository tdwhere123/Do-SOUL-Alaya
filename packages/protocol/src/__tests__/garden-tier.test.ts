import { describe, expect, it } from "vitest";
import {
  GARDEN_ROLE_PERMISSIONS,
  GardenRole,
  GardenTaskKind,
  GardenTier
} from "../soul/garden-tier.js";

describe("Garden tier classification", () => {
  it("classifies path_plasticity_update as a Librarian TIER_2 task", () => {
    expect(GARDEN_ROLE_PERMISSIONS[GardenRole.AUDITOR]).toMatchObject({
      role: GardenRole.AUDITOR,
      tier: GardenTier.TIER_1
    });
    expect(GARDEN_ROLE_PERMISSIONS[GardenRole.AUDITOR].allowed_task_kinds).not.toContain(
      GardenTaskKind.PATH_PLASTICITY_UPDATE
    );

    expect(GARDEN_ROLE_PERMISSIONS[GardenRole.LIBRARIAN]).toMatchObject({
      role: GardenRole.LIBRARIAN,
      tier: GardenTier.TIER_2
    });
    expect(GARDEN_ROLE_PERMISSIONS[GardenRole.LIBRARIAN].allowed_task_kinds).toContain(
      GardenTaskKind.PATH_PLASTICITY_UPDATE
    );
  });
});
