import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@do-soul/alaya-protocol";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiGardenProvider,
  type GardenCompileContext
} from "../../../garden/ingestion/compute-provider.js";
import type { SignalExtractor } from "../../../garden/extraction/pi-mono-extractor.js";
import { buildOfficialApiExtractionRequest } from "../../../garden/ingestion/official-api/extraction-request.js";

const fixturesDir = fileURLToPath(new URL("../../fixtures/garden-extraction-golden/", import.meta.url));
const fixturesUrl = new URL("../../fixtures/garden-extraction-golden/", import.meta.url);

describe("garden-extraction-parser-parity", () => {
  it("skips historical signals-shaped goldens that are not live interpretation fixtures", async () => {
    const historical = (await loadFixtures()).filter((fixture) => fixture.kind === "historical_signals");
    expect(historical.length).toBeGreaterThan(0);
    for (const fixture of historical) {
      expect(fixture.expectedSignals[0], fixture.name).toEqual(expect.objectContaining({
        object_kind: expect.any(String),
        confidence: expect.any(Number)
      }));
    }
  });

  it("emits the expected located interpretation count and assertion text", async () => {
    const live = (await loadFixtures()).filter((fixture) => fixture.kind === "interpretation");
    expect(live.some((fixture) => fixture.expectedCount > 0)).toBe(true);
    for (const fixture of live) {
      const source = fixture.turn.trim();
      const context = createContext(fixture.turn);
      const extractor: SignalExtractor = {
        extract: async (input) => {
          expect(input.systemPrompt).toBe(OFFICIAL_API_SYSTEM_PROMPT);
          expect(JSON.parse(input.userPrompt)).toEqual(
            buildOfficialApiExtractionRequest(fixture.turn, context.turn_messages)
          );
          return { rawJson: fixture.responseJson };
        }
      };
      const provider = new OfficialApiGardenProvider({
        apiKey: "sk-test",
        extractor,
        now: () => "2026-05-11T06:00:00.000Z",
        generateSignalId: () => "signal-fixture"
      });

      const actual = await provider.compile(fixture.turn, context);
      expect(actual, fixture.name).toHaveLength(fixture.expectedCount);
      for (const signal of actual) {
        if (signal.interpretation_contract !== "source-interpretation-v1") throw new Error("expected interpretation signal");
        expect(signal.signal_kind).toBe("potential_semantic_observation");
        expect(signal.object_kind).toBeNull();
        expect(signal.confidence).toBeNull();
        expect(signal.interpretation_contract).toBe("source-interpretation-v1");
        expect(signal.raw_payload.source_interpretation.outcome).toBe("candidates");
        expect(signal.raw_payload.source_interpretation.assertion_binding.text).toContain(source);
      }
    }
  });
});

async function loadFixtures(): Promise<readonly GoldenFixture[]> {
  const names = (await readdir(fixturesDir)).sort();
  return await Promise.all(names.map(async (name) => {
    const turn = await readFile(new URL(`${name}/turn.txt`, fixturesUrl), "utf8");
    const expected = JSON.parse(
      await readFile(new URL(`${name}/expected.json`, fixturesUrl), "utf8")
    ) as unknown;
    let responseJson: string | null = null;
    try {
      responseJson = await readFile(new URL(`${name}/interpretation.json`, fixturesUrl), "utf8");
    } catch {
      responseJson = null;
    }
    if (responseJson !== null) {
      const parsed = JSON.parse(responseJson) as { readonly interpretations?: unknown };
      if (!Array.isArray(parsed.interpretations)) {
        throw new Error(`${name} interpretation.json must contain an interpretations array`);
      }
      return {
        kind: "interpretation" as const,
        name,
        turn,
        responseJson,
        expectedCount: parsed.interpretations.length === 0 ? 0 : 1,
        expectedSignals: []
      };
    }
    if (!Array.isArray(expected)) {
      throw new Error(`${name} expected.json must be an array`);
    }
    return {
      kind: "historical_signals" as const,
      name,
      turn,
      responseJson: "",
      expectedCount: expected.length,
      expectedSignals: expected as readonly ExpectedSignal[]
    };
  }));
}

function createContext(turn: string): GardenCompileContext {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface-1",
    artifact_key: "artifact-1",
    source_observation: {
      observed_at: "2026-05-11T06:00:00.000Z",
      authority: "trusted_host_event",
      source_event_id: "event-1"
    },
    turn_messages: [
      {
        role: "user",
        content: turn,
        message_id: "message-1",
        created_at: "2026-05-11T06:00:00.000Z"
      } as ConversationMessage
    ]
  };
}

interface ExpectedSignal {
  readonly signal_kind: string;
  readonly object_kind: string;
  readonly confidence: number;
}

type GoldenFixture = Readonly<{
  readonly kind: "interpretation" | "historical_signals";
  readonly name: string;
  readonly turn: string;
  readonly responseJson: string;
  readonly expectedCount: number;
  readonly expectedSignals: readonly ExpectedSignal[];
}>;
