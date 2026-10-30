import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { createCompileSeedRunner } from "../../../runs/compile-seed.js";
import type { BenchSignalSeedInput } from "../../../harness/daemon.js";
import { admitStatementSessionCache, buildCompileSeedDaemon, CREDENTIALLED_CONFIG, makeSeed } from "./compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

const config = { ...CREDENTIALLED_CONFIG, sourcePacking: "session-statements" as const };
let cacheRoot: string;
beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), "statement-cache-consumer-"));
  writeExtractionCacheTestManifest({ cacheRoot, model: config.model, providerUrl: config.providerUrl, systemPrompt: SOURCE_STATEMENTS_PROMPT });
});
afterEach(async () => { await rm(cacheRoot, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });

describe("admitted statement cache consumer", () => {
  it("publishes each admitted statement under its original raw-round seed coordinate without another request", async () => {
    const turnContent = "Alice moved to Berlin. Alice started a job on 2024-03-01.";
    const messages = [{ message_id: "user-alice", role: "user" as const, content: turnContent }];
    const texts = ["Alice moved to Berlin.", "Alice started a job on 2024-03-01."];
    await admitStatementSessionCache({ cacheRoot, config, messages, rawJson: () => JSON.stringify({
      messages: [{ message_id: "user-alice", statements: texts.map(text => ({ text, relation: "recorded event" })) }] }) });
    const delegate = vi.fn(async () => { throw new Error("cache must not redispatch"); });
    const seeded: BenchSignalSeedInput[] = [];
    const daemon = buildCompileSeedDaemon(input => { seeded.push(input); return makeSeed(`memory-${seeded.length}`); });
    const runner = createCompileSeedRunner({ config, cacheRoot, extractorFactory: () => ({ extract: delegate }) });
    const result = await runner.seedTurn({ daemon, turnContent, turnMessages: messages, evidenceRefBase: "q1-s0-t0",
      seedIndex: 0, workspaceId: "workspace-1", runId: "run-1" });
    expect(delegate).not.toHaveBeenCalled();
    expect(result.seeds.map(seed => seed.memoryId)).toEqual(["memory-1", "memory-2"]);
    expect(seeded.map(input => input.distilledFact)).toEqual(texts);
    expect(seeded.map(input => input.evidenceRef)).toEqual(["q1-s0-t0-f0", "q1-s0-t0-f1"]);
    expect(seeded.map(input => input.turnSeedIndex)).toEqual([0, 0]);
    expect(seeded.map(input => input.turnContent)).toEqual([turnContent, turnContent]);
    expect(runner.stats).toMatchObject({ path: "official_api_compile", cacheHits: 1, llmCalls: 0, factsProduced: 2, liveExtractionFailures: 0 });
  });

  it("retains both user and assistant targets with host-owned roles instead of treating assistant text as user evidence", async () => {
    const messages = [{ message_id: "user-berlin", role: "user" as const, content: "I moved to Berlin." },
      { message_id: "assistant-berlin", role: "assistant" as const, content: "You moved to Berlin." }];
    await admitStatementSessionCache({ cacheRoot, config, messages, rawJson: request => {
      expect(request.messages.map(message => message.role)).toEqual(["user", "assistant"]);
      return JSON.stringify({ messages: request.messages.map(message => ({ message_id: message.message_id,
        statements: [{ text: message.text, relation: "recorded statement" }] })) });
    } });
    const seeded: BenchSignalSeedInput[] = [];
    const daemon = buildCompileSeedDaemon(input => { seeded.push(input); return makeSeed(`memory-${seeded.length}`); });
    const runner = createCompileSeedRunner({ config, cacheRoot });
    expect((await runner.seedTurn({ daemon, turnContent: "User: I moved to Berlin.\nAssistant: You moved to Berlin.",
      turnMessages: messages, evidenceRefBase: "raw-round", seedIndex: 0, workspaceId: "workspace-1", runId: "run-1" })).seeds).toHaveLength(2);
    expect(seeded.map(input => input.productionSignal?.raw_payload.source_statement.message)).toEqual([
      expect.objectContaining({ message_id: "user-berlin", role: "user", text: "I moved to Berlin." }),
      expect.objectContaining({ message_id: "assistant-berlin", role: "assistant", text: "You moved to Berlin." })
    ]);
  });
});
