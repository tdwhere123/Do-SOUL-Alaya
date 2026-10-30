import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { createCompileSeedRunner, type CompileSeedDaemon } from "../../../runs/compile-seed.js";
import { createCompileSeedSourceImporter, CREDENTIALLED_CONFIG } from "./compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });

it("records one redacted diagnostic for a failed session while retaining raw rounds and reusing its failed receipt", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "statement-cause-cache-")); roots.push(cacheRoot);
  const diagnosticDir = await mkdtemp(join(tmpdir(), "statement-cause-diagnostic-")); roots.push(diagnosticDir);
  const apiKey = "PRIVATE_API_KEY_DO_NOT_PERSIST";
  const config = { ...CREDENTIALLED_CONFIG, apiKey, sourcePacking: "session-statements" as const };
  writeExtractionCacheTestManifest({ cacheRoot, model: config.model, providerUrl: config.providerUrl,
    systemPrompt: SOURCE_STATEMENTS_PROMPT });
  const publish = vi.fn(async () => { throw new Error("failed extraction must not publish"); });
  const daemon: CompileSeedDaemon = { importSourceRecord: createCompileSeedSourceImporter("ws-test"),
    proposeMemoryFromSignal: publish, proposeMemoriesFromCompileSignals: publish, proposeSynthesis: publish };
  const imported = vi.spyOn(daemon, "importSourceRecord"), delegate = vi.fn();
  const runner = createCompileSeedRunner({ config, cacheRoot, diagnosticDir, skipPreflight: true,
    extractorFactory: () => ({ extract: delegate }) });
  const messages = [{ message_id: "user-first", role: "user" as const, content: "Private first source body." },
    { message_id: "user-second", role: "user" as const, content: "Private second source body." }];
  const rounds = messages.map((message, seedIndex) => ({ seedIndex, turnContent: message.content, turnMessages: [message] }));
  for (const [seedIndex, message] of messages.entries()) {
    await expect(runner.seedTurn({ daemon, turnContent: message.content, turnMessages: [message], sourceSession: messages,
      sourceSessionRounds: rounds, evidenceRefBase: `raw-round-${seedIndex}`, seedIndex,
      workspaceId: "ws-test", runId: "run-test" })).resolves.toMatchObject({ seeds: [] });
    expect(runner.stats.lastStatementSession).toMatchObject({ firstUse: seedIndex === 0,
      receipt: { status: "failed", messages: [{ status: "failed" }, { status: "failed" }] } });
  }
  expect(imported).toHaveBeenCalledTimes(2); expect(delegate).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  const files = readdirSync(diagnosticDir).filter(file => file.startsWith("compile-seed-") && file.endsWith(".json"));
  expect(files).toHaveLength(1);
  const dump = JSON.parse(readFileSync(join(diagnosticDir, files[0]!), "utf8")) as Record<string, unknown>;
  expect(dump.error_message).toBe("Official garden session compilation is incomplete.");
  expect(dump.error_cause_message).toMatch(/live extraction disabled/u);
  expect((dump.error_cause_message as string).length).toBeLessThanOrEqual(512);
  const serialized = JSON.stringify(dump);
  for (const message of messages) expect(serialized).not.toContain(message.content);
  expect(serialized).not.toContain(apiKey);
});
