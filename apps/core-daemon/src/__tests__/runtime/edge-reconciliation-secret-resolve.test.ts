import { afterEach, describe, expect, it, vi } from "vitest";

// invariant: when canResolveOfficialGardenProvider passes the gate but the
// SECOND secret-ref resolution at port-build time throws (a TOCTOU race:
// credentials configured, readable at the gate, unreadable at use), the
// port builders must warn ALAYA_GARDEN_LLM_SECRET_RESOLVE_FAILED and return
// null (degrade to no-LLM / rule-only) — never swallow the failure silently.
// see also: apps/core-daemon/src/runtime/recall-materialization-edge-reconciliation.ts

const supportMock = vi.hoisted(() => ({
  resolveGardenSecretRefValue: vi.fn(() => {
    throw new Error("keychain locked");
  }),
  canResolveOfficialGardenProvider: vi.fn(() => true),
  createConflictDetectionLlmPort: vi.fn(() => null)
}));

vi.mock("../../runtime/garden-compute-support.js", () => supportMock);

import { edgeReconciliationTestInternals } from "../../runtime/recall-materialization-edge-reconciliation.js";

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
