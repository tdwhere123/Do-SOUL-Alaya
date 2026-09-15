import { describe, expect, it } from "vitest";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import {
  auditOfficialApiSignalFormation
} from "../../../garden/ingestion/official-api/formation-audit.js";
import {
  DISTILLED_FACT_MAX_CHARS,
  buildDistilledFact
} from "../../../garden/materialization/materialization-router.js";


// Historical signals replay still reconstructs durable text from its source.
async function replaySingleSignal(
  modelJson: string,
  turnContent: string
): Promise<CandidateMemorySignal> {
  const audit = auditOfficialApiSignalFormation({
    raw_json: modelJson,
    turn_content: turnContent,
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface-1",
    allow_legacy_single_user_source: true,
    created_at: "2026-04-23T09:00:00.000Z",
    source_observed_at: "2026-04-23T08:59:00.000Z",
    signal_id_for: () => "signal-1"
  });
  expect(audit.entries).toHaveLength(1);
  expect(audit.entries[0]?.disposition).toBe("admitted");
  return audit.entries[0]!.signal!;
}

describe("historical distilled fact replay and materialization", () => {
  it("uses the source assertion instead of a free model paraphrase", async () => {
    const fact = "The operator prefers to be called Ash in all sessions.";
    const signal = await replaySingleSignal(
      JSON.stringify({
        signals: [
          {
            signal_kind: "potential_preference",
            object_kind: "preference",
            confidence: 0.9,
            matched_text: "call me Ash",
            distilled_fact: fact
          }
        ]
      }),
      "From now on call me Ash."
    );

    const distilled = buildDistilledFact(signal);
    expect(distilled).toBe("From now on call me Ash.");
    expect(signal.raw_payload.proposed_distilled_fact).toBe(fact);
    expect(distilled.endsWith("...")).toBe(false);
  });

  it("derives the matched source assertion when the provider omits distilled_fact", async () => {
    const turn =
      "We decided to ship the release on Friday. The rollout is gradual. " +
      "A third sentence exists to prove only the first claims survive.";
    const signal = await replaySingleSignal(
      JSON.stringify({
        signals: [
          {
            signal_kind: "potential_claim",
            object_kind: "decision",
            confidence: 0.8,
            matched_text: "We decided to ship the release on Friday."
          }
        ]
      }),
      turn
    );

    expect(signal.raw_payload.distilled_fact).toBe(
      "We decided to ship the release on Friday."
    );
    const distilled = buildDistilledFact(signal);
    expect(distilled).toBe("We decided to ship the release on Friday.");
    expect(distilled).not.toContain("third sentence");
  });

  it("clamps an over-cap proposal without allowing it into durable content", async () => {
    const oversized = "z".repeat(DISTILLED_FACT_MAX_CHARS + 500);
    const signal = await replaySingleSignal(
      JSON.stringify({
        signals: [
          {
            signal_kind: "potential_claim",
            object_kind: "fact",
            confidence: 0.7,
            matched_text: "The fact is grounded.",
            distilled_fact: oversized
          }
        ]
      }),
      "The fact is grounded."
    );

    const distilled = buildDistilledFact(signal);
    expect(distilled).toBe("The fact is grounded.");
    expect((signal.raw_payload.source_grounding as {
      proposed_distilled_fact: string;
    }).proposed_distilled_fact).toHaveLength(DISTILLED_FACT_MAX_CHARS);
    expect(distilled.endsWith("...")).toBe(false);
  });
});
