import { describe, expect, expectTypeOf, it } from "vitest";
import { PromptAssetSchema, type PromptAsset } from "../../runtime/prompt-asset.js";

function createAsset(overrides: Record<string, unknown> = {}) {
  return {
    asset_id: "asset-1",
    kind: "constitutional",
    label: "Asset Label",
    content: "Asset content",
    priority: 100,
    immutable: true,
    ...overrides
  };
}

describe("PromptAssetSchema", () => {
  it("parses a constitutional asset when immutable is true", () => {
    const asset = createAsset();
    const parsed = PromptAssetSchema.parse(asset);

    expect(parsed).toEqual(asset);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects constitutional assets when immutable is false", () => {
    const result = PromptAssetSchema.safeParse(
      createAsset({
        immutable: false
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "immutable")).toBe(true);
  });

  it("parses operational assets for both mutable and immutable modes", () => {
    const mutable = createAsset({
      asset_id: "operational-1",
      kind: "operational",
      immutable: false,
      priority: 50
    });
    const stable = createAsset({
      asset_id: "operational-2",
      kind: "operational",
      immutable: true,
      priority: 0
    });

    expect(PromptAssetSchema.parse(mutable)).toEqual(mutable);
    expect(PromptAssetSchema.parse(stable)).toEqual(stable);
  });

  it("enforces the documented priority bounds", () => {
    expect(PromptAssetSchema.parse(createAsset({ priority: 0 })).priority).toBe(0);
    expect(PromptAssetSchema.parse(createAsset({ priority: 100 })).priority).toBe(100);

    expect(PromptAssetSchema.safeParse(createAsset({ priority: -1 })).success).toBe(false);
    expect(PromptAssetSchema.safeParse(createAsset({ priority: 101 })).success).toBe(false);
  });

  it("encodes constitutional immutability in the exported type", () => {
    type ConstitutionalPromptAsset = Extract<PromptAsset, { kind: "constitutional" }>;
    type OperationalPromptAsset = Extract<PromptAsset, { kind: "operational" }>;

    expectTypeOf<ConstitutionalPromptAsset["immutable"]>().toEqualTypeOf<true>();
    expectTypeOf<OperationalPromptAsset["immutable"]>().toEqualTypeOf<boolean>();
  });
});
