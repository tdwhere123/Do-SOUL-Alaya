import { describe, expect, it, vi } from "vitest";
import {
  GardenProviderError,
  OfficialApiGardenProvider,
  parseOfficialApiSignals
} from "../../garden/compute-provider.js";
import {
  SignalExtractorError} from "../../garden/pi-mono-extractor.js";
import { DISTILLED_FACT_MAX_CHARS } from "../../garden/materialization-router.js";

import {
  createContext as createBaseContext,
  createExtractor
} from "./compute-provider-fixtures.js";

function createContext() {
  return {
    ...createBaseContext(),
    turn_messages: [],
    allow_legacy_single_user_source: true
  };
}

describe("OfficialApiGardenProvider", () => {  it("emits a per-turn count when the model omits distilled_fact", async () => {
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
          },
          {
            signal_kind: "potential_claim",
            object_kind: "fact",
            confidence: 0.6,
            matched_text: "The build runs nightly"
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
      expect(signals).toHaveLength(3);
      expect(warn).toHaveBeenCalledWith(
        "garden/compute-provider: official-API drafts missing distilled_fact",
        expect.objectContaining({ runId: "run-1", omittedCount: 2, draftCount: 3 })
      );
    } finally {
      warn.mockRestore();
    }
  });


  it("emits one atomic signal per fact when the model splits a compound turn", async () => {
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_preference",
          object_kind: "user_preference",
          confidence: 0.8,
          matched_text: "I prefer dark mode",
          distilled_fact: "The operator prefers dark mode in the editor."
        },
        {
          signal_kind: "potential_claim",
          object_kind: "decision",
          confidence: 0.75,
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

    const signals = await provider.compile(
      "I prefer dark mode, and we deploy on Tuesdays.",
      createContext()
    );
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => (s.raw_payload as { distilled_fact: string }).distilled_fact)).toEqual([
      "I prefer dark mode",
      "we deploy on Tuesdays."
    ]);
  });


  it("keeps oversized model paraphrases out of durable content", async () => {
    const oversized = "y".repeat(10_000);
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_claim",
          object_kind: "fact",
          confidence: 0.6,
          matched_text: "The fact is grounded.",
          distilled_fact: oversized
        }
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      generateSignalId: () => "signal-clamp"
    });

    const signals = await provider.compile("The fact is grounded.", createContext());
    expect(signals[0]!.raw_payload.distilled_fact).toBe("The fact is grounded.");
    expect((signals[0]!.raw_payload.source_grounding as {
      proposed_distilled_fact: string;
    }).proposed_distilled_fact.length).toBe(DISTILLED_FACT_MAX_CHARS);
  });


  it("passes structured turn content to the signal extractor", async () => {
    const extractor = createExtractor(JSON.stringify({ signals: [] }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor
    });

    await expect(provider.compile("No durable memory here.", createContext())).resolves.toEqual([]);

    expect(JSON.parse(vi.mocked(extractor.extract).mock.calls[0]![0].userPrompt)).toMatchObject({
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: "surface-1",
      turn_content: "No durable memory here."
    });
  });


  it("fails closed when official provider credentials are missing", async () => {
    const extractor = createExtractor(JSON.stringify({ signals: [] }));
    const provider = new OfficialApiGardenProvider({
      extractor
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "auth",
      message: "Official garden provider credentials are missing."
    });
    expect(extractor.extract).not.toHaveBeenCalled();
  });


  it("permits only an explicitly injected cache-only extractor without credentials", async () => {
    const extractor = createExtractor(JSON.stringify({ signals: [] }));
    const provider = new OfficialApiGardenProvider({
      extractor,
      injectedExtractorCapability: "cache_only"
    });

    await expect(provider.compile("No durable memory here.", createContext())).resolves.toEqual([]);
    expect(extractor.extract).toHaveBeenCalledOnce();
  });


  it("surfaces extractor transport failures as network errors", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: vi.fn(async () => {
          throw new SignalExtractorError("transport_failure", "Signal extractor request failed.");
        })
      }
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "network",
      message: "Signal extractor request failed."
    } satisfies Partial<GardenProviderError>);
  });


  it("surfaces timed out extractor requests as network errors with the timeout message", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      requestTimeoutMs: 321,
      extractor: {
        extract: vi.fn(async () => {
          throw new SignalExtractorError("timeout", "Signal extractor request timed out after 321ms.");
        })
      }
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "network",
      message: "Signal extractor request timed out after 321ms."
    } satisfies Partial<GardenProviderError>);
  });


  it("rejects invalid official API payloads", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({
        signals: "not-an-array"
      }))
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "invalid_response",
      message: "Official garden provider returned an invalid response."
    } satisfies Partial<GardenProviderError>);
  });

  it("rejects a non-empty signals array when every entry is invalid", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({ signals: [42] }))
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "invalid_response"
    } satisfies Partial<GardenProviderError>);
  });

  it("keeps a valid signal beside an invalid sibling", () => {
    const drafts = parseOfficialApiSignals(JSON.stringify({ signals: [42, {
      signal_kind: "potential_preference",
      object_kind: "user_preference",
      confidence: 0.9,
      matched_text: "Call me Ash",
      distilled_fact: "The operator prefers to be called Ash."
    }] }));

    expect(drafts).toHaveLength(1);
  });


  it("caps the signal count and clamps oversized parsed fields", () => {
    const oversizedMatchedText = "x".repeat(10_000);
    const oversizedObjectKind = "k".repeat(1_000);
    const drafts = parseOfficialApiSignals(JSON.stringify({
      signals: Array.from({ length: 200 }, () => ({
        signal_kind: "potential_preference",
        object_kind: oversizedObjectKind,
        confidence: 0.5,
        matched_text: oversizedMatchedText,
        reason: "r".repeat(1_000)
      }))
    }));

    expect(drafts).toHaveLength(64);
    expect(drafts[0]!.object_kind.length).toBe(200);
    expect(drafts[0]!.matched_text.length).toBe(4_000);
    expect(drafts[0]!.reason).toHaveLength(400);
  });

});
