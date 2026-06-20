import { vi } from "vitest";
import "./tool-runtime-wiring-fixture-mocks.js";
import { getToolRuntimeWiringHoisted } from "./tool-runtime-wiring-fixture-state.js";
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

  if (ORIGINAL_ALAYA_MCP_TOOL_CATALOG_JSON === undefined) {
    delete process.env.ALAYA_MCP_TOOL_CATALOG_JSON;
  } else {
    process.env.ALAYA_MCP_TOOL_CATALOG_JSON = ORIGINAL_ALAYA_MCP_TOOL_CATALOG_JSON;
  }

  if (ORIGINAL_ALAYA_ALLOWED_MCP_SERVERS === undefined) {
    delete process.env.ALAYA_ALLOWED_MCP_SERVERS;
  } else {
    process.env.ALAYA_ALLOWED_MCP_SERVERS = ORIGINAL_ALAYA_ALLOWED_MCP_SERVERS;
  }

  if (ORIGINAL_ALAYA_MCP_SERVER_CONFIG_JSON === undefined) {
    delete process.env.ALAYA_MCP_SERVER_CONFIG_JSON;
  } else {
    process.env.ALAYA_MCP_SERVER_CONFIG_JSON = ORIGINAL_ALAYA_MCP_SERVER_CONFIG_JSON;
  }

  if (ORIGINAL_ALAYA_CONFIG_DIR === undefined) {
    delete process.env.ALAYA_CONFIG_DIR;
  } else {
    process.env.ALAYA_CONFIG_DIR = ORIGINAL_ALAYA_CONFIG_DIR;
  }

  if (ORIGINAL_ALAYA_ENABLE_EMBEDDING_SUPPLEMENT === undefined) {
    delete process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
  } else {
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = ORIGINAL_ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
  }

  if (ORIGINAL_ALAYA_GARDEN_OPENAI_SECRET_REF === undefined) {
    delete process.env.ALAYA_GARDEN_OPENAI_SECRET_REF;
  } else {
    process.env.ALAYA_GARDEN_OPENAI_SECRET_REF = ORIGINAL_ALAYA_GARDEN_OPENAI_SECRET_REF;
  }

  if (ORIGINAL_ALAYA_GARDEN_TEST_OPENAI_KEY === undefined) {
    delete process.env.ALAYA_GARDEN_TEST_OPENAI_KEY;
  } else {
    process.env.ALAYA_GARDEN_TEST_OPENAI_KEY = ORIGINAL_ALAYA_GARDEN_TEST_OPENAI_KEY;
  }

  if (ORIGINAL_ALAYA_OPENAI_SECRET_REF === undefined) {
    delete process.env.ALAYA_OPENAI_SECRET_REF;
  } else {
    process.env.ALAYA_OPENAI_SECRET_REF = ORIGINAL_ALAYA_OPENAI_SECRET_REF;
  }

  if (ORIGINAL_ALAYA_TEST_OPENAI_KEY === undefined) {
    delete process.env.ALAYA_TEST_OPENAI_KEY;
  } else {
    process.env.ALAYA_TEST_OPENAI_KEY = ORIGINAL_ALAYA_TEST_OPENAI_KEY;
  }

  if (ORIGINAL_OPENAI_EMBEDDING_MODEL === undefined) {
    delete process.env.OPENAI_EMBEDDING_MODEL;
  } else {
    process.env.OPENAI_EMBEDDING_MODEL = ORIGINAL_OPENAI_EMBEDDING_MODEL;
  }

  if (ORIGINAL_OPENAI_EMBEDDING_PROVIDER_URL === undefined) {
    delete process.env.OPENAI_EMBEDDING_PROVIDER_URL;
  } else {
    process.env.OPENAI_EMBEDDING_PROVIDER_URL = ORIGINAL_OPENAI_EMBEDDING_PROVIDER_URL;
  }

  if (ORIGINAL_OPENAI_API_KEY === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  }

  if (ORIGINAL_OFFICIAL_GARDEN_MODEL === undefined) {
    delete process.env.OFFICIAL_GARDEN_MODEL;
  } else {
    process.env.OFFICIAL_GARDEN_MODEL = ORIGINAL_OFFICIAL_GARDEN_MODEL;
  }
}

export function getToolRuntimeWiringFixture() {
  return hoisted;
}

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
