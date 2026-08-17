import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  createCompileSeedRunner,
  type CompileSeedDaemon,
  type CompileSeedExtractionConfig
} from "../../../bench/compile-seed.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

describe("compile-seed extraction failure diagnostic", () => {
  let cacheRoot: string;
  let diagnosticDir: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-cause-cache-"));
    diagnosticDir = await mkdtemp(join(tmpdir(), "compile-seed-cause-diag-"));
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "gpt-test-mini",
      providerUrl: "https://example.test/v1",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(diagnosticDir, { recursive: true, force: true });
  });

  it("records only a bounded immediate cause without sensitive inputs", async () => {
    const turnContent = "Turn whose extraction blows up.";
    const apiKey = "PRIVATE_API_KEY_DO_NOT_PERSIST";
    const deepCause = new Error("PRIVATE_RAW_RESPONSE_DO_NOT_PERSIST");
    const immediateCause = new Error(
      `garden extraction HTTP 500 from provider: ${"x".repeat(1_024)}`,
      { cause: deepCause }
    );
    const config: CompileSeedExtractionConfig = {
      providerUrl: "https://example.test/v1",
      model: "gpt-test-mini",
      requestProfile: "provider-default-v1",
      apiKey
    };
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => {
        throw new Error("seed path must not run after extraction failure");
      },
      proposeMemoriesFromCompileSignals: async () => {
        throw new Error("seed path must not run after extraction failure");
      },
      proposeSynthesis: async () => {
        throw new Error("seed path must not run after extraction failure");
      }
    };
    const runner = createCompileSeedRunner({
      config,
      cacheRoot,
      allowLiveExtraction: true,
      diagnosticDir,
      extractorFactory: () => ({
        extract: async () => {
          throw immediateCause;
        }
      })
    });

    await expect(runner.seedTurn({
      daemon,
      turnContent,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    })).rejects.toThrow("Official garden provider returned an invalid response.");

    const dumpFiles = readdirSync(diagnosticDir).filter(
      (file) => file.startsWith("compile-seed-") && file.endsWith(".json")
    );
    expect(dumpFiles).toHaveLength(1);
    const dump = JSON.parse(
      readFileSync(join(diagnosticDir, dumpFiles[0]!), "utf8")
    ) as Record<string, unknown>;

    expect(dump.error_message).toBe(
      "Official garden provider returned an invalid response."
    );
    expect(dump.error_cause_message).toEqual(expect.any(String));
    expect(dump.error_cause_message as string).toMatch(
      /^garden extraction HTTP 500 from provider:/u
    );
    expect((dump.error_cause_message as string).length).toBeLessThanOrEqual(512);
    const serializedDump = JSON.stringify(dump);
    expect(serializedDump).not.toContain(turnContent);
    expect(serializedDump).not.toContain(apiKey);
    expect(serializedDump).not.toContain("PRIVATE_RAW_RESPONSE_DO_NOT_PERSIST");
  });
});
