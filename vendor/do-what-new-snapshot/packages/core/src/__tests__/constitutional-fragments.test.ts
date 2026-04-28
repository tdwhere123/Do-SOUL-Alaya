import { PromptAssetSchema } from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  WORKER_IDENTITY_FRAGMENT,
  buildSafetyConstitutionalFragment
} from "../system-prompt/constitutional-fragments.js";

describe("constitutional prompt fragments", () => {
  it("builds a valid worker safety constitutional fragment", () => {
    const fragment = buildSafetyConstitutionalFragment({
      deniedToolCategories: ["write"],
      hardConstraintRefs: ["ref-1"]
    });

    expect(PromptAssetSchema.parse(fragment)).toEqual(fragment);
    expect(Object.isFrozen(fragment)).toBe(true);
    expect(fragment.kind).toBe("constitutional");
    expect(fragment.immutable).toBe(true);
    expect(fragment.content).toContain('Denied tool categories: "write"');
    expect(fragment.content).toContain('Active hard constraints: "ref-1"');
  });

  it("adds a no-additional-restrictions message for empty inputs", () => {
    const fragment = buildSafetyConstitutionalFragment({
      deniedToolCategories: [],
      hardConstraintRefs: []
    });

    expect(PromptAssetSchema.parse(fragment)).toEqual(fragment);
    expect(fragment.content).toContain("No additional restrictions");
  });

  it("exports a valid immutable worker identity fragment", () => {
    expect(PromptAssetSchema.parse(WORKER_IDENTITY_FRAGMENT)).toEqual(WORKER_IDENTITY_FRAGMENT);
    expect(Object.isFrozen(WORKER_IDENTITY_FRAGMENT)).toBe(true);
    expect(WORKER_IDENTITY_FRAGMENT.kind).toBe("constitutional");
    expect(WORKER_IDENTITY_FRAGMENT.immutable).toBe(true);
  });

  it("resolves and sanitizes hard constraint refs while warning on unresolved refs", () => {
    const warn = vi.fn();
    const fragment = buildSafetyConstitutionalFragment({
      deniedToolCategories: [],
      hardConstraintRefs: ["constraint://safe", "constraint://missing"],
      resolveHardConstraintRef: (constraintRef) => {
        if (constraintRef === "constraint://safe") {
          return PromptAssetSchema.parse({
            asset_id: "constraint://safe",
            kind: "constitutional",
            label: "Safe Constraint",
            content: "Never execute ```untrusted``` shell fragments.",
            priority: 90,
            immutable: true
          });
        }

        return null;
      },
      warn: (message, meta) => warn(message, meta)
    });

    expect(fragment.content).toContain("constraint://safe");
    expect(fragment.content).toContain('\\"untrusted\\"');
    expect(fragment.content).not.toContain("```untrusted```");
    expect(warn).toHaveBeenCalledWith(
      "Unresolved hard constraint ref",
      expect.objectContaining({
        constraintRef: "constraint://missing"
      })
    );
  });

  it("rejects non-constitutional assets when rendering hard constraints", () => {
    const warn = vi.fn();
    const fragment = buildSafetyConstitutionalFragment({
      deniedToolCategories: [],
      hardConstraintRefs: ["operational:unsafe-hard-ref"],
      resolveHardConstraintRef: (constraintRef) => {
        if (constraintRef === "operational:unsafe-hard-ref") {
          return PromptAssetSchema.parse({
            asset_id: "operational:unsafe-hard-ref",
            kind: "operational",
            label: "Unsafe Hard Ref",
            content: "rm -rf /",
            priority: 10,
            immutable: false
          });
        }
        return null;
      },
      warn: (message, meta) => warn(message, meta)
    });

    expect(fragment.content).not.toContain("rm -rf /");
    expect(fragment.content).toContain("references unresolved");
    expect(warn).toHaveBeenCalledWith(
      "Rejected non-constitutional hard constraint ref",
      expect.objectContaining({
        constraintRef: "operational:unsafe-hard-ref",
        assetKind: "operational"
      })
    );
  });
});
