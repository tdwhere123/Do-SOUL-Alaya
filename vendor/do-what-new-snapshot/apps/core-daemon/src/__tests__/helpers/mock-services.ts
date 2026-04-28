import { expect, vi } from "vitest";

export function createNoopConversationService(context: string) {
  return {
    sendMessage: vi.fn(async () => {
      throw new Error(`Conversation route not used in ${context}`);
    }),
    listMessages: vi.fn(async () => [])
  };
}

export function createStubEngineBindingService() {
  return {
    getWorkspaceBinding: vi.fn(async () => null),
    saveWorkspaceBinding: vi.fn(async () => null),
    testWorkspaceBinding: vi.fn(async () => null),
    resolveConversationBinding: vi.fn(async () => null)
  };
}

export function createUnusedSignalService(context: string) {
  return {
    listByRun: vi.fn(async () => []),
    receiveSignal: vi.fn(async () => {
      throw new Error(`Signal routes not used in ${context}`);
    })
  };
}

export function createUnusedEvidenceService(context: string) {
  return {
    findById: vi.fn(async () => null),
    findByRunId: vi.fn(async () => []),
    findByWorkspaceId: vi.fn(async () => []),
    findByHealth: vi.fn(async () => []),
    create: vi.fn(async () => {
      throw new Error(`Evidence routes not used in ${context}`);
    }),
    transitionHealth: vi.fn(async () => {
      throw new Error(`Evidence routes not used in ${context}`);
    })
  };
}

export function createUnusedGreenService(context: string) {
  return {
    findEligible: vi.fn(async () => []),
    findGrace: vi.fn(async () => []),
    getStatus: vi.fn(async () => null),
    runVerification: vi.fn(async () => {
      throw new Error(`Green status routes not used in ${context}`);
    })
  };
}

export function createUnusedSessionOverrideService(context: string) {
  return {
    apply: vi.fn(async () => {
      throw new Error(`Override routes not used in ${context}`);
    }),
    getActiveFor: vi.fn(async () => [])
  };
}

export function createUnusedMemoryService(context: string) {
  return {
    findById: vi.fn(async () => null),
    findByWorkspaceId: vi.fn(async () => []),
    findByRunId: vi.fn(async () => []),
    findByDimension: vi.fn(async () => []),
    findByScopeClass: vi.fn(async () => []),
    create: vi.fn(async () => {
      throw new Error(`Memory routes not used in ${context}`);
    }),
    update: vi.fn(async () => {
      throw new Error(`Memory routes not used in ${context}`);
    }),
    archive: vi.fn(async () => {
      throw new Error(`Memory routes not used in ${context}`);
    }),
    validateFactualPolicyBoundary: vi.fn(() => false)
  };
}

export function createUnusedSlotService(context: string) {
  return {
    findById: vi.fn(async () => null),
    findByWorkspace: vi.fn(async () => []),
    onClaimActivated: vi.fn(async () => {
      throw new Error(`Slot service not used in ${context}`);
    })
  };
}

export function createUnusedRecallService(context: string) {
  return {
    recall: vi.fn(async () => {
      throw new Error(`Recall routes not used in ${context}`);
    }),
    buildDefaultPolicy: vi.fn(() => {
      throw new Error(`Recall routes not used in ${context}`);
    })
  };
}

export function createUnusedTaskSurfaceBuilder(context: string) {
  return {
    build: vi.fn(async () => {
      throw new Error(`Task surface routes not used in ${context}`);
    }),
    resolveStrategy: vi.fn(() => {
      throw new Error(`Task surface routes not used in ${context}`);
    })
  };
}

export function createUnusedSurfaceService(context: string) {
  return {
    createSurface: vi.fn(async () => {
      throw new Error(`Surface routes not used in ${context}`);
    }),
    findById: vi.fn(async () => null),
    findBySurfaceId: vi.fn(async () => null),
    findByWorkspace: vi.fn(async () => []),
    transitionStatus: vi.fn(async () => {
      throw new Error(`Surface routes not used in ${context}`);
    }),
    addAnchor: vi.fn(async () => {
      throw new Error(`Surface routes not used in ${context}`);
    }),
    removeAnchor: vi.fn(async () => {
      throw new Error(`Surface routes not used in ${context}`);
    }),
    listAnchors: vi.fn(async () => [])
  };
}

