// Proves the pi-mono extractor's transport shape (prompts, JSON-mode, options)
// against the curated fixture turns; it does NOT prove extraction quality —
// real-provider extraction is gated by the live smoke recorded in
// docs/archive/v0.2/v0.2.0/task-cards/reports/v0.2.0-slice-3.md.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { createPiMonoExtractor } from "../garden/pi-mono-extractor.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/garden-extraction-golden/", import.meta.url));
const fixturesUrl = new URL("./fixtures/garden-extraction-golden/", import.meta.url);

describe("garden-extraction-golden", () => {
  it("keeps the fixture suite at twenty or more curated turns", async () => {
    const fixtures = await loadFixtures();

    expect(fixtures).toHaveLength(20);
    expect(fixtures.some((fixture) => fixture.expected.length === 0)).toBe(true);
    expect(fixtures.some((fixture) => /\p{Script=Han}/u.test(fixture.turn))).toBe(true);
  });

  it("returns the raw JSON emitted by the pi-mono complete stub for every fixture", async () => {
    for (const fixture of await loadFixtures()) {
      const rawJson = toProviderJson(fixture.expected);
      const completeImpl = vi.fn(async () => createAssistantMessage(rawJson));
      const getModelImpl = vi.fn(() => createModel());
      const extractor = createPiMonoExtractor({
        apiKey: "sk-test",
        model: "gpt-4.1-mini",
        complete: completeImpl,
        getModel: getModelImpl
      });

      await expect(
        extractor.extract({
          systemPrompt: "system prompt",
          userPrompt: fixture.turn,
          timeoutMs: 123
        })
      ).resolves.toEqual({
        rawJson,
        extractorMeta: {
          recoveryKind: "none",
          retryCount: 0,
          retryClassification: "success_first_try"
        }
      });

      expect(completeImpl).toHaveBeenCalledTimes(1);
      const [, context, options] = completeImpl.mock.calls[0] as [
        Model<string>,
        Context,
        ProviderStreamOptions
      ];
      expect(context.systemPrompt).toBe("system prompt");
      expect(context.messages).toEqual([
        expect.objectContaining({
          role: "user",
          content: fixture.turn
        })
      ]);
      expect(options.apiKey).toBe("sk-test");
      expect(options.timeoutMs).toBe(123);
      expect(options.maxRetries).toBe(0);
      expect(options.onPayload).toEqual(expect.any(Function));
    }
  });
});

async function loadFixtures(): Promise<readonly {
  readonly name: string;
  readonly turn: string;
  readonly expected: readonly ExpectedSignal[];
}[]> {
  const names = (await readdir(fixturesDir)).sort();
  return await Promise.all(
    names.map(async (name) => ({
      name,
      turn: await readFile(new URL(`${name}/turn.txt`, fixturesUrl), "utf8"),
      expected: JSON.parse(await readFile(new URL(`${name}/expected.json`, fixturesUrl), "utf8")) as ExpectedSignal[]
    }))
  );
}

function toProviderJson(expected: readonly ExpectedSignal[]): string {
  return JSON.stringify({
    signals: expected.map((signal, index) => ({
      ...signal,
      matched_text: `fixture evidence ${index + 1}`,
      reason: "golden_fixture"
    }))
  });
}

function createModel(): Model<string> {
  return {
    id: "gpt-4.1-mini",
    name: "GPT 4.1 mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192
  };
}

function createAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4.1-mini",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}

interface ExpectedSignal {
  readonly signal_kind: string;
  readonly object_kind: string;
  readonly confidence: number;
}
