import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { createCompileSeedRunner } from "../../../runs/compile-seed.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";
import { admitStatementSessionCache, buildCompileSeedDaemon, CREDENTIALLED_CONFIG, OFFLINE_CONFIG, makeSeed }
  from "./compile-seed-fixture.js";

const directories: string[] = [];
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });
const messages = [{ message_id: "user-record", role: "user" as const, content: "The original turn remains available." }];
const turn = { workspaceId: "workspace-1", runId: "run-1", seedIndex: 0, evidenceRefBase: "raw-turn",
  turnContent: messages[0]!.content, turnMessages: messages };

it("retains admitted raw bytes without fabricating a memory or duplicate evidence capsule when extraction is unavailable", async () => {
  const onSignal = vi.fn(() => makeSeed("unexpected")), daemon = buildCompileSeedDaemon(onSignal);
  const imported = vi.spyOn(daemon, "importSourceRecord"), publish = vi.spyOn(daemon, "proposeMemoriesFromCompileSignals");
  const runner = createCompileSeedRunner({ config: OFFLINE_CONFIG });
  expect(await runner.seedTurn({ ...turn, daemon })).toMatchObject({ seeds: [] });
  expect(imported).toHaveBeenCalledOnce();
  expect(imported.mock.calls[0]![0]).toMatchObject({ content_bytes: `User: ${messages[0]!.content}` });
  expect((await imported.mock.results[0]!.value).record).toMatchObject({ scope_class: "project" });
  expect(onSignal).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  expect(runner.stats).toMatchObject({ offlineFallbacks: 1, factsProduced: 0, signalsDropped: 0, llmCalls: 0 });
});

it("keeps a valid-empty cached session distinct from unavailable extraction and creates no synthetic publication", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "empty-statement-session-")); directories.push(cacheRoot);
  const config = { ...CREDENTIALLED_CONFIG, sourcePacking: "session-statements" as const };
  writeExtractionCacheTestManifest({ cacheRoot, model: config.model, providerUrl: config.providerUrl,
    systemPrompt: SOURCE_STATEMENTS_PROMPT });
  await admitStatementSessionCache({ cacheRoot, config, messages, rawJson: request => JSON.stringify({
    messages: request.messages.map(message => ({ message_id: message.message_id, statements: [] })) }) });
  const onSignal = vi.fn(() => makeSeed("unexpected")), daemon = buildCompileSeedDaemon(onSignal);
  const imported = vi.spyOn(daemon, "importSourceRecord"), publish = vi.spyOn(daemon, "proposeMemoriesFromCompileSignals");
  const runner = createCompileSeedRunner({ config, cacheRoot });
  expect(await runner.seedTurn({ ...turn, daemon })).toMatchObject({ seeds: [] });
  expect(imported).toHaveBeenCalledOnce(); expect(onSignal).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  expect(runner.stats).toMatchObject({ cacheHits: 1, offlineFallbacks: 0, factsProduced: 0, signalsDropped: 0, llmCalls: 0,
    lastStatementSession: { receipt: { status: "complete", messages: [{ status: "complete", statements: [] }] } } });
});

it("keeps string-only sources raw rather than inventing host message identities", async () => {
  const onSignal = vi.fn(() => makeSeed("unexpected")), daemon = buildCompileSeedDaemon(onSignal);
  const imported = vi.spyOn(daemon, "importSourceRecord");
  const runner = createCompileSeedRunner({ config: OFFLINE_CONFIG });
  expect(await runner.seedTurn({ ...turn, turnMessages: [], daemon })).toMatchObject({ seeds: [] });
  expect(imported).toHaveBeenCalledOnce(); expect(imported.mock.calls[0]![0].host_occurrences).toEqual([]);
  expect(onSignal).not.toHaveBeenCalled(); expect(runner.stats.extractionAttempts).toBe(0);
});

it("stops before extraction and publication when raw-source admission fails", async () => {
  const onSignal = vi.fn(() => makeSeed("unexpected")), daemon = buildCompileSeedDaemon(onSignal);
  vi.spyOn(daemon, "importSourceRecord").mockRejectedValue(new Error("source audit unavailable"));
  const publish = vi.spyOn(daemon, "proposeMemoriesFromCompileSignals");
  const runner = createCompileSeedRunner({ config: OFFLINE_CONFIG });
  await expect(runner.seedTurn({ ...turn, daemon })).rejects.toThrow("source audit unavailable");
  expect(publish).not.toHaveBeenCalled(); expect(onSignal).not.toHaveBeenCalled();
  expect(runner.stats.extractionAttempts).toBe(0);
});
