import { describe, expect, it } from "vitest";
import {
  OfficialApiGardenProvider,
  parseOfficialApiSignals,
  type GardenCompileContext
} from "../../../garden/ingestion/compute-provider.js";
import {
  createExtractor,
  interpretationEnvelope,
  interpretationRelation,
  withOpenSemanticFactorGraph
} from "./compute-provider-fixtures.js";

const SOURCE = "I prefer dark mode for the theme.";
const CONTEXT: GardenCompileContext = {
  workspace_id: "workspace-preference",
  run_id: "run-preference",
  surface_id: null,
  artifact_key: "artifact-preference",
  source_observation: {
    observed_at: "2026-04-23T09:00:00.000Z",
    authority: "trusted_host_event",
    source_event_id: "event-preference"
  },
  turn_messages: [{ message_id: "u1", role: "user", content: SOURCE }]
};

describe("official API preference profile grounding", () => {
  it("ordinary compile does not use a model preference profile to select memory-plus-claim", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(interpretationEnvelope([
        interpretationRelation("prefer", [
          { role: "agent", text: "I" },
          { role: "theme", text: "dark mode" }
        ])
      ])),
      generateSignalId: () => "signal-preference"
    });
    const [signal] = await provider.compile(SOURCE, CONTEXT);
    expect(signal?.interpretation_contract).toBe("source-interpretation-v1");
    expect(signal?.object_kind).toBeNull();
    expect(signal?.confidence).toBeNull();
    expect(signal?.raw_payload).not.toHaveProperty("preference_profile");
    expect(signal?.signal_kind).toBe("potential_semantic_observation");
  });

  it("historical raw readers still parse a recorded preference profile", () => {
    const [draft] = parseOfficialApiSignals(JSON.stringify({
      signals: [withOpenSemanticFactorGraph({
        signal_kind: "potential_preference",
        object_kind: "preference",
        confidence: 0.9,
        matched_text: SOURCE,
        source_locator: { contract_version: 4, kind: "assertion_catalog", assertion_id: 1 },
        preference_profile: {
          projection_schema_version: 1,
          preference_subject: "I",
          preference_predicate: "prefer",
          preference_object: "dark mode",
          preference_polarity: "positive"
        }
      })]
    }));
    expect(draft?.preference_profile).toMatchObject({
      preference_object: "dark mode",
      preference_polarity: "positive"
    });
  });
});
