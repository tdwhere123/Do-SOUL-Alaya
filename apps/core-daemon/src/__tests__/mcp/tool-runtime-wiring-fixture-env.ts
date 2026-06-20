export const ORIGINAL_ALAYA_MCP_TOOL_CATALOG_JSON = process.env.ALAYA_MCP_TOOL_CATALOG_JSON;
export const ORIGINAL_ALAYA_ALLOWED_MCP_SERVERS = process.env.ALAYA_ALLOWED_MCP_SERVERS;
export const ORIGINAL_ALAYA_MCP_SERVER_CONFIG_JSON = process.env.ALAYA_MCP_SERVER_CONFIG_JSON;
export const ORIGINAL_ALAYA_CONFIG_DIR = process.env.ALAYA_CONFIG_DIR;
export const ORIGINAL_ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
export const ORIGINAL_ALAYA_GARDEN_OPENAI_SECRET_REF = process.env.ALAYA_GARDEN_OPENAI_SECRET_REF;
export const ORIGINAL_ALAYA_GARDEN_TEST_OPENAI_KEY = process.env.ALAYA_GARDEN_TEST_OPENAI_KEY;
export const ORIGINAL_ALAYA_OPENAI_SECRET_REF = process.env.ALAYA_OPENAI_SECRET_REF;
export const ORIGINAL_ALAYA_TEST_OPENAI_KEY = process.env.ALAYA_TEST_OPENAI_KEY;
export const ORIGINAL_OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL;
export const ORIGINAL_OPENAI_EMBEDDING_PROVIDER_URL = process.env.OPENAI_EMBEDDING_PROVIDER_URL;
export const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const ORIGINAL_OFFICIAL_GARDEN_MODEL = process.env.OFFICIAL_GARDEN_MODEL;

export async function readMockConfigEnv(): Promise<ReadonlyMap<string, string>> {
  const configDir = process.env.ALAYA_CONFIG_DIR;
  if (configDir === undefined || configDir.trim().length === 0) {
    return new Map();
  }
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  try {
    const raw = await readFile(path.join(configDir, ".env"), "utf8");
    return parseMockEnv(raw);
  } catch {
    return new Map();
  }
}

function parseMockEnv(raw: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 1) {
      continue;
    }
    values.set(trimmed.slice(0, equalsIndex), trimmed.slice(equalsIndex + 1).trim());
  }
  return values;
}
