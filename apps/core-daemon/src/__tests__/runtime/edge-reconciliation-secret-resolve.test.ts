import { afterEach, describe, expect, it, vi } from "vitest";

// A provider gate cannot attest Garden execution when credential resolution
// fails at port construction; the runtime must fall back visibly.

const supportMock = vi.hoisted(() => ({
  resolveGardenSecretRefValue: vi.fn(() => {
    throw new Error("keychain locked");
  }),
  canResolveOfficialGardenProvider: vi.fn(() => true),
  createConflictDetectionLlmPort: vi.fn(() => null)
}));

vi.mock("../../runtime/garden-wiring/garden-compute-support.js", () => supportMock);

import { edgeReconciliationTestInternals } from "../../runtime/recall-materialization/recall-materialization-edge-reconciliation.js";

const gardenConfig = {
  provider_kind: "official_api",
  enabled: true,
  secret_ref: "keychain:alaya:garden",
  provider_url: "https://example.test/v1",
  model_id: "test-model"
} as never;

describe("edge/reconciliation port builders on secret-ref resolution failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    supportMock.resolveGardenSecretRefValue.mockImplementation(() => {
      throw new Error("keychain locked");
    });
    supportMock.canResolveOfficialGardenProvider.mockReturnValue(true);
  });

  it("edge auto-producer port warns and returns null when the secret-ref is unreadable", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const port = edgeReconciliationTestInternals.createEdgeAutoProducerLlmPortFromConfig(gardenConfig);

    expect(port).toBeNull();
    expect(emitWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_GARDEN_LLM_SECRET_RESOLVE_FAILED" })
    );
  });

  it("reconciliation port warns and returns null when the secret-ref is unreadable", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const port = edgeReconciliationTestInternals.createReconciliationLlmPortFromConfig(gardenConfig);

    expect(port).toBeNull();
    expect(emitWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_GARDEN_LLM_SECRET_RESOLVE_FAILED" })
    );
  });

  it("does not warn on the legitimate missing-config path (provider gate fails)", () => {
    supportMock.canResolveOfficialGardenProvider.mockReturnValue(false);
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const port = edgeReconciliationTestInternals.createEdgeAutoProducerLlmPortFromConfig(gardenConfig);

    expect(port).toBeNull();
    expect(emitWarning).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_GARDEN_LLM_SECRET_RESOLVE_FAILED" })
    );
  });
});
