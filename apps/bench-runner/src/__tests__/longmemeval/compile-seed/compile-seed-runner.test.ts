import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  buildOfficialApiExtractionRequest,
  buildOfficialApiSourceCorpus,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor,
  createCompileSeedRunner,
  type BenchSignalExtractor
} from "../../../runs/compile-seed.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { computeCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import type { BenchSignalSeedInput, SeededMemoryResult } from "../../../harness/daemon.js";
import {
  buildCompileSeedDaemon, CREDENTIALLED_CONFIG, OFFLINE_CONFIG, interpretationsEnvelope
} from "./compile-seed-fixture.js";
import {
  fixtureAttemptAuthority, providerBackedResponseResult, writeExtractionCacheTestManifest
} from "../extraction/extraction-cache-test-fixture.js";

describe("createCompileSeedRunner — admitted cache consumer", () => {
  let cacheRoot: string;
  const context = { workspaceId: "ws-test", runId: "run-test" };

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-runner-"));
    writeExtractionCacheTestManifest({ cacheRoot,
      model: CREDENTIALLED_CONFIG.model, providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT });
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  function seed(memoryId: string): SeededMemoryResult {
    return { memoryId, signalId: `signal-${memoryId}`, proposalId: `proposal-${memoryId}`,
      evidenceId: `evidence-${memoryId}`, truncated: false, charsClipped: 0 };
  }

  async function admit(turnContent: string, rawJson: string,
    turnMessages: readonly { role: "user" | "assistant"; content: string }[] = []) {
    const manifestPath = join(cacheRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest,
      requested_turns: 1, cached_turns: 1, coverage: 1 }));
    const sourceCorpus = buildOfficialApiSourceCorpus(turnContent, turnMessages);
    const request = buildOfficialApiExtractionRequest(turnContent, turnMessages);
    const userPrompt = stringifyOfficialApiExtractionRequest(request);
    const authority = fixtureAttemptAuthority({ cacheRoot,
      model: CREDENTIALLED_CONFIG.model, requestProfile: CREDENTIALLED_CONFIG.requestProfile });
    const delegate: BenchSignalExtractor = {
      extract: (input) => providerBackedResponseResult(input, rawJson)
    };
    await createCachingSignalExtractor({ delegate, config: CREDENTIALLED_CONFIG,
      cacheRoot, ...authority }).extract({ systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt, sourceCorpus });
    return { userPrompt, sourceCorpus };
  }

  it("seeds every admitted fact through the normal runner without another request", async () => {
    const turnContent = "Alice moved to Berlin. Alice started a job on 2024-03-01.";
    await admit(turnContent, interpretationsEnvelope([
      { matched: "Alice moved to Berlin." },
      { matched: "Alice started a job on 2024-03-01.", assertionId: 2 }
    ]));
    const delegate = vi.fn<BenchSignalExtractor["extract"]>();
    const seeded: BenchSignalSeedInput[] = [];
    const runner = createCompileSeedRunner({ config: CREDENTIALLED_CONFIG, cacheRoot,
      extractorFactory: () => ({ extract: delegate }) });
    const result = await runner.seedTurn({ daemon: buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return seed(`memory-${seeded.length}`);
    }), turnContent, evidenceRefBase: "q1-s0-t0", seedIndex: 0, ...context });

    expect(delegate).not.toHaveBeenCalled();
    expect(result.seeds.map((item) => item.memoryId)).toEqual(["memory-1", "memory-2"]);
    expect(seeded.map((item) => item.distilledFact)).toEqual([
      "User: Alice moved to Berlin.", "Alice started a job on 2024-03-01."
    ]);
    expect(seeded.map((item) => item.evidenceRef)).toEqual(["q1-s0-t0-f0", "q1-s0-t0-f1"]);
    expect(runner.stats).toMatchObject({ path: "official_api_compile", cacheHits: 1,
      llmCalls: 0, factsProduced: 2, liveExtractionFailures: 0 });
  });

  it("keeps trusted User assertions while excluding Assistant text from the admitted request", async () => {
    const turnContent = "User: I moved to Berlin.\nAssistant: You moved to Berlin.";
    const turnMessages = [
      { role: "user" as const, content: "I moved to Berlin.", message_id: "u1" },
      { role: "assistant" as const, content: "You moved to Berlin.", message_id: "a1" }
    ];
    const admitted = await admit(turnContent,
      interpretationsEnvelope([{ matched: "I moved to Berlin." }]), turnMessages);
    expect(JSON.parse(admitted.userPrompt).source_assertions).toEqual([
      { assertion_id: 1, text: "User: I moved to Berlin." }
    ]);
    const seeded: BenchSignalSeedInput[] = [];
    const runner = createCompileSeedRunner({ config: CREDENTIALLED_CONFIG, cacheRoot });
    const result = await runner.seedTurn({ daemon: buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return seed("memory-role-bound");
    }), turnContent, turnMessages,
    evidenceRefBase: "q-role-s0-r0", seedIndex: 0, ...context });

    expect(result.seeds).toHaveLength(1);
    expect(seeded[0]?.distilledFact).toBe("User: I moved to Berlin.");
    expect(seeded[0]?.productionRawPayload).toMatchObject({ source_interpretation: {
      assertion_binding: { assertion_id: 1, text: "User: I moved to Berlin." },
      outcome: "candidates" } });
  });

  it("maps all admitted facts back to the source answer turn", async () => {
    const turnContent = "I like apples. I enjoy coffee. I read novels.";
    await admit(turnContent, interpretationsEnvelope([
      { matched: "I like apples." },
      { matched: "I enjoy coffee.", assertionId: 2 },
      { matched: "I read novels.", assertionId: 3 }
    ]));
    let counter = 0;
    const runner = createCompileSeedRunner({ config: CREDENTIALLED_CONFIG, cacheRoot });
    const result = await runner.seedTurn({ daemon: buildCompileSeedDaemon(() => {
      counter += 1;
      return seed(`memory-${counter}`);
    }), turnContent, evidenceRefBase: "q1-s0-t0", seedIndex: 0, ...context });
    const sidecar = new Map(result.seeds.map((item) => [item.memoryId,
      { sessionId: "session-answer", hasAnswer: true }]));
    expect([...sidecar.keys()]).toEqual(["memory-1", "memory-2", "memory-3"]);
    expect([...sidecar.values()].every((item) => item.hasAnswer &&
      item.sessionId === "session-answer")).toBe(true);
  });

  it("refuses an unauthorized live miss before its delegate and leaves no shard", async () => {
    const turnContent = "I moved to Berlin.";
    const delegate = vi.fn<BenchSignalExtractor["extract"]>();
    const runner = createCompileSeedRunner({ config: CREDENTIALLED_CONFIG, cacheRoot,
      skipPreflight: true, extractorFactory: () => ({ extract: delegate }) });
    await expect(runner.seedTurn({ daemon: buildCompileSeedDaemon(() => seed("never")),
      turnContent, evidenceRefBase: "q1-s0-t0", seedIndex: 0, ...context }))
      .rejects.toThrow("Official garden provider returned an invalid response.");
    const request = buildOfficialApiExtractionRequest(turnContent, []);
    const key = computeCacheKey(CREDENTIALLED_CONFIG.model, CREDENTIALLED_CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT, stringifyOfficialApiExtractionRequest(request));
    expect(delegate).not.toHaveBeenCalled();
    expect(existsSync(cacheFilePath(cacheRoot, key))).toBe(false);
    expect(runner.stats).toMatchObject({ llmCalls: 0, cacheHits: 0, factsProduced: 0 });
  });

  it("preserves an empty source as an evidence capsule without live transport", async () => {
    await admit("ok thanks", '{"interpretations":[]}');
    const seeded: BenchSignalSeedInput[] = [];
    const delegate = vi.fn<BenchSignalExtractor["extract"]>();
    const runner = createCompileSeedRunner({ config: CREDENTIALLED_CONFIG, cacheRoot,
      extractorFactory: () => ({ extract: delegate }) });
    const result = await runner.seedTurn({ daemon: buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return seed("never");
    }), turnContent: "ok thanks", evidenceRefBase: "q1-s0-t0", seedIndex: 0,
    sourceEvidenceFallback: "trusted_source_turn", ...context });
    expect(result.seeds).toEqual([expect.objectContaining({ kind: "evidence_capsule" })]);
    expect(seeded).toHaveLength(0);
    expect(delegate).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({ factsProduced: 0, offlineFallbacks: 0 });
  });

  it("falls back to the full turn only when credentials and manifest are absent", async () => {
    await rm(join(cacheRoot, "manifest.json"), { force: true });
    const seeded: BenchSignalSeedInput[] = [];
    const runner = createCompileSeedRunner({ config: OFFLINE_CONFIG, cacheRoot });
    const turnContent = "First sentence. Second sentence. Third with the answer.";
    const result = await runner.seedTurn({ daemon: buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return seed("memory-1");
    }), turnContent, evidenceRefBase: "q1-s0-t0", seedIndex: 0, ...context });
    expect(result.seeds).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ distilledFact: turnContent,
      extractionProvider: "no_credentials_fallback" });
    expect(runner.stats).toMatchObject({ path: "no_credentials_fallback",
      offlineFallbacks: 1, llmCalls: 0 });
  });
});
