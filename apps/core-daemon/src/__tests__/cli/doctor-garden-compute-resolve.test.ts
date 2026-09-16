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

afterEach(() => {
  hoisted.resolveSecretRef.mockReset();
});

describe("resolveGardenComputeStatus dedups secret resolution", () => {
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
  it("reads recent extract failures and enqueue-never-queued counts from garden status", async () => {
    const getHostWorkerExtractBacklog = vi.fn((workspaceId?: string) => ({
      pending: 0,
      stale: 0,
      failed: workspaceId === "workspace-1" ? 4 : 99,
      edgeClassifyPending: 0,
      edgeClassifyStale: 0
    }));
    const getRecentCompileEnqueueFailures = vi.fn(async (workspaceId: string) =>
      workspaceId === "workspace-1" ? 2 : 7
    );
    const runtime = createRuntime({
      secretRef: null,
      providerKind: "local_heuristics",
      gardenStatus: {
        getHostWorkerExtractBacklog,
        getRecentCompileEnqueueFailures
      }
    });

    const status = await resolveGardenComputeStatus(runtime, "workspace-1");

    expect(getHostWorkerExtractBacklog).toHaveBeenCalledWith("workspace-1");
    expect(getRecentCompileEnqueueFailures).toHaveBeenCalledWith("workspace-1");
    expect(status.failed_post_turn_extract_tasks).toBe(4);
    expect(status.compile_enqueue_failures).toBe(2);
  });
});

function createRuntime(input: {
  readonly secretRef: string | null;
  readonly providerKind: "official_api" | "local_heuristics" | "host_worker";
  readonly gardenStatus?: {
    getHostWorkerExtractBacklog: (workspaceId?: string) => {
      readonly pending: number;
      readonly stale: number;
      readonly failed: number;
      readonly edgeClassifyPending: number;
      readonly edgeClassifyStale: number;
    } | null;
    getRecentCompileEnqueueFailures: (workspaceId: string) => Promise<number>;
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
          enabled: true
        }),
        getGardenCredentialProvenance: async () => ({ kind: input.secretRef === null ? "none" : "keychain" })
      },
      ...(input.gardenStatus === undefined ? {} : { gardenStatus: input.gardenStatus })
    }
  } as unknown as AlayaDaemonRuntime;
}
