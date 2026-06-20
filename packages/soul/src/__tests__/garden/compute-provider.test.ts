import { describe, expect, it, vi } from "vitest";
import {
  GardenProviderError,
  GardenProviderKind,
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiGardenProvider
} from "../../garden/compute-provider.js";

import { createContext, createExtractor } from "./compute-provider-fixtures.js";

describe("OfficialApiGardenProvider", () => {  it("materializes candidate signals from a successful official API response", async () => {
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_preference",
          object_kind: "user_preference",
          confidence: 0.92,
          matched_text: "Call me Ash",
          distilled_fact: "The operator prefers to be called Ash.",
          reason: "naming_preference"
        }
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      now: () => "2026-04-23T09:00:00.000Z",
      generateSignalId: () => "signal-1"
    });

    await expect(provider.compile("Call me Ash.", createContext())).resolves.toEqual([
      expect.objectContaining({
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        source: "garden_compile",
        signal_kind: "potential_preference",
        object_kind: "user_preference",
        confidence: 0.92,
        raw_payload: expect.objectContaining({
          matched_text: "Call me Ash",
          distilled_fact: "The operator prefers to be called Ash.",
          provider_kind: GardenProviderKind.OFFICIAL_API,
          extraction_reason: "naming_preference"
        }),
        created_at: "2026-04-23T09:00:00.000Z"
      })
    ]);
    expect(extractor.extract).toHaveBeenCalledTimes(1);
  });


  it("instructs the model to emit a resolved one-assertion distilled_fact per signal", () => {
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("distilled_fact");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("one assertion");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("split compound statements into separate signals");
  });


  it("leaves distilled_fact absent when a signal omits it", async () => {
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_claim",
          object_kind: "decision",
          confidence: 0.7,
          matched_text: "We decided to ship on Friday"
        }
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      generateSignalId: () => "signal-fallback"
    });

    const signals = await provider.compile("We decided to ship on Friday.", createContext());
    expect(signals).toHaveLength(1);
    expect("distilled_fact" in signals[0]!.raw_payload).toBe(false);
  });


  it("leaves distilled_fact absent when the model sends a non-string or array value", async () => {
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_claim",
          object_kind: "decision",
          confidence: 0.7,
          matched_text: "We decided to ship on Friday",
          distilled_fact: ["not", "a", "string"]
        },
        {
          signal_kind: "potential_claim",
          object_kind: "decision",
          confidence: 0.6,
          matched_text: "We picked Postgres",
          distilled_fact: 42
        }
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      generateSignalId: (() => {
        let counter = 0;
        return () => `signal-${++counter}`;
      })()
    });

    const signals = await provider.compile("We decided to ship on Friday.", createContext());
    expect(signals).toHaveLength(2);
    expect("distilled_fact" in signals[0]!.raw_payload).toBe(false);
    expect("distilled_fact" in signals[1]!.raw_payload).toBe(false);
  });


  it("leaves distilled_fact absent when the model sends an empty string", async () => {
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_claim",
          object_kind: "decision",
          confidence: 0.7,
          matched_text: "We decided to ship on Friday",
          distilled_fact: "   "
        }
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      generateSignalId: () => "signal-empty"
    });

    const signals = await provider.compile("We decided to ship on Friday.", createContext());
    expect(signals).toHaveLength(1);
    expect("distilled_fact" in signals[0]!.raw_payload).toBe(false);
  });


  it("drops one schema-rejected signal but keeps the rest of the turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const extractor = createExtractor(JSON.stringify({
        signals: [
          {
            signal_kind: "potential_claim",
            object_kind: "decision",
            confidence: 0.7,
            matched_text: "We decided to ship on Friday"
          },
          {
            signal_kind: "potential_preference",
            object_kind: "user_preference",
            confidence: 0.8,
            matched_text: "Call me Ash",
            distilled_fact: "The operator prefers to be called Ash."
          }
        ]
      }));
      // The first generated signal_id is empty, which CandidateMemorySignalSchema
      // rejects. Without the per-signal guard in compile() that one bad signal
      // would reject the whole compile() and lose every fact of the turn.
      let counter = 0;
      const provider = new OfficialApiGardenProvider({
        apiKey: "sk-test",
        extractor,
        generateSignalId: () => (counter++ === 0 ? "" : "signal-good")
      });

      const signals = await provider.compile("turn text", createContext());
      expect(signals).toHaveLength(1);
      expect(signals[0]!.signal_id).toBe("signal-good");
      expect(signals[0]!.signal_kind).toBe("potential_preference");
      expect(warn).toHaveBeenCalledWith(
        "garden/compute-provider: dropped one official-API signal",
        expect.objectContaining({ runId: "run-1", signalKind: "potential_claim" })
      );
    } finally {
      warn.mockRestore();
    }
  });


  it("keeps the turn's good signals when one entry's model JSON is malformed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Five signals, one malformed: a hallucinated signal_kind. A throwing
      // parse would abort the whole turn (GardenProviderError out of
      // compile()); per-entry resilience must drop the one bad fact and keep
      // the four good ones.
      const extractor = createExtractor(JSON.stringify({
        signals: [
          {
            signal_kind: "potential_preference",
            object_kind: "user_preference",
            confidence: 0.9,
            matched_text: "Call me Ash",
            distilled_fact: "The operator prefers to be called Ash."
          },
          {
            signal_kind: "definitely_not_a_kind",
            object_kind: "decision",
            confidence: 0.8,
            matched_text: "We decided to ship on Friday",
            distilled_fact: "The team decided to ship on Friday."
          },
          {
            signal_kind: "potential_claim",
            object_kind: "decision",
            confidence: 0.7,
            matched_text: "We picked Postgres",
            distilled_fact: "The team chose Postgres as the database."
          },
          {
            signal_kind: "potential_claim",
            object_kind: "fact",
            confidence: 0.6,
            matched_text: "The build runs nightly",
            distilled_fact: "The CI build runs nightly."
          },
          {
            signal_kind: "potential_preference",
            object_kind: "user_preference",
            confidence: 0.55,
            matched_text: "I prefer dark mode",
            distilled_fact: "The operator prefers dark mode in the editor."
          }
        ]
      }));
      const provider = new OfficialApiGardenProvider({
        apiKey: "sk-test",
        extractor,
        generateSignalId: (() => {
          let counter = 0;
          return () => `signal-${++counter}`;
        })()
      });

      const signals = await provider.compile("turn text", createContext());
      expect(signals).toHaveLength(4);
      expect(signals.map((s) => s.object_kind)).toEqual([
        "user_preference",
        "decision",
        "fact",
        "user_preference"
      ]);
    } finally {
      warn.mockRestore();
    }
  });


  it("still fails the turn hard when the response envelope itself is malformed", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({ not_signals: [] }))
    });

    await expect(provider.compile("turn text", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "invalid_response"
    } satisfies Partial<GardenProviderError>);
  });


  it("drops an oversized raw_payload signal while the turn's other signals survive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A long matched_text overflows the 16 KB BoundedJsonObject cap on
      // raw_payload: schema-grounding triplicates it (matched_text +
      // field_candidates value + evidence), and buildTurnExcerpt adds an
      // excerpt of comparable length on the match-found path. The clamps do
      // not save it. The bad signal must be dropped and the rest survive.
      const oversizedMatched = "z".repeat(4_000);
      const turnContent = `${oversizedMatched} and we deploy on Tuesdays`;
      const extractor = createExtractor(JSON.stringify({
        signals: [
          {
            signal_kind: "potential_claim",
            object_kind: "fact",
            confidence: 0.7,
            matched_text: oversizedMatched,
            distilled_fact: "x".repeat(500)
          },
          {
            signal_kind: "potential_preference",
            object_kind: "user_preference",
            confidence: 0.8,
            matched_text: "we deploy on Tuesdays",
            distilled_fact: "The team deploys releases on Tuesdays."
          }
        ]
      }));
      const provider = new OfficialApiGardenProvider({
        apiKey: "sk-test",
        extractor,
        generateSignalId: (() => {
          let counter = 0;
          return () => `signal-${++counter}`;
        })()
      });

      const signals = await provider.compile(turnContent, createContext());
      expect(signals).toHaveLength(1);
      expect(signals[0]!.signal_kind).toBe("potential_preference");
      expect(warn).toHaveBeenCalledWith(
        "garden/compute-provider: dropped one official-API signal",
        expect.objectContaining({ matchedTextChars: 4_000 })
      );
    } finally {
      warn.mockRestore();
    }
  });

});
