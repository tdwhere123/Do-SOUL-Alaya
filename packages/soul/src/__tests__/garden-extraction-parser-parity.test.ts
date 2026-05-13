import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiGardenProvider,
  type GardenCompileContext
} from "../garden/compute-provider.js";
import type { SignalExtractor } from "../garden/pi-mono-extractor.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/garden-extraction-golden/", import.meta.url));
const fixturesUrl = new URL("./fixtures/garden-extraction-golden/", import.meta.url);

describe("garden-extraction-parser-parity", () => {
  it("parses golden provider JSON into the expected signal kind, object kind, and confidence", async () => {
    for (const fixture of await loadFixtures()) {
      const rawJson = toProviderJson(fixture.expected);
      const extractor: SignalExtractor = {
        extract: async (input) => {
          expect(input.systemPrompt).toBe(OFFICIAL_API_SYSTEM_PROMPT);
          expect(JSON.parse(input.userPrompt)).toMatchObject({
            workspace_id: "workspace-1",
            run_id: "run-1",
            turn_content: fixture.turn.trim()
          });
          return { rawJson };
        }
      };
      const provider = new OfficialApiGardenProvider({
        apiKey: "sk-test",
        extractor,
        now: () => "2026-05-11T06:00:00.000Z",
        generateSignalId: () => "signal-fixture"
      });

      const actual = await provider.compile(fixture.turn, createContext(fixture.turn));

      expect(actual).toHaveLength(fixture.expected.length);
      actual.forEach((signal, index) => {
        const expected = fixture.expected[index]!;
        expect(signal.signal_kind).toBe(expected.signal_kind);
        expect(signal.object_kind).toBe(expected.object_kind);
        expect(signal.confidence).toBeCloseTo(expected.confidence, 1);
        expect(signal.raw_payload.validation_result).toMatchObject({ status: "valid" });
      });
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
      signal_kind: signal.signal_kind,
      object_kind: signal.object_kind,
      confidence: signal.confidence,
      matched_text: `fixture evidence ${index + 1}`,
      reason: "parser_parity_fixture"
    }))
  });
}

function createContext(turn: string): GardenCompileContext {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface-1",
    turn_messages: [
      {
        role: "user",
        content: turn,
        message_id: "message-1",
        created_at: "2026-05-11T06:00:00.000Z"
      }
    ]
  };
}

interface ExpectedSignal {
  readonly signal_kind: string;
  readonly object_kind: string;
  readonly confidence: number;
}
