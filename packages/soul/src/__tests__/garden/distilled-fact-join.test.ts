import { describe, expect, it } from "vitest";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import {
  OfficialApiGardenProvider
} from "../../garden/compute-provider.js";
import {
  DISTILLED_FACT_MAX_CHARS,
  buildDistilledFact
} from "../../garden/materialization-router.js";

// Producer -> consumer join: model paraphrases remain auditable proposals,
// while durable content is rebuilt from the source assertion.

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
  it("uses the source assertion instead of a free model paraphrase", async () => {
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
    expect(distilled).toBe("From now on call me Ash.");
    expect(signal.raw_payload.proposed_distilled_fact).toBe(fact);
    expect(distilled.endsWith("...")).toBe(false);
  });

  it("derives the matched source assertion when the provider omits distilled_fact", async () => {
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
    const signal = await compileSingleSignal(
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
