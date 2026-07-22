import { describe, expect, it } from "vitest";
import { auditOfficialApiSignalFormation } from "../../garden/compute-provider.js";
import { resolveGardenSignalGrounding } from "../../garden/grounding/signal-source-grounding.js";
import { createSignal } from "./materialization-router-fixture.js";

const SOURCE = "I moved to Berlin last year. I moved to Berlin today.";
const MESSAGES = [{ message_id: "u1", role: "user" as const, content: SOURCE }];
const LOCATOR = {
  contract_version: 2 as const,
  kind: "assertion_catalog" as const,
  assertion_id: 1
};

describe("official API locator quote commitment", () => {
  it("rejects a shared quote that cannot identify the selected assertion", () => {
    const formation = auditOfficialApiSignalFormation({
      raw_json: JSON.stringify({ signals: [{
        signal_kind: "potential_claim",
        object_kind: "activity",
        confidence: 0.9,
        matched_text: "I moved to Berlin",
        distilled_fact: "I moved to Berlin today.",
        evidence_refs: [],
        source_memory_refs: [],
        source_locator: LOCATOR
      }] }),
      turn_content: SOURCE,
      turn_messages: MESSAGES,
      workspace_id: "workspace-quote",
      run_id: "run-quote",
      surface_id: null,
      created_at: "2026-07-21T00:00:00.000Z",
      source_observed_at: "2026-07-21T00:00:00.000Z",
      signal_id_for: () => "signal-quote"
    });

    expect(formation.entries[0]).toMatchObject({
      disposition: "rejected",
      reason: "matched_text_absent"
    });
  });

  it("rejects replay when the persisted assertion differs from the live locator result", () => {
    const signal = createSignal({
      source: "garden_compile",
      raw_payload: {
        source_locator: LOCATOR,
        proposed_matched_text: "I moved to Berlin last year.",
        matched_text: "I moved to Berlin today.",
        source_assertion: "I moved to Berlin today.",
        full_turn_content: `User: ${SOURCE}`
      }
    });

    expect(resolveGardenSignalGrounding(signal)).toEqual({
      status: "rejected",
      reason: "source_grounding_rejected"
    });
  });
});
