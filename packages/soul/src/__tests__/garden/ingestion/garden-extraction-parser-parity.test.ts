import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@do-soul/alaya-protocol";
import {
  type GardenCompileContext
} from "../../../garden/ingestion/compute-provider.js";
import { receiveOfficialApiSourceInterpretations } from "../../../garden/ingestion/official-api/source-interpretation-receive.js";
import { buildOfficialApiSourceCorpus } from "../../../garden/triage/grounding/source-locator.js";
import { buildOfficialApiExtractionRequest } from "../../../garden/ingestion/official-api/extraction-request.js";

const fixturesDir = fileURLToPath(new URL("../../fixtures/garden-extraction-golden/", import.meta.url));
const fixturesUrl = new URL("../../fixtures/garden-extraction-golden/", import.meta.url);

describe("retained extraction parser parity", () => {
  it("preserves original signal-shaped fixture meaning", async () => {
    const historical = (await loadFixtures()).filter((fixture) => fixture.kind === "historical_signals");
    expect(historical.length).toBeGreaterThan(0);
    for (const fixture of historical) {
      expect(fixture.expectedSignals[0], fixture.name).toEqual(expect.objectContaining({
        object_kind: expect.any(String),
        confidence: expect.any(Number)
      }));
    }
  });

  it("inspects retained interpretation count and assertion text without publication", async () => {
    const live = (await loadFixtures()).filter((fixture) => fixture.kind === "interpretation");
    expect(live.some((fixture) => fixture.expectedCount > 0)).toBe(true);
    for (const fixture of live) {
      const source = fixture.turn.trim();
      const context = createContext(fixture.turn);
      const received = receiveOfficialApiSourceInterpretations(fixture.responseJson,
        buildOfficialApiExtractionRequest(fixture.turn, context.turn_messages), {
          sourceCorpus: buildOfficialApiSourceCorpus(fixture.turn, context.turn_messages), artifactKey: "artifact-1"
        });
      const candidates = received.located.filter(member => member.outcome === "candidates");
      expect(candidates, fixture.name).toHaveLength(fixture.expectedCount);
      for (const member of candidates) expect(member.assertion_binding.text).toContain(source);
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
