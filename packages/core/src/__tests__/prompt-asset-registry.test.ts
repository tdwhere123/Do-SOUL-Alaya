import { PromptAssetSchema, type PromptAsset } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import { CoreError } from "../errors.js";
import { PromptAssetRegistry } from "../prompt-asset-registry.js";

function createAsset(overrides: Partial<PromptAsset> = {}): PromptAsset {
  return PromptAssetSchema.parse({
    asset_id: "constitutional:asset-1",
    kind: "constitutional",
    label: "Constitutional Asset",
    content: "Immutable constraint",
    priority: 100,
    immutable: true,
    ...overrides
  });
}

describe("PromptAssetRegistry", () => {
  it("registers constitutional and operational assets, preserving assembly order", () => {
    const registry = new PromptAssetRegistry();
    const constitutional = createAsset();
    const operationalHigh = createAsset({
      asset_id: "operational:asset-1",
      kind: "operational",
      label: "Operational High",
      content: "High priority guidance",
      priority: 50,
      immutable: false
    });
    const operationalLow = createAsset({
      asset_id: "operational:asset-2",
      kind: "operational",
      label: "Operational Low",
      content: "Low priority guidance",
      priority: 0,
      immutable: false
    });

    registry.register(operationalLow);
    registry.register(constitutional);
    registry.register(operationalHigh);

    expect(registry.assemble()).toBe(
      [
        "## Constitutional Asset",
        "Immutable constraint",
        "",
        "## Operational High",
        "High priority guidance",
        "",
        "## Operational Low",
        "Low priority guidance"
      ].join("\n")
    );
    expect(registry.getConstitutional()).toEqual([constitutional]);
    expect(Object.isFrozen(registry.getConstitutional()[0])).toBe(true);
    expect(registry.stats()).toEqual({ constitutional: 1, operational: 2 });
  });

  it("treats same-content constitutional re-registration as idempotent", () => {
    const registry = new PromptAssetRegistry();
    const asset = createAsset();

    registry.register(asset);
    expect(() =>
      registry.register(
        createAsset({
          label: "Ignored Replacement Label",
          priority: 0
        })
      )
    ).not.toThrow();

    expect(registry.assemble()).toContain("## Constitutional Asset");
    expect(registry.assemble()).not.toContain("Ignored Replacement Label");
    expect(registry.stats()).toEqual({ constitutional: 1, operational: 0 });
  });

  it("rejects attempts to modify constitutional content", () => {
    const registry = new PromptAssetRegistry();

    registry.register(createAsset());

    const error = captureError(() =>
      registry.register(
        createAsset({
          content: "Changed constraint"
        })
      )
    );

    expect(error).toBeInstanceOf(CoreError);
    expect(error?.code).toBe("CONFLICT");
    expect(() =>
      registry.register(
        createAsset({
          content: "Changed constraint"
        })
      )
    ).toThrow(/Cannot modify immutable prompt asset/);
  });

  it("updates operational assets and rejects immutable or missing assets", () => {
    const registry = new PromptAssetRegistry();
    const constitutional = createAsset();
    const operational = createAsset({
      asset_id: "operational:asset-1",
      kind: "operational",
      label: "Operational Asset",
      content: "Original guidance",
      priority: 25,
      immutable: false
    });

    registry.register(constitutional);
    registry.register(operational);
    registry.updateOperational("operational:asset-1", "Updated guidance");

    expect(registry.assemble()).toContain("Updated guidance");

    const immutableError = captureError(() =>
      registry.updateOperational("constitutional:asset-1", "nope")
    );
    const missingError = captureError(() => registry.updateOperational("missing", "nope"));

    expect(immutableError).toBeInstanceOf(CoreError);
    expect(immutableError?.code).toBe("CONFLICT");
    expect(missingError).toBeInstanceOf(CoreError);
    expect(missingError?.code).toBe("NOT_FOUND");
  });

  it("keeps immutable operational assets write-once after registration", () => {
    const registry = new PromptAssetRegistry();

    registry.register(
      createAsset({
        asset_id: "operational:stable-guidance",
        kind: "operational",
        label: "Stable Guidance",
        content: "Original operational guidance",
        priority: 25,
        immutable: true
      })
    );

    const conflictError = captureError(() =>
      registry.register(
        createAsset({
          asset_id: "operational:stable-guidance",
          kind: "operational",
          label: "Stable Guidance Updated",
          content: "Updated operational guidance",
          priority: 10,
          immutable: true
        })
      )
    );

    expect(conflictError).toBeInstanceOf(CoreError);
    expect(conflictError?.code).toBe("CONFLICT");
  });

  it("wraps invalid operational updates as CoreError VALIDATION", () => {
    const registry = new PromptAssetRegistry();

    registry.register(
      createAsset({
        asset_id: "operational:asset-2",
        kind: "operational",
        label: "Operational Asset",
        content: "Original guidance",
        priority: 25,
        immutable: false
      })
    );

    const validationError = captureError(() =>
      registry.updateOperational("operational:asset-2", "")
    );

    expect(validationError).toBeInstanceOf(CoreError);
    expect(validationError?.code).toBe("VALIDATION");
    expect(validationError?.cause).toBeInstanceOf(Error);
  });

  it("wraps invalid registrations as CoreError VALIDATION", () => {
    const registry = new PromptAssetRegistry();

    const validationError = captureError(() =>
      registry.register(
        {
          asset_id: "invalid-asset",
          kind: "constitutional",
          label: "Invalid Asset",
          content: "Broken immutable contract",
          priority: 50,
          immutable: false
        } as unknown as PromptAsset
      )
    );

    expect(validationError).toBeInstanceOf(CoreError);
    expect(validationError?.code).toBe("VALIDATION");
    expect(validationError?.cause).toBeInstanceOf(Error);
  });

  it("wraps non-object registrations as CoreError VALIDATION", () => {
    const registry = new PromptAssetRegistry();

    const validationError = captureError(() => registry.register(null as unknown as PromptAsset));

    expect(validationError).toBeInstanceOf(CoreError);
    expect(validationError?.code).toBe("VALIDATION");
    expect(validationError?.cause).toBeInstanceOf(Error);
  });

  it("bounds the number of registered assets without blocking updates to existing entries", () => {
    const registry = new PromptAssetRegistry({ maxAssets: 2 });

    registry.register(createAsset());
    registry.register(
      createAsset({
        asset_id: "operational:asset-1",
        kind: "operational",
        label: "Operational Asset",
        content: "Original guidance",
        priority: 25,
        immutable: false
      })
    );
    registry.updateOperational("operational:asset-1", "Updated guidance");

    const overflowError = captureError(() =>
      registry.register(
        createAsset({
          asset_id: "operational:asset-2",
          kind: "operational",
          label: "Overflow Asset",
          content: "Extra guidance",
          priority: 0,
          immutable: false
        })
      )
    );

    expect(registry.assemble()).toContain("Updated guidance");
    expect(overflowError).toBeInstanceOf(CoreError);
    expect(overflowError?.code).toBe("CONFLICT");
  });
});

function captureError(action: () => void): CoreError | null {
  try {
    action();
    return null;
  } catch (error) {
    if (error instanceof CoreError) {
      return error;
    }
    throw error;
  }
}
