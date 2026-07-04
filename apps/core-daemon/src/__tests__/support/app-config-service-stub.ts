import { vi } from "vitest";
import type { AppConfigService } from "../../services/config-service.js";
import { implementPort, type LooseStub } from "./implement-port.js";

export function appConfigServiceStub(overrides: LooseStub<AppConfigService> = {}): AppConfigService {
  return implementPort<AppConfigService>({
    getSoulConfig: vi.fn(),
    patchSoulConfig: vi.fn(),
    getStrategyConfig: vi.fn(),
    patchStrategyConfig: vi.fn(),
    getEnvironmentConfig: vi.fn(),
    patchEnvironmentConfig: vi.fn(),
    getManifestationBudgetConfig: vi.fn(),
    patchManifestationBudgetConfig: vi.fn(),
    getRuntimeEmbeddingConfig: vi.fn(),
    patchRuntimeEmbeddingConfig: vi.fn(),
    getGardenCredentialProvenance: vi.fn(async () => ({ kind: "none" as const })),
    getRuntimeGardenComputeConfig: vi.fn(),
    patchRuntimeGardenComputeConfig: vi.fn(),
    ...overrides
  });
}
