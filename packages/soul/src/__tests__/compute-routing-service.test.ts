import { describe, expect, it } from "vitest";
import {
  ComputeProviderPriority,
  ExecutionStanceModelRefSchema,
  GardenProviderKind as ProtocolGardenProviderKind
} from "@do-soul/alaya-protocol";
import { ComputeRoutingService } from "../garden/compute-routing-service.js";
import {
  GardenProviderKind,
  type GardenCompileContext,
  type GardenComputeProvider
} from "../garden/compute-provider.js";

const NOW = "2026-04-17T10:20:30.000Z";

describe("ComputeRoutingService", () => {
  it("re-exports protocol-owned GardenProviderKind", () => {
    expect(GardenProviderKind).toBe(ProtocolGardenProviderKind);
  });

  it.each([
    {
      configuredProviders: [
        createCandidate({ kind: ComputeProviderPriority.STUB, model_id: "stub-local-heuristics" }),
        createCandidate({ kind: ComputeProviderPriority.LOCAL_MODEL, model_id: "llama-3.2" }),
        createCandidate({ kind: ComputeProviderPriority.CUSTOM_API, model_id: "gpt-4.1-mini" }),
        createCandidate({ kind: ComputeProviderPriority.OFFICIAL_API, model_id: "gpt-5-mini" })
      ],
      expectedProvider: ComputeProviderPriority.OFFICIAL_API,
      expectedModelId: "gpt-5-mini"
    },
    {
      configuredProviders: [
        createCandidate({ kind: ComputeProviderPriority.STUB, model_id: "stub-local-heuristics" }),
        createCandidate({ kind: ComputeProviderPriority.LOCAL_MODEL, model_id: "llama-3.2" }),
        createCandidate({ kind: ComputeProviderPriority.CUSTOM_API, model_id: "gpt-4.1-mini" })
      ],
      expectedProvider: ComputeProviderPriority.CUSTOM_API,
      expectedModelId: "gpt-4.1-mini"
    },
    {
      configuredProviders: [
        createCandidate({ kind: ComputeProviderPriority.STUB, model_id: "stub-local-heuristics" }),
        createCandidate({ kind: ComputeProviderPriority.LOCAL_MODEL, model_id: "llama-3.2" })
      ],
      expectedProvider: ComputeProviderPriority.LOCAL_MODEL,
      expectedModelId: "llama-3.2"
    },
    {
      configuredProviders: [
        createCandidate({
          kind: ComputeProviderPriority.STUB,
          model_id: "local-heuristics",
          adapter: "garden.local_heuristics"
        })
      ],
      expectedProvider: ComputeProviderPriority.STUB,
      expectedModelId: "local-heuristics"
    }
  ])(
    "selects $expectedProvider when configured providers are available in lower-priority slots",
    async ({ configuredProviders, expectedProvider, expectedModelId }) => {
      const service = new ComputeRoutingService({
        providers: configuredProviders,
        now: () => NOW,
        generateDecisionId: () => "decision-001"
      });

      const decision = await service.route("workspace-1");

      expect(decision).toMatchObject({
        decision_id: "decision-001",
        workspace_id: "workspace-1",
        selected_provider: expectedProvider,
        model_id: expectedModelId,
        decided_at: NOW
      });
    }
  );

  it("fails closed when no routing candidates are configured", async () => {
    const service = new ComputeRoutingService({
      providers: [],
      now: () => NOW,
      generateDecisionId: () => "decision-001"
    });

    await expect(service.route("workspace-1")).rejects.toThrow(
      "Compute routing failed closed: no configured compute providers."
    );
  });

  it("breaks same-priority ties deterministically instead of using registration order", async () => {
    const service = new ComputeRoutingService({
      providers: [
        createCandidate({
          kind: ComputeProviderPriority.CUSTOM_API,
          providerKind: GardenProviderKind.CUSTOM_API,
          model_id: "z-model",
          adapter: "z-adapter"
        }),
        createCandidate({
          kind: ComputeProviderPriority.CUSTOM_API,
          providerKind: GardenProviderKind.CUSTOM_API,
          model_id: "a-model",
          adapter: "a-adapter"
        })
      ],
      now: () => NOW,
      generateDecisionId: () => "decision-001"
    });

    await expect(service.route("workspace-1")).resolves.toMatchObject({
      selected_provider: ComputeProviderPriority.CUSTOM_API,
      model_id: "a-model",
      adapter: "a-adapter"
    });
  });

  it("converts a routing decision into the C-2 model_ref shape", () => {
    const service = new ComputeRoutingService({
      providers: [
        createCandidate({
          kind: ComputeProviderPriority.STUB,
          model_id: "local-heuristics",
          adapter: "garden.local_heuristics"
        })
      ],
      now: () => NOW,
      generateDecisionId: () => "decision-001"
    });

    const modelRef = service.toModelRef({
      decision_id: "decision-001",
      workspace_id: "workspace-1",
      selected_provider: ComputeProviderPriority.STUB,
      model_id: "local-heuristics",
      adapter: "garden.local_heuristics",
      selection_reason: "stub selected as configured fallback compute provider",
      decided_at: NOW
    });

    expect(ExecutionStanceModelRefSchema.parse(modelRef)).toEqual({
      provider: "stub",
      model_id: "local-heuristics",
      adapter: "garden.local_heuristics"
    });
  });

  it("resolves the routed provider from the model_ref contract", () => {
    const officialProvider = createProvider(GardenProviderKind.OFFICIAL_API);
    const localProvider = createProvider(GardenProviderKind.LOCAL_HEURISTICS);
    const service = new ComputeRoutingService({
      providers: [
        {
          kind: ComputeProviderPriority.OFFICIAL_API,
          provider: officialProvider,
          model_id: "gpt-4.1-mini",
          adapter: "garden.official_api"
        },
        {
          kind: ComputeProviderPriority.STUB,
          provider: localProvider,
          model_id: "local-heuristics",
          adapter: "garden.local_heuristics"
        }
      ]
    });

    expect(
      service.resolveProvider({
        provider: ComputeProviderPriority.STUB,
        model_id: "local-heuristics",
        adapter: "garden.local_heuristics"
      })
    ).toBe(localProvider);
    expect(
      service.resolveProvider({
        provider: ComputeProviderPriority.OFFICIAL_API,
        model_id: "gpt-4.1-mini",
        adapter: "garden.official_api"
      })
    ).toBe(officialProvider);
    expect(service.resolveProvider(null)).toBe(officialProvider);
  });

  it("refreshes routing candidates when runtime provider config changes", async () => {
    const officialProvider = createProvider(GardenProviderKind.OFFICIAL_API);
    const localProvider = createProvider(GardenProviderKind.LOCAL_HEURISTICS);
    const service = new ComputeRoutingService({
      providers: [
        {
          kind: ComputeProviderPriority.STUB,
          provider: localProvider,
          model_id: "local-heuristics",
          adapter: "garden.local_heuristics"
        }
      ],
      now: () => NOW,
      generateDecisionId: () => "decision-001"
    });

    await expect(service.route("workspace-1")).resolves.toMatchObject({
      selected_provider: ComputeProviderPriority.STUB,
      model_id: "local-heuristics"
    });
    expect(service.resolveProvider(null)).toBe(localProvider);

    service.setProviders([
      {
        kind: ComputeProviderPriority.OFFICIAL_API,
        provider: officialProvider,
        model_id: "gpt-4.1-mini",
        adapter: "garden.official_api"
      },
      {
        kind: ComputeProviderPriority.STUB,
        provider: localProvider,
        model_id: "local-heuristics",
        adapter: "garden.local_heuristics"
      }
    ]);

    await expect(service.route("workspace-1")).resolves.toMatchObject({
      selected_provider: ComputeProviderPriority.OFFICIAL_API,
      model_id: "gpt-4.1-mini"
    });
    expect(service.resolveProvider(null)).toBe(officialProvider);
    expect(
      service.resolveProvider({
        provider: ComputeProviderPriority.OFFICIAL_API,
        model_id: "gpt-4.1-mini",
        adapter: "garden.official_api"
      })
    ).toBe(officialProvider);
  });
});

function createCandidate(input: {
  readonly kind: (typeof ComputeProviderPriority)[keyof typeof ComputeProviderPriority];
  readonly providerKind?: GardenProviderKind;
  readonly model_id: string;
  readonly adapter?: string;
}) {
  return {
    ...input,
    provider: createProvider(input.providerKind)
  } as const;
}

function createProvider(
  providerKind: GardenProviderKind = GardenProviderKind.LOCAL_HEURISTICS
): GardenComputeProvider {
  return {
    provider_kind: providerKind,
    async compile(_turnContent: string, _context: GardenCompileContext) {
      return [];
    }
  };
}
