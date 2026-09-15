import { describe, expect, it } from "vitest";
import {
  auditOfficialApiSignalFormation,
  parseOfficialApiSignals,
  type GardenCompileContext
} from "../../../garden/ingestion/compute-provider.js";
import { groundOfficialApiDraft } from "../../../garden/ingestion/official-api/source-grounding.js";
import { buildOfficialApiSourceCorpus } from "../../../garden/triage/grounding/source-locator.js";
import { withOpenSemanticFactorGraph } from "./compute-provider-fixtures.js";

const EMPTY_CONTEXT: GardenCompileContext = {
  workspace_id: "workspace-role-trust",
  run_id: "run-role-trust",
  surface_id: null,
  turn_messages: []
};
const COMBINED_TURN = "User: I moved to Paris. Assistant: You live in Berlin.";

describe("official API source role trust", () => {

  it("trusts role-looking text only when it is inside an explicit User message", async () => {
    const source = "I wrote the literal label Assistant: in my note.";
    const [signal] = await providerFor({
      matched_text: source,
      source_locator: {
        contract_version: 4,
        kind: "assertion_catalog",
        assertion_id: 1
      }
    }).compile(source, {
      ...EMPTY_CONTEXT,
      turn_messages: [{
        message_id: "user-1",
        role: "user",
        content: source
      }]
    });

    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "grounded" });
  });


  it.each([
    {
      name: "omitted locator with missing trusted roles",
      draft: { ...signalJson(), matched_text: "You live in Berlin." },
      turn_messages: undefined,
      reason: "source_locator_required"
    },
    {
      name: "omitted locator with a trusted User source",
      draft: signalJson(),
      turn_messages: [{
        message_id: "user-1",
        role: "user" as const,
        content: "I moved to Paris."
      }],
      reason: "source_locator_required"
    }
  ])("fails formation audit closed for $name", ({ draft, turn_messages, reason }) => {
    const result = auditOfficialApiSignalFormation({
      raw_json: JSON.stringify({
        signals: [withOpenSemanticFactorGraph(draft)]
      }),
      turn_content: COMBINED_TURN,
      ...(turn_messages === undefined ? {} : { turn_messages }),
      workspace_id: "workspace-role-trust",
      run_id: "run-role-trust",
      surface_id: null,
      created_at: "2026-07-21T00:00:00.000Z",
      source_observed_at: "2026-07-21T00:00:00.000Z",
      signal_id_for: () => "signal-audit"
    });

    expect(result.entries[0]).toMatchObject({
      disposition: "rejected",
      stage: "grounding",
      reason
    });
  });
});

function signalJson(): Record<string, unknown> {
  return {
    signal_kind: "potential_claim",
    object_kind: "activity",
    confidence: 0.9,
    matched_text: "I moved to Paris.",
    evidence_refs: [],
    source_memory_refs: []
  };
}

function providerFor(fields: Record<string, unknown>) {
  return {
    compile: async (turn: string, context: GardenCompileContext) => {
      const drafts = parseOfficialApiSignals(JSON.stringify({
        signals: [withOpenSemanticFactorGraph({ ...signalJson(), ...fields })]
      }));
      const corpus = buildOfficialApiSourceCorpus(turn, context.turn_messages);
      const grounded = groundOfficialApiDraft(drafts[0]!, corpus);
      return [{ raw_payload: { source_grounding: grounded.audit } }];
    }
  };
}
