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
  createExtractor,
  openSignal
} from "./compute-provider-fixtures.js";

function createContext(turnContent?: string) {
  return {
    ...createBaseContext(),
    turn_messages: turnContent === undefined ? [] : [{
      message_id: "user-1",
      role: "user" as const,
      content: turnContent
    }],
    allow_legacy_single_user_source: true
  };
}

describe("OfficialApiGardenProvider", () => {  it("accepts open signals without distilled_fact", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const extractor = createExtractor(JSON.stringify({
        signals: [
          openSignal({
            signal_kind: "potential_claim",
            object_kind: "decision",
            confidence: 0.7,
            matched_text: "We decided to ship on Friday"
          }),
          openSignal({
            signal_kind: "potential_preference",
            object_kind: "user_preference",
            confidence: 0.8,
            matched_text: "Call me Ash",
            distilled_fact: "The operator prefers to be called Ash."
          }, 2),
          openSignal({
            signal_kind: "potential_claim",
            object_kind: "fact",
            confidence: 0.6,
            matched_text: "The build runs nightly"
          }, 3)
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

      const turn = "We decided to ship on Friday. Call me Ash. The build runs nightly.";
      const signals = await provider.compile(turn, createContext(turn));
      expect(signals).toHaveLength(3);
      expect(warn).not.toHaveBeenCalledWith(
        "garden/compute-provider: official-API drafts missing distilled_fact",
        expect.anything()
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("emits one atomic signal per fact when the model splits a compound turn", async () => {
    const extractor = createExtractor(JSON.stringify({
      signals: [
        openSignal({
          signal_kind: "potential_preference",
          object_kind: "user_preference",
          confidence: 0.8,
          matched_text: "I prefer dark mode",
          distilled_fact: "The operator prefers dark mode in the editor."
        }),
        openSignal({
          signal_kind: "potential_claim",
          object_kind: "decision",
          confidence: 0.75,
          matched_text: "we deploy on Tuesdays",
          distilled_fact: "The team deploys releases on Tuesdays."
        }, 2)
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

    const turn = "I prefer dark mode, and we deploy on Tuesdays.";
    const signals = await provider.compile(turn, createContext(turn));
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => (s.raw_payload as { distilled_fact: string }).distilled_fact)).toEqual([
      "I prefer dark mode, and we deploy on Tuesdays.",
      "we deploy on Tuesdays."
    ]);
  });


  it("keeps oversized model paraphrases out of durable content", async () => {
    const oversized = "y".repeat(10_000);
    const extractor = createExtractor(JSON.stringify({
      signals: [
        openSignal({
          signal_kind: "potential_claim",
          object_kind: "fact",
          confidence: 0.6,
          matched_text: "The fact is grounded.",
          distilled_fact: oversized
        })
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      generateSignalId: () => "signal-clamp"
    });

    const signals = await provider.compile(
      "The fact is grounded.", createContext("The fact is grounded.")
    );
    expect(signals[0]!.raw_payload.distilled_fact).toBe("The fact is grounded.");
    expect((signals[0]!.raw_payload.source_grounding as {
      proposed_distilled_fact: string;
    }).proposed_distilled_fact.length).toBe(DISTILLED_FACT_MAX_CHARS);
  });


  it("passes only canonical User assertions to the signal extractor", async () => {
    const extractor = createExtractor(JSON.stringify({ signals: [] }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor
    });

    await expect(provider.compile("Call me Ash.", createContext())).resolves.toEqual([]);

    expect(JSON.parse(vi.mocked(extractor.extract).mock.calls[0]![0].userPrompt)).toEqual({
      schema_version: 2,
      source_locator_contract_version: 2,
      batch_contract_version: 1,
      source_corpus_identity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      batch_index: 0,
      batch_count: 1,
      source_assertions: [{ assertion_id: 1, text: "User: Call me Ash." }]
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

    await expect(provider.compile("Call me Ash.", createContext())).resolves.toEqual([]);
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

  it("keeps historical graphless parsing readable and admits it under identities-only", async () => {
    const graphlessRaw = JSON.stringify({
      signals: [{
        signal_kind: "potential_claim",
        object_kind: "fact",
        confidence: 0.8,
        matched_text: "The build is green.",
        source_locator: {
          contract_version: 2,
          kind: "assertion_catalog",
          assertion_id: 1
        }
      }]
    });
    const [historicalDraft] = parseOfficialApiSignals(graphlessRaw);
    expect(historicalDraft?.semantic_factor_graph_projection).toEqual({
      status: "unavailable",
      reason: "semantic_factor_graph_missing"
    });

    const graphless = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(graphlessRaw)
    });
    const graphlessSignals = await graphless.compile(
      "The build is green.", createContext("The build is green.")
    );
    expect(graphlessSignals.length).toBeGreaterThan(0);
    expect(graphlessSignals[0]?.raw_payload).toMatchObject({
      semantic_factor_graph_projection: {
        status: "unavailable",
        reason: "semantic_factor_graph_missing"
      }
    });

    const graphful = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({
        signals: [{
          signal_kind: "potential_possession",
          object_kind: "physical_item",
          confidence: 0.8,
          matched_text: "The build is green.",
          source_locator: {
            contract_version: 2,
            kind: "assertion_catalog",
            assertion_id: 1
          },
          semantic_factor_graph: {
            schema_version: 1,
            source_kind: "evidence",
            factors: [{
              factor_id: "f0",
              surface: "green",
              semantic_identity: "green"
            }],
            variables: [],
            result_variable_ids: [],
            propositions: [{
              proposition_id: "p0",
              predicate_factor_id: "f0",
              arguments: [{
                position: 0,
                binding_identity: "value",
                reference_kind: "factor",
                reference_id: "f0"
              }]
            }]
          }
        }]
      }))
    });
    const signals = await graphful.compile(
      "The build is green.", createContext("The build is green.")
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signal_kind: "potential_semantic_observation",
      object_kind: "open_semantic_observation",
      raw_payload: {
        object_kind_projection: {
          status: "rejected",
          reason: "object_kind_not_allowed",
          proposed_object_kind: "physical_item"
        }
      }
    });
  });

  it("rejects a locator outside the current bounded assertion batch", async () => {
    let requestIndex = 0;
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: vi.fn(async () => ({
          rawJson: requestIndex++ === 0
            ? '{"signals":[]}'
            : JSON.stringify({ signals: [openSignal({
              matched_text: "I recorded durable detail number 1.",
              confidence: 0.8
            })] })
        }))
      }
    });
    const source = Array.from(
      { length: 9 },
      (_, index) => `I recorded durable detail number ${index + 1}.`
    ).join(" ");

    await expect(provider.compile(source, createContext())).rejects.toMatchObject({
      kind: "invalid_response"
    });
  });

  it("keeps a valid signal beside an invalid sibling", () => {
    const drafts = parseOfficialApiSignals(JSON.stringify({ signals: [42, openSignal({
      signal_kind: "potential_preference",
      object_kind: "user_preference",
      confidence: 0.9,
      matched_text: "Call me Ash",
      distilled_fact: "The operator prefers to be called Ash."
    })] }));

    expect(drafts).toHaveLength(1);
  });

  it("projects allowed object kinds and rejects unknown routing metadata", () => {
    const drafts = parseOfficialApiSignals(JSON.stringify({ signals: [
      openSignal({ object_kind: "preference", confidence: 0.8, matched_text: "I prefer tea." }),
      openSignal({ object_kind: "decision", confidence: 0.8, matched_text: "I chose tea." }),
      openSignal({ object_kind: "user_preference", confidence: 0.8, matched_text: "Call me Ash." })
    ] }));

    expect(drafts[0]).toMatchObject({
      signal_kind: "potential_preference",
      object_kind: "preference"
    });
    expect(drafts[1]).toMatchObject({
      signal_kind: "potential_claim",
      object_kind: "decision"
    });
    expect(drafts[2]).toMatchObject({
      signal_kind: "potential_semantic_observation",
      object_kind: "open_semantic_observation",
      object_kind_projection: {
        status: "rejected",
        reason: "object_kind_not_allowed",
        proposed_object_kind: "user_preference"
      }
    });
  });

  it("normalizes canonical decimal confidence strings and rejects other text", () => {
    const drafts = parseOfficialApiSignals(JSON.stringify({ signals: [openSignal({
      signal_kind: "potential_claim",
      object_kind: "fact",
      confidence: "0.95",
      matched_text: "The release is on Friday."
    }), openSignal({
      signal_kind: "potential_claim",
      object_kind: "fact",
      confidence: "95%",
      matched_text: "The release is on Friday."
    })] }));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe(0.95);
  });


  it("caps the signal count and clamps oversized parsed fields", () => {
    const oversizedMatchedText = "x".repeat(10_000);
    const oversizedObjectKind = "k".repeat(1_000);
    const drafts = parseOfficialApiSignals(JSON.stringify({
      signals: Array.from({ length: 200 }, () => openSignal({
        signal_kind: "potential_preference",
        object_kind: oversizedObjectKind,
        confidence: 0.5,
        matched_text: oversizedMatchedText,
        reason: "r".repeat(1_000)
      }))
    }));

    expect(drafts).toHaveLength(64);
    expect(drafts[0]!.object_kind).toBe("open_semantic_observation");
    expect(drafts[0]!.matched_text.length).toBe(4_000);
    expect(drafts[0]!.reason).toHaveLength(400);
  });

});
