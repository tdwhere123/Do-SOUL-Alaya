import { describe, expect, it, vi } from "vitest";
import {
  ManifestationPreference,
  RuntimeGovernanceEventType,
  type ActivationCandidate,
  type ExecutionStanceResolution
} from "@do-soul/alaya-protocol";

describe("StanceResolutionService", () => {
  it("uses system defaults when no workspace policy exists and emits stance events", async () => {
    const deps = createDependencies({
      policy: null
    });
    const service = await createService(deps);

    const resolution = await service.resolve({
      workspaceId: "workspace-default",
      runId: "run-default",
      candidates: [],
      modelRef: null
    });

    expect(resolution).toEqual({
      resolution_id: "resolution-001",
      workspace_id: "workspace-default",
      run_id: "run-default",
      verification_attention: "standard",
      conservatism: "balanced",
      contributing_candidate_ids: [],
      model_ref: null,
      resolved_at: NOW
    });

    expect(deps.stancePolicyProvider.getPolicy).toHaveBeenCalledWith("workspace-default");
    expect(deps.eventLogWriter.append).toHaveBeenCalledTimes(2);
    expect(deps.eventLogWriter.append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.STANCE_POLICY_EVALUATED,
        entity_type: "stance_policy",
        entity_id: "workspace-default:implicit-default",
        workspace_id: "workspace-default",
        run_id: "run-default",
        caused_by: "deterministic_rule",
        payload_json: {
          workspace_id: "workspace-default",
          policy_id: null,
          default_verification_attention: "standard",
          default_conservatism: "balanced",
          evaluated_at: NOW
        }
      })
    );
    expect(deps.eventLogWriter.append).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.STANCE_RESOLUTION_CHANGED,
        entity_type: "stance_resolution",
        entity_id: "resolution-001",
        workspace_id: "workspace-default",
        run_id: "run-default",
        caused_by: "deterministic_rule",
        payload_json: {
          resolution_id: "resolution-001",
          workspace_id: "workspace-default",
          run_id: "run-default",
          verification_attention: "standard",
          conservatism: "balanced",
          contributing_candidate_count: 0,
          has_model_ref: false,
          resolved_at: NOW
        }
      })
    );
  });

  it("raises verification attention and conservatism from stance_bias candidates only", async () => {
    const deps = createDependencies({
      policy: createPolicy({
        workspace_id: "workspace-bias",
        default_verification_attention: "low",
        default_conservatism: "permissive",
        minimum_verification_attention: "low",
        minimum_conservatism: "permissive"
      })
    });
    const service = await createService(deps);

    const resolution = await service.resolve({
      workspaceId: "workspace-bias",
      runId: "run-bias",
      candidates: [
        createCandidate({
          candidate_id: "candidate-verify",
          workspace_id: "workspace-bias",
          run_id: "run-bias",
          unfinishedness_bias: 0.9,
          pressure: 1,
          confidence: 1
        }),
        createCandidate({
          candidate_id: "candidate-conservative",
          workspace_id: "workspace-bias",
          run_id: "run-bias",
          verification_bias: 0.85,
          pressure: 1,
          confidence: 1
        }),
        createCandidate({
          candidate_id: "candidate-ignore",
          workspace_id: "workspace-bias",
          run_id: "run-bias",
          default_manifestation_preference: ManifestationPreference.DIALOGUE_NUDGE,
          unfinishedness_bias: 1,
          verification_bias: 1,
          pressure: 1,
          confidence: 1
        })
      ],
      modelRef: null
    });

    expect(resolution.verification_attention).toBe("elevated");
    expect(resolution.conservatism).toBe("conservative");
    expect(resolution.contributing_candidate_ids).toEqual([
      "candidate-verify",
      "candidate-conservative"
    ]);
  });

  it("gives stronger candidates a larger effect and preserves nullable model_ref seam", async () => {
    const policy = createPolicy({
      workspace_id: "workspace-strength",
      default_verification_attention: "low",
      default_conservatism: "balanced",
      minimum_verification_attention: "low",
      minimum_conservatism: "balanced"
    });

    const weakDeps = createDependencies({ policy });
    const weakService = await createService(weakDeps);
    const weakResolution = await weakService.resolve({
      workspaceId: "workspace-strength",
      runId: "run-strength",
      candidates: [
        createCandidate({
          candidate_id: "candidate-weak",
          workspace_id: "workspace-strength",
          run_id: "run-strength",
          unfinishedness_bias: 1,
          pressure: 0.2,
          confidence: 0.2
        })
      ],
      modelRef: null
    });

    const strongDeps = createDependencies({ policy });
    const strongService = await createService(strongDeps);
    const strongResolution = await strongService.resolve({
      workspaceId: "workspace-strength",
      runId: "run-strength",
      candidates: [
        createCandidate({
          candidate_id: "candidate-strong",
          workspace_id: "workspace-strength",
          run_id: "run-strength",
          unfinishedness_bias: 1,
          pressure: 1,
          confidence: 1
        })
      ],
      modelRef: {
        provider: "anthropic",
        model_id: "claude-3.7-sonnet",
        adapter: "claude-runtime"
      }
    });

    expect(weakResolution.verification_attention).toBe("low");
    expect(strongResolution.verification_attention).toBe("elevated");
    expect(strongResolution.model_ref).toEqual({
      provider: "anthropic",
      model_id: "claude-3.7-sonnet",
      adapter: "claude-runtime"
    });
  });

  it("never lowers the minimum safety thresholds and does not mutate candidates", async () => {
    const policy = createPolicy({
      workspace_id: "workspace-floor",
      default_verification_attention: "low",
      default_conservatism: "permissive",
      minimum_verification_attention: "high",
      minimum_conservatism: "strict"
    });
    const deps = createDependencies({ policy });
    const service = await createService(deps);
    const candidates = Object.freeze([
      createCandidate({
        candidate_id: "candidate-readonly",
        workspace_id: "workspace-floor",
        run_id: "run-floor",
        unfinishedness_bias: 0,
        verification_bias: 0,
        pressure: 0.5,
        confidence: 0.5
      })
    ]);

    const resolution = await service.resolve({
      workspaceId: "workspace-floor",
      runId: "run-floor",
      candidates,
      modelRef: null
    });

    expect(resolution.verification_attention).toBe("high");
    expect(resolution.conservatism).toBe("strict");
    expect(candidates).toEqual([
      createCandidate({
        candidate_id: "candidate-readonly",
        workspace_id: "workspace-floor",
        run_id: "run-floor",
        unfinishedness_bias: 0,
        verification_bias: 0,
        pressure: 0.5,
        confidence: 0.5
      })
    ]);
  });

  it("rejects policies that belong to a different workspace before emitting events", async () => {
    const deps = createDependencies({
      policy: createPolicy({
        workspace_id: "workspace-foreign"
      })
    });
    const service = await createService(deps);

    await expect(
      service.resolve({
        workspaceId: "workspace-target",
        runId: "run-target",
        candidates: [],
        modelRef: null
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });
    expect(deps.eventLogWriter.append).not.toHaveBeenCalled();
  });

  it("rejects malformed candidates before contribution scoring", async () => {
    const deps = createDependencies({
      policy: null
    });
    const service = await createService(deps);

    await expect(
      service.resolve({
        workspaceId: "workspace-default",
        runId: "run-default",
        candidates: [{ candidate_id: "broken" } as unknown as ActivationCandidate],
        modelRef: null
      })
    ).rejects.toThrow();
    expect(deps.eventLogWriter.append).not.toHaveBeenCalled();
  });
});

