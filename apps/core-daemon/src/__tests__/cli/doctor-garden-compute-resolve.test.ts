import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolveSecretRef: vi.fn()
}));

vi.mock("../../secrets/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../secrets/index.js")>(
    "../../secrets/index.js"
  );
  return {
    ...actual,
    resolveSecretRef: hoisted.resolveSecretRef
  };
});

import { resolveGardenComputeStatus } from "../../cli/register.js";
import type { AlayaDaemonRuntime } from "../../index.js";
import type { GardenCaptureHealth } from "../../garden/host-session/capture-health.js";

afterEach(() => {
  hoisted.resolveSecretRef.mockReset();
});

describe("resolveGardenComputeStatus dedups secret resolution", () => {
  it("reports local fallback for a saved disabled official provider even with a valid credential", async () => {
    hoisted.resolveSecretRef.mockReturnValue({ ref: "keychain:alaya:openai", value: "fixture-only", origin: "keychain" });
    const runtime = createRuntime({ secretRef: "keychain:alaya:openai", providerKind: "official_api", enabled: false });
    expect(await resolveGardenComputeStatus(runtime, "workspace-1")).toMatchObject({
      provider_kind: "official_api", routing_decision: "local_heuristics", keychain_check: { ok: true }
    });
  });
  it("calls resolveSecretRef exactly once when the keychain ref resolves ok", async () => {
    hoisted.resolveSecretRef.mockReturnValue({
      ref: "keychain:alaya:openai",
      value: "sk-test",
      origin: "keychain"
    });
    const runtime = createRuntime({
      secretRef: "keychain:alaya:openai",
      providerKind: "official_api"
    });

    const status = await resolveGardenComputeStatus(runtime, "workspace-1");

    expect(hoisted.resolveSecretRef).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveSecretRef).toHaveBeenCalledWith("keychain:alaya:openai");
    expect(status).toMatchObject({
      routing_decision: "official_api",
      credential_source: { kind: "keychain", service: "alaya", account: "openai" },
      keychain_check: { ok: true, service: "alaya", account: "openai" }
    });
  });

  it("calls resolveSecretRef exactly once when the keychain is locked/unavailable", async () => {
    hoisted.resolveSecretRef.mockReturnValue({
      kind: "keychain_tooling_unavailable",
      ref: "keychain:alaya:openai",
      service: "alaya",
      account: "openai",
      reason: "secret-tool timed out after 10000ms; unlock the platform keychain or retry when keychain UI is available."
    });
    const runtime = createRuntime({
      secretRef: "keychain:alaya:openai",
      providerKind: "official_api"
    });

    const status = await resolveGardenComputeStatus(runtime, "workspace-1");

    // A locked keychain must not cost two subprocesses per doctor pass.
    expect(hoisted.resolveSecretRef).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      routing_decision: "local_heuristics",
      keychain_check: {
        ok: false,
        service: "alaya",
        account: "openai",
        error_kind: "keychain_tooling_unavailable",
        remediation: expect.stringContaining("timed out")
      }
    });
  });

  it("skips resolveSecretRef entirely when no secret_ref is configured", async () => {
    const runtime = createRuntime({
      secretRef: null,
      providerKind: "official_api"
    });

    const status = await resolveGardenComputeStatus(runtime, "workspace-1");

    expect(hoisted.resolveSecretRef).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      routing_decision: "local_heuristics",
      credential_source: { kind: "none" }
    });
    expect(status).not.toHaveProperty("keychain_check");
  });

  it("emits keychain_check=malformed without resolving when the ref grammar is rejected", async () => {
    const runtime = createRuntime({
      secretRef: "keychain:alaya: openai",
      providerKind: "official_api"
    });

    // resolveSecretRef may still be called to drive routing_decision, but a
    // malformed-ref keychain_check must not depend on a second resolve call.
    hoisted.resolveSecretRef.mockReturnValue({
      kind: "malformed",
      ref: "keychain:alaya: openai",
      reason: "Keychain secret ref must match keychain:<service>:<account> with each segment limited to [A-Za-z0-9._-]+."
    });

    const status = await resolveGardenComputeStatus(runtime, "workspace-1");

    expect(hoisted.resolveSecretRef).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      routing_decision: "local_heuristics",
      keychain_check: {
        ok: false,
        service: "",
        account: "",
        error_kind: "malformed"
      }
    });
  });
  it("reads capture health of the doctor workspace from garden status", async () => {
    const health = {
      host_session: { captured_messages: 4, excerpt_messages: 0, last_captured_at: null, unbound_messages: 1,
        overdue_unbound_messages: 0 },
      statement_sessions: { recent_window: 50, failed: 1, latest_error: "Source erased" },
      legacy_post_turn_unprocessed: 0
    };
    const getCaptureHealth = vi.fn((workspaceId: string) => workspaceId === "workspace-1" ? health : null);
    const runtime = createRuntime({ secretRef: null, providerKind: "local_heuristics", gardenStatus: { getCaptureHealth } });

    const status = await resolveGardenComputeStatus(runtime, "workspace-1");

    expect(getCaptureHealth).toHaveBeenCalledWith("workspace-1");
    expect(status.capture).toEqual(health);
  });
});

function createRuntime(input: {
  readonly enabled?: boolean;
  readonly secretRef: string | null;
  readonly providerKind: "official_api" | "local_heuristics" | "host_worker";
  readonly gardenStatus?: {
    getCaptureHealth: (workspaceId: string) => GardenCaptureHealth | null;
  };
}): AlayaDaemonRuntime {
  return {
    services: {
      configService: {
        getRuntimeGardenComputeConfig: async () => ({
          provider_kind: input.providerKind,
          model_id: "gpt-4.1-mini",
          provider_url: null,
          secret_ref: input.secretRef,
          enabled: input.enabled ?? true
        }),
        getGardenCredentialProvenance: async () => ({ kind: input.secretRef === null ? "none" : "keychain" })
      },
      ...(input.gardenStatus === undefined ? {} : { gardenStatus: input.gardenStatus })
    }
  } as unknown as AlayaDaemonRuntime;
}
