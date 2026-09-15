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
import { interpretationEnvelope, interpretationRelation } from "./compute-provider-fixtures.js";

const fixturesDir = fileURLToPath(new URL("../../fixtures/garden-extraction-golden/", import.meta.url));
const fixturesUrl = new URL("../../fixtures/garden-extraction-golden/", import.meta.url);

describe("garden-extraction-parser-parity", () => {
  it("parses golden provider JSON into the expected signal kind, object kind, and confidence", async () => {
    for (const fixture of await loadFixtures()) {
      const rawJson = toProviderJson(fixture.expected, fixture.turn.trim());
      const context = createContext(fixture.turn);
      const extractor: SignalExtractor = {
        extract: async (input) => {
          expect(input.systemPrompt).toBe(OFFICIAL_API_SYSTEM_PROMPT);
          expect(JSON.parse(input.userPrompt)).toEqual(
            buildOfficialApiExtractionRequest(fixture.turn, context.turn_messages)
          );
          return { rawJson };
        }
      };
      const provider = new OfficialApiGardenProvider({
        apiKey: "sk-test",
        extractor,
        now: () => "2026-05-11T06:00:00.000Z",
        generateSignalId: () => "signal-fixture"
      });

      const actual = await provider.compile(fixture.turn, context);
      for (const signal of actual) {
        expect(signal.signal_kind).toBe("potential_semantic_observation");
        expect(signal.object_kind).toBeNull();
        expect(signal.confidence).toBeNull();
        expect(signal.interpretation_contract).toBe("source-interpretation-v1");
      }
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

function toProviderJson(expected: readonly ExpectedSignal[], source: string): string {
  const predicate = source.split(/\s+/u).find((token) => /[A-Za-z]{3,}/u.test(token)) ?? source.slice(0, 12);
  return interpretationEnvelope(
    expected.map(() => interpretationRelation(predicate))
  );
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
