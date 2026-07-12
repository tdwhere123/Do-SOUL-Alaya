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
          distilled_fact: "Call me Ash.",
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
          matched_text: "Call me Ash.",
          distilled_fact: "Call me Ash.",
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
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("evidence_refs");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("source_memory_refs");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("temporal_projection");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Preserve relative-date wording");
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain("Resolve every pronoun, relative date");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("preference_profile");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("projection_schema_version");
  });

  it("carries official synthesis evidence and source refs into first-class signal fields", async () => {
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_synthesis",
          object_kind: "synthesis",
          confidence: 0.74,
          matched_text: "The rollout summary connects the launch owner evidence.",
          distilled_fact: "The launch owner evidence resolves to Mira.",
          evidence_refs: ["evidence-1", " evidence-2 ", "evidence-1", ""],
          source_memory_refs: ["memory-source-1", " memory-source-2 ", "memory-source-1", ""]
        }
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      generateSignalId: () => "signal-synthesis"
    });

    const signals = await provider.compile(
      "The rollout summary connects the launch owner evidence.",
      createContext()
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signal_kind: "potential_synthesis",
      object_kind: "synthesis",
      evidence_refs: ["evidence-1", "evidence-2"],
      source_memory_refs: ["memory-source-1", "memory-source-2"]
    });
  });


  it("derives a source assertion when a signal omits distilled_fact", async () => {
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
    expect(signals[0]!.raw_payload.distilled_fact).toBe("We decided to ship on Friday.");
  });

  it("preserves official temporal projection metadata on the raw payload", async () => {
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_claim",
          object_kind: "fact",
          confidence: 0.7,
          matched_text: "The deployment happened on 2026-03-19.",
          distilled_fact: "The deployment happened on 2026-03-19.",
          temporal_projection: {
            projection_schema_version: 1,
            event_time_start: "2026-03-19",
            event_time_end: "2026-03-20",
            valid_from: "2026-03-19",
            valid_to: "2026-03-20",
            time_precision: "day",
            time_source: "explicit",
            ignored_field: "drop me"
          }
        }
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      generateSignalId: () => "signal-temporal"
    });

    const signals = await provider.compile("The deployment happened on 2026-03-19.", createContext());

    expect(signals[0]!.raw_payload).toMatchObject({
      temporal_projection: {
        projection_schema_version: 1,
        event_time_start: "2026-03-19T00:00:00.000Z",
        event_time_end: "2026-03-19T23:59:59.999Z",
        time_precision: "day",
        time_source: "explicit"
      }
    });
    expect(
      "ignored_field" in
        (signals[0]!.raw_payload.temporal_projection as Record<string, unknown>)
    ).toBe(false);
  });

  it("drops an invalid official temporal projection atomically", async () => {
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_claim",
          object_kind: "fact",
          confidence: 0.7,
          matched_text: "The impossible date was 2026-02-31.",
          distilled_fact: "The impossible date was 2026-02-31.",
          temporal_projection: {
            projection_schema_version: 1,
            event_time_start: "2026-02-31",
            event_time_end: "2026-03-01",
            time_precision: "day",
            time_source: "explicit"
          }
        }
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      generateSignalId: () => "signal-invalid-date"
    });

    const signals = await provider.compile("The impossible date was 2026-02-31.", createContext());

    expect(signals[0]!.raw_payload).not.toHaveProperty("temporal_projection");
  });

  it("keeps an unverified preference profile only in the grounding audit", async () => {
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_preference",
          object_kind: "preference",
          confidence: 0.8,
          matched_text: "I prefer dark mode.",
          distilled_fact: "The operator prefers dark mode.",
          preference_profile: {
            projection_schema_version: 1,
            subject: "operator",
            predicate: "prefer",
            object: "dark mode",
            category: "theme",
            polarity: "positive",
            ignored_field: "drop me"
          }
        }
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      generateSignalId: () => "signal-profile"
    });

    const signals = await provider.compile("I prefer dark mode.", createContext());

    expect(signals[0]!.raw_payload).not.toHaveProperty("preference_profile");
    expect(signals[0]!.raw_payload.source_grounding).toMatchObject({
      proposed_preference_profile: {
        projection_schema_version: 1,
        preference_subject: "operator",
        preference_predicate: "prefer",
        preference_object: "dark mode",
        preference_category: "theme",
        preference_polarity: "positive"
      }
    });
    expect(
      "ignored_field" in
        ((signals[0]!.raw_payload.source_grounding as Record<string, unknown>)
          .proposed_preference_profile as Record<string, unknown>)
    ).toBe(false);
  });


  it("derives source assertions when distilled_fact is not a string", async () => {
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

    const signals = await provider.compile(
      "We decided to ship on Friday. We picked Postgres.",
      createContext()
    );
    expect(signals).toHaveLength(2);
    expect(signals.map((signal) => signal.raw_payload.distilled_fact)).toEqual([
      "We decided to ship on Friday.",
      "We picked Postgres."
    ]);
  });


  it("derives a source assertion when distilled_fact is empty", async () => {
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
    expect(signals[0]!.raw_payload.distilled_fact).toBe("We decided to ship on Friday.");
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

      const signals = await provider.compile(
        "We decided to ship on Friday. Call me Ash.",
        createContext()
      );
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

      const signals = await provider.compile(
        "Call me Ash. We decided to ship on Friday. We picked Postgres. " +
          "The build runs nightly. I prefer dark mode.",
        createContext()
      );
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
      const turnContent = `${oversizedMatched}. We deploy on Tuesdays.`;
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
            matched_text: "We deploy on Tuesdays.",
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
