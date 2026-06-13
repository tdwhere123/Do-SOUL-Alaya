import { describe, expect, it } from "vitest";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import {
  OfficialApiGardenProvider
} from "../../garden/compute-provider.js";
import {
  DISTILLED_FACT_MAX_CHARS,
  buildDistilledFact
} from "../../garden/materialization-router.js";

// Producer -> consumer join: a CandidateMemorySignal emitted by the
// official-API garden provider must carry a resolved one-assertion fact
// that materialization's buildDistilledFact uses verbatim, instead of
// re-distilling the raw span. see also: garden/compute-provider.ts and
// garden/materialization-router/inputs.ts buildDistilledFact.

function createContext() {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface-1",
    turn_messages: [
      {
        role: "user" as const,
        content: "turn",
        message_id: "message-1",
        created_at: "2026-04-23T09:00:00.000Z"
      }
    ]
  };
}

async function compileSingleSignal(
  modelJson: string,
  turnContent: string
): Promise<CandidateMemorySignal> {
  const provider = new OfficialApiGardenProvider({
    apiKey: "sk-test",
    extractor: { extract: async () => ({ rawJson: modelJson }) },
    now: () => "2026-04-23T09:00:00.000Z",
    generateSignalId: () => "signal-1"
  });
  const signals = await provider.compile(turnContent, createContext());
  expect(signals).toHaveLength(1);
  return signals[0]!;
}

describe("distilled_fact producer -> consumer join", () => {
  it("uses a within-cap provider distilled_fact verbatim with no ellipsis", async () => {
    const fact = "The operator prefers to be called Ash in all sessions.";
    const signal = await compileSingleSignal(
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
    expect(distilled).toBe(fact);
    expect(distilled.endsWith("...")).toBe(false);
  });

  it("falls through to ruleDistillFromRaw when the provider omits distilled_fact", async () => {
    const turn =
      "We decided to ship the release on Friday. The rollout is gradual. " +
      "A third sentence exists to prove only the first claims survive.";
    const signal = await compileSingleSignal(
      JSON.stringify({
        signals: [
          {
            signal_kind: "potential_claim",
            object_kind: "decision",
            confidence: 0.8,
            matched_text: turn
          }
        ]
      }),
      turn
    );

    // No distilled_fact key: buildDistilledFact must distill the raw span
    // by sentence boundary, not echo the whole matched span verbatim.
    expect("distilled_fact" in signal.raw_payload).toBe(false);
    const distilled = buildDistilledFact(signal);
    expect(distilled).toBe(
      "We decided to ship the release on Friday. The rollout is gradual."
    );
    expect(distilled).not.toContain("third sentence");
  });

  it("hard-clamps an over-cap distilled_fact without appending an ellipsis", async () => {
    const oversized = "z".repeat(DISTILLED_FACT_MAX_CHARS + 500);
    const signal = await compileSingleSignal(
      JSON.stringify({
        signals: [
          {
            signal_kind: "potential_claim",
            object_kind: "fact",
            confidence: 0.7,
            matched_text: "fact text",
            distilled_fact: oversized
          }
        ]
      }),
      "fact text"
    );

    const distilled = buildDistilledFact(signal);
    // The provider already clamped to DISTILLED_FACT_MAX_CHARS; buildDistilledFact
    // must not re-truncate with "..." on an already-distilled fact.
    expect(distilled.length).toBe(DISTILLED_FACT_MAX_CHARS);
    expect(distilled.endsWith("...")).toBe(false);
  });
});
