import { vi } from "vitest";
import "./tool-runtime-wiring-fixture-mocks.js";
import { getToolRuntimeWiringHoisted } from "./tool-runtime-wiring-fixture-state.js";
export { createDeferred } from "../support/deferred.js";
import {
  ORIGINAL_ALAYA_ALLOWED_MCP_SERVERS,
  ORIGINAL_ALAYA_CONFIG_DIR,
  ORIGINAL_ALAYA_ENABLE_EMBEDDING_SUPPLEMENT,
  ORIGINAL_ALAYA_GARDEN_OPENAI_SECRET_REF,
  ORIGINAL_ALAYA_GARDEN_TEST_OPENAI_KEY,
  ORIGINAL_ALAYA_MCP_SERVER_CONFIG_JSON,
  ORIGINAL_ALAYA_MCP_TOOL_CATALOG_JSON,
  ORIGINAL_ALAYA_OPENAI_SECRET_REF,
  ORIGINAL_ALAYA_TEST_OPENAI_KEY,
  ORIGINAL_OFFICIAL_GARDEN_MODEL,
  ORIGINAL_OPENAI_API_KEY,
  ORIGINAL_OPENAI_EMBEDDING_MODEL,
  ORIGINAL_OPENAI_EMBEDDING_PROVIDER_URL
} from "./tool-runtime-wiring-fixture-env.js";
import { restoreProcessEnv } from "../support/restore-process-env.js";

const hoisted = getToolRuntimeWiringHoisted();

export function resetToolRuntimeWiringState(): void {
  vi.clearAllMocks();
  vi.resetModules();
  hoisted.resetToolSpecMap();
  hoisted.extensionProviders.splice(0, hoisted.extensionProviders.length);
  hoisted.resetRuntimeConversationToolSpecs();
  hoisted.resetMcpRuntimeState();
  hoisted.engineToolSnapshots.splice(0, hoisted.engineToolSnapshots.length);
  hoisted.backgroundManagers.splice(0, hoisted.backgroundManagers.length);
  hoisted.gardenBacklogTelemetryServices.splice(0, hoisted.gardenBacklogTelemetryServices.length);
  hoisted.createDaemonEmbeddingRuntimeOverride = null;
  hoisted.lastDaemonEmbeddingRuntimeInput = null;
  hoisted.mcpBridgeDeps = null;
  hoisted.canonicalAliasServiceDeps = null;
  hoisted.claimServiceDeps = null;
  hoisted.computeRoutingServiceDeps = null;
  hoisted.computeRoutingServiceSetProviders = null;
  hoisted.conversationToolExecutorDeps = null;
  hoisted.conversationServiceDeps = null;
  hoisted.officialGardenProviderDeps = null;
  hoisted.coreWarmCjkSegmentation.mockReset();
  hoisted.coreWarmCjkSegmentation.mockImplementation(async () => false);
  hoisted.storageWarmCjkSegmentation.mockReset();
  hoisted.storageWarmCjkSegmentation.mockImplementation(async () => false);
  hoisted.loadConfigEnv.mockReset();
  if (hoisted.loadConfigEnvDefault !== null) {
    hoisted.loadConfigEnv.mockImplementation(
      hoisted.loadConfigEnvDefault as unknown as () => Promise<Map<string, string>>
    );
  }
  hoisted.rebuildCountersFromEventLog.mockReset();
  hoisted.rebuildCountersFromEventLog.mockImplementation(async () => undefined);

  restoreProcessEnv("ALAYA_MCP_TOOL_CATALOG_JSON", ORIGINAL_ALAYA_MCP_TOOL_CATALOG_JSON);
  restoreProcessEnv("ALAYA_ALLOWED_MCP_SERVERS", ORIGINAL_ALAYA_ALLOWED_MCP_SERVERS);
  restoreProcessEnv("ALAYA_MCP_SERVER_CONFIG_JSON", ORIGINAL_ALAYA_MCP_SERVER_CONFIG_JSON);
  restoreProcessEnv("ALAYA_CONFIG_DIR", ORIGINAL_ALAYA_CONFIG_DIR);
  restoreProcessEnv("ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", ORIGINAL_ALAYA_ENABLE_EMBEDDING_SUPPLEMENT);
  restoreProcessEnv("ALAYA_GARDEN_OPENAI_SECRET_REF", ORIGINAL_ALAYA_GARDEN_OPENAI_SECRET_REF);
  restoreProcessEnv("ALAYA_GARDEN_TEST_OPENAI_KEY", ORIGINAL_ALAYA_GARDEN_TEST_OPENAI_KEY);
  restoreProcessEnv("ALAYA_OPENAI_SECRET_REF", ORIGINAL_ALAYA_OPENAI_SECRET_REF);
  restoreProcessEnv("ALAYA_TEST_OPENAI_KEY", ORIGINAL_ALAYA_TEST_OPENAI_KEY);
  restoreProcessEnv("OPENAI_EMBEDDING_MODEL", ORIGINAL_OPENAI_EMBEDDING_MODEL);
  restoreProcessEnv("OPENAI_EMBEDDING_PROVIDER_URL", ORIGINAL_OPENAI_EMBEDDING_PROVIDER_URL);
  restoreProcessEnv("OPENAI_API_KEY", ORIGINAL_OPENAI_API_KEY);
  restoreProcessEnv("OFFICIAL_GARDEN_MODEL", ORIGINAL_OFFICIAL_GARDEN_MODEL);
}

export function getToolRuntimeWiringFixture() {
  return hoisted;
}