export function createUnusedSurfaceBindingService(context: string) {
  return {
    findBindingById: vi.fn(async () => null),
    findBindingsByObject: vi.fn(async () => []),
    findBindingsBySurface: vi.fn(async () => []),
    findBindingsByWorkspace: vi.fn(async () => []),
    bindObject: vi.fn(async () => {
      throw new Error(`Surface binding routes not used in ${context}`);
    }),
    transitionBindingState: vi.fn(async () => {
      throw new Error(`Surface binding routes not used in ${context}`);
    }),
    cascadeDetachBySurfaceId: vi.fn(async () => {})
  };
}

export function createUnusedCrossCuttingPermissionService(context: string) {
  return {
    findByPermissionId: vi.fn(async () => null),
    findCrossCuttingByObject: vi.fn(async () => null),
    findCrossCuttingByWorkspace: vi.fn(async () => []),
    createCrossCuttingPermission: vi.fn(async () => {
      throw new Error(`Cross cutting routes not used in ${context}`);
    }),
    transitionCrossCuttingState: vi.fn(async () => {
      throw new Error(`Cross cutting routes not used in ${context}`);
    })
  };
}

export function createUnusedSynthesisService(context: string) {
  return {
    findById: vi.fn(async () => null),
    findByWorkspaceId: vi.fn(async () => []),
    findByTopicKey: vi.fn(async () => []),
    create: vi.fn(async () => {
      throw new Error(`Synthesis routes not used in ${context}`);
    }),
    transitionStatus: vi.fn(async () => {
      throw new Error(`Synthesis routes not used in ${context}`);
    }),
    incrementAuthority: vi.fn(async () => {
      throw new Error(`Synthesis routes not used in ${context}`);
    }),
    requestPromotion: vi.fn(async () => {
      throw new Error(`Synthesis routes not used in ${context}`);
    })
  };
}

export function createUnusedClaimService(context: string) {
  return {
    findById: vi.fn(async () => null),
    findByWorkspaceId: vi.fn(async () => []),
    findByCanonicalKey: vi.fn(async () => []),
    create: vi.fn(async () => {
      throw new Error(`Claim routes not used in ${context}`);
    }),
    transitionLifecycle: vi.fn(async () => {
      throw new Error(`Claim routes not used in ${context}`);
    })
  };
}

export function createUnusedProposalService(context: string) {
  return {
    findById: vi.fn(async () => null),
    findByWorkspaceId: vi.fn(async () => []),
    findPending: vi.fn(async () => []),
    createFromSynthesisPromotion: vi.fn(async () => {
      throw new Error(`Proposal routes not used in ${context}`);
    }),
    review: vi.fn(async () => {
      throw new Error(`Proposal routes not used in ${context}`);
    })
  };
}

export function createUnusedBudgetBankruptcyService(context: string) {
  return {
    getSnapshot: vi.fn(async () => {
      throw new Error(`Budget routes not used in ${context}`);
    }),
    resolve: vi.fn(async () => {
      throw new Error(`Budget routes not used in ${context}`);
    }),
    clearRun: vi.fn(() => {})
  };
}

interface TestHttpApp {
  request(input: string, init?: RequestInit): Promise<Response>;
}

export async function configureWorkspacePrincipalCodingEngine(
  app: TestHttpApp,
  workspaceId: string,
  headers: Record<string, string> = {}
): Promise<void> {
  const response = await app.request(`/workspaces/${workspaceId}/engine-config`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify({
      default_engine_class: "coding_engine"
    })
  });

  expect(response.status).toBe(200);
}

export async function configureWorkspacePrincipalConversationEngine(
  app: TestHttpApp,
  workspaceId: string,
  headers: Record<string, string> = {}
): Promise<void> {
  const response = await app.request(`/workspaces/${workspaceId}/engine-config`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify({
      default_engine_class: "conversation_engine",
      conversation_binding: {
        provider_type: "custom",
        base_url: "https://proxy.example/v1",
        api_key: "sk-test",
        model: "proxy-model",
        config: {}
      }
    })
  });

  expect(response.status).toBe(200);
}
