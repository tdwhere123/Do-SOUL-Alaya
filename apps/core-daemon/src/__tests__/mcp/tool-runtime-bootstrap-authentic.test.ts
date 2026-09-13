import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../../index.js";

const TEST_TIMEOUT_MS = 45_000;
const tempDirs: string[] = [];
const originalEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "DATA_DIR",
  "OPENAI_API_KEY",
  "ALAYA_OPENAI_SECRET_REF",
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
  "ALAYA_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "ALAYA_REVIEWER_IDENTITY",
  "ALAYA_REVIEWER_TOKEN",
  "ALAYA_SQLITE_WRITE_QUEUE"
] as const;

describe("daemon tool-runtime bootstrap with real storage", () => {
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const previous = originalEnv[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("completes startup steps against a real initDatabase", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "alaya-tool-runtime-authentic-"));
    tempDirs.push(dataDir);
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
    }
    process.env.DATA_DIR = dataDir;
    process.env.ALAYA_CONFIG_DIR = join(dataDir, "config");
    process.env.CODEX_HOME = join(dataDir, "codex-home");
    process.env.HOME = join(dataDir, "home");
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
    process.env.ALAYA_REVIEWER_IDENTITY = "user:tool-runtime-authentic";
    process.env.ALAYA_REVIEWER_TOKEN = "tool-runtime-authentic-token";
    process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";

    let runtime: AlayaDaemonRuntime | undefined;
    try {
      runtime = await createAlayaDaemonRuntime();
      const steps = runtime.startupSteps.map((step) => step.step);
      expect(steps).toEqual(expect.arrayContaining([
        "database",
        "repositories",
        "core-services",
        "garden-runtime",
        "mcp-tooling"
      ]));
      expect(runtime.startupSteps.every((step) => step.completedAt.length > 0)).toBe(true);
    } finally {
      await runtime?.shutdown();
    }
  }, TEST_TIMEOUT_MS);
});
