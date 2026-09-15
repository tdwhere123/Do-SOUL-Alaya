import { describe, expect, it, vi } from "vitest";
import {
  GardenProviderError,
  OfficialApiGardenCompileIncompleteError,
  OfficialApiGardenProvider,
  parseOfficialApiSignals
} from "../../../garden/ingestion/compute-provider.js";
import {
  SignalExtractorError} from "../../../garden/extraction/pi-mono-extractor.js";

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

describe("OfficialApiGardenProvider", () => {
  it("historical parser accepts open signals without distilled_fact", () => {
    const drafts = parseOfficialApiSignals(JSON.stringify({
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
    expect(drafts).toHaveLength(3);
  });

  it("historical parser keeps sibling drafts when one entry is malformed", () => {
    const drafts = parseOfficialApiSignals(JSON.stringify({
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
          matched_text: "we use TypeScript",
          distilled_fact: "The team uses TypeScript."
        }, 2)
      ]
    }));
    expect(drafts).toHaveLength(2);
  });


  it("passes only canonical User assertions to the signal extractor", async () => {
    const extractor = createExtractor('{"interpretations":[]}');
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor
    });

    await expect(provider.compile("Call me Ash.", createContext())).resolves.toEqual([]);

    expect(JSON.parse(vi.mocked(extractor.extract).mock.calls[0]![0].userPrompt)).toEqual({
      schema_version: 2,
      source_locator_contract_version: 4,
      batch_contract_version: 1,
      source_corpus_identity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      batch_index: 0,
      batch_count: 1,
      source_assertions: [{ assertion_id: 1, text: "User: Call me Ash." }]
    });
  });


  it("fails closed when official provider credentials are missing", async () => {
    const extractor = createExtractor('{"interpretations":[]}');
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
    const extractor = createExtractor('{"interpretations":[]}');
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
      name: "OfficialApiGardenCompileIncompleteError",
      kind: "invalid_response",
      signals: []
    });
  });

  it("rejects a non-empty signals array when every entry is invalid", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({ signals: [42] }))
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "OfficialApiGardenCompileIncompleteError",
      kind: "invalid_response",
      signals: []
    });
  });

  it("keeps historical graphless parsing readable and admits it under identities-only", async () => {
    const graphlessRaw = JSON.stringify({
      signals: [{
        signal_kind: "potential_claim",
        object_kind: "fact",
        confidence: 0.8,
        matched_text: "The build is green.",
        source_locator: {
          contract_version: 4,
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
  });

  it("does not leak an out-of-batch assertion into located candidates", async () => {
    const turn = "I own a blue bicycle. I prefer coffee in the morning.";
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: vi.fn(async () => ({
          rawJson: JSON.stringify({
            interpretations: [
              {
                assertion_id: 1,
                relations: [{ predicate: { text: "own" }, arguments: [], qualifiers: [] }]
              },
              {
                assertion_id: 9,
                relations: [{ predicate: { text: "prefer" }, arguments: [], qualifiers: [] }]
              }
            ]
          })
        }))
      },
      generateSignalId: () => "signal-partial"
    });
    const signals = await provider.compile(turn, createContext(turn));
    expect(signals).toHaveLength(1);
    expect(signals.every((signal) =>
      signal.raw_payload.source_interpretation.assertion_binding.assertion_id !== 9
    )).toBe(true);
  });

  it("emits only candidate siblings when a later assertion fails to locate", async () => {
    const turn = "Alice uses tools. Bob invented widgets.";
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: vi.fn(async () => ({
          rawJson: JSON.stringify({
            interpretations: [
              {
                assertion_id: 1,
                relations: [{ predicate: { text: "uses" }, arguments: [], qualifiers: [] }]
              },
              {
                assertion_id: 2,
                relations: [{ predicate: { text: "missing-phrase" }, arguments: [], qualifiers: [] }]
              }
            ]
          })
        }))
      },
      generateSignalId: () => "signal-mixed"
    });
    const signals = await provider.compile(turn, createContext(turn));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.raw_payload.source_interpretation.outcome).toBe("candidates");
    expect(signals[0]?.raw_payload.source_interpretation.assertion_binding.assertion_id).toBe(1);
  });

  it.each([
    ["transport_failure", "Signal extractor request failed."],
    ["timeout", "Signal extractor request timed out after 321ms."]
  ] as const)("keeps earlier-batch drafts when a later batch fails with %s", async (kind, message) => {
    const source = Array.from(
      { length: 9 },
      (_, index) => `I recorded durable detail number ${index + 1}.`
    ).join(" ");
    const extractor = {
      extract: vi.fn(async (input: { readonly userPrompt: string }) => {
        const request = JSON.parse(input.userPrompt) as { readonly batch_index: number };
        if (request.batch_index === 0) {
          return {
            rawJson: JSON.stringify({
              interpretations: [{
                assertion_id: 1,
                relations: [{ predicate: { text: "recorded" }, arguments: [], qualifiers: [] }]
              }]
            })
          };
        }
        throw new SignalExtractorError(kind, message);
      })
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      generateSignalId: () => "signal-batch-0"
    });

    await expect(provider.compile(source, createContext(source))).rejects.toMatchObject({
      name: "OfficialApiGardenCompileIncompleteError",
      signals: [expect.objectContaining({
        interpretation_contract: "source-interpretation-v1",
        raw_payload: expect.objectContaining({
          source_interpretation: expect.objectContaining({
            outcome: "candidates",
            assertion_binding: expect.objectContaining({ assertion_id: 1 })
          })
        })
      })],
      receipt: expect.objectContaining({
        status: "partial",
        producer: "official-api-garden-compile-v1",
        pending_batches: [expect.objectContaining({
          batch_index: 1,
          assertion_ids: expect.arrayContaining([expect.any(Number)])
        })]
      })
    } satisfies Partial<OfficialApiGardenCompileIncompleteError>);
    expect(extractor.extract).toHaveBeenCalledTimes(2);
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