const NOW = "2026-04-17T08:00:00.000Z";

async function createService(deps: ReturnType<typeof createDependencies>) {
  const serviceModulePath = new URL("../stance-resolution-service.js", import.meta.url).href;
  const serviceModule = (await import(serviceModulePath)) as {
    StanceResolutionService: new (dependencies: Record<string, unknown>) => {
      resolve(params: {
        workspaceId: string;
        runId: string;
        candidates: readonly Readonly<ActivationCandidate>[];
        modelRef: { provider: string; model_id: string; adapter?: string } | null;
      }): Promise<ExecutionStanceResolution>;
    };
  };

  return new serviceModule.StanceResolutionService({
    stancePolicyProvider: deps.stancePolicyProvider,
    eventLogWriter: deps.eventLogWriter,
    generateResolutionId: () => "resolution-001",
    now: () => NOW
  });
}

function createDependencies(input: {
  policy: Record<string, unknown> | null;
}) {
  return {
    stancePolicyProvider: {
      getPolicy: vi.fn(async () => input.policy)
    },
    eventLogWriter: {
      append: vi.fn(async (entry: Record<string, unknown>) => ({
        event_id: `event-${Math.random()}`,
        created_at: NOW,
        ...entry
      }))
    }
  };
}

function createPolicy(
  overrides: Partial<{
    workspace_id: string;
    default_verification_attention: "low" | "standard" | "elevated" | "high";
    default_conservatism: "permissive" | "balanced" | "conservative" | "strict";
    minimum_verification_attention: "low" | "standard" | "elevated" | "high";
    minimum_conservatism: "permissive" | "balanced" | "conservative" | "strict";
  }> = {}
) {
  return {
    policy_id: "policy-001",
    workspace_id: "workspace-default",
    default_verification_attention: "standard" as const,
    default_conservatism: "balanced" as const,
    minimum_verification_attention: "standard" as const,
    minimum_conservatism: "balanced" as const,
    created_at: NOW,
    updated_at: NOW,
    ...overrides
  };
}

function createCandidate(
  overrides: Partial<{
    candidate_id: string;
    workspace_id: string;
    run_id: string;
    default_manifestation_preference: "stance_bias" | "dialogue_nudge" | "lens_entry";
    unfinishedness_bias: number;
    verification_bias: number;
    pressure: number;
    confidence: number;
  }> = {}
): Readonly<ActivationCandidate> {
  return Object.freeze({
    candidate_id: overrides.candidate_id ?? "candidate-001",
    workspace_id: overrides.workspace_id ?? "workspace-default",
    run_id: overrides.run_id ?? "run-default",
    source_path_id: "path-001",
    source_anchor: {
      kind: "object" as const,
      object_id: "object-source"
    },
    target_anchor: {
      kind: "object" as const,
      object_id: "object-target"
    },
    why_now: "test candidate",
    effect_vector_snapshot: {
      salience: 0.75,
      recall_bias: 0.2,
      verification_bias: overrides.verification_bias ?? 0,
      unfinishedness_bias: overrides.unfinishedness_bias ?? 0,
      default_manifestation_preference:
        overrides.default_manifestation_preference ?? ManifestationPreference.STANCE_BIAS
    },
    pressure: overrides.pressure ?? 1,
    confidence: overrides.confidence ?? 1,
    governance_ceiling: "attention_only" as const,
    created_at: NOW
  });
}
