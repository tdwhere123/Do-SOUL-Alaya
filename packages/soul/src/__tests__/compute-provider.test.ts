import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CustomApiGardenProvider,
  GardenProviderError,
  GardenProviderKind,
  LocalModelGardenProvider,
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiGardenProvider
} from "../garden/compute-provider.js";
import { SignalExtractorError, type SignalExtractor } from "../garden/pi-mono-extractor.js";
import { DISTILLED_FACT_MAX_CHARS } from "../garden/materialization-router.js";

describe("OfficialApiGardenProvider", () => {
  it("materializes candidate signals from a successful official API response", async () => {
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

  it("emits a per-turn count when the model omits distilled_fact", async () => {
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
      "The operator prefers dark mode in the editor.",
      "The team deploys releases on Tuesdays."
    ]);
  });

  it("clamps an oversized distilled_fact to the field cap", async () => {
    const oversized = "y".repeat(10_000);
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_claim",
          object_kind: "fact",
          confidence: 0.6,
          matched_text: "fact text",
          distilled_fact: oversized
        }
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      generateSignalId: () => "signal-clamp"
    });

    const signals = await provider.compile("fact text", createContext());
    expect((signals[0]!.raw_payload as { distilled_fact: string }).distilled_fact.length).toBe(
      DISTILLED_FACT_MAX_CHARS
    );
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

  it("caps the signal count and clamps oversized fields from an official API response", async () => {
    const oversizedMatchedText = "x".repeat(10_000);
    const oversizedObjectKind = "k".repeat(1_000);
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      now: () => "2026-04-23T09:00:00.000Z",
      generateSignalId: () => "signal-capped",
      extractor: createExtractor(
        JSON.stringify({
          signals: Array.from({ length: 200 }, () => ({
            signal_kind: "potential_preference",
            object_kind: oversizedObjectKind,
            confidence: 0.5,
            matched_text: oversizedMatchedText,
            reason: "r".repeat(1_000)
          }))
        })
      )
    });

    const signals = await provider.compile("Call me Ash.", createContext());
    expect(signals).toHaveLength(64);
    expect(signals[0]!.object_kind.length).toBe(200);
    expect((signals[0]!.raw_payload as { matched_text: string }).matched_text.length).toBe(4_000);
    expect((signals[0]!.raw_payload as { extraction_reason: string }).extraction_reason.length).toBe(400);
  });

  it("surfaces the custom API stub as a typed provider failure", async () => {
    const provider = new CustomApiGardenProvider();

    await expect(provider.compile()).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "provider_failure",
      message: "CustomApiGardenProvider is not implemented in Phase 0.5."
    } satisfies Partial<GardenProviderError>);
  });

  it("surfaces the local model stub as a typed provider failure", async () => {
    const provider = new LocalModelGardenProvider();

    await expect(provider.compile()).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "provider_failure",
      message: "LocalModelGardenProvider is not implemented in Phase 0.5."
    } satisfies Partial<GardenProviderError>);
  });
});

// Phase A.1 instrument coverage: an invalid_response failure must drop one
// diagnostic JSON file in the configured dump dir BEFORE the exception
// propagates. Read-only observation: the original GardenProviderError still
// throws, the dump never recovers the call, the blocker still trips.
describe("OfficialApiGardenProvider diagnostic dump (Phase A.1 instrument)", () => {
  let diagnosticDir: string;

  beforeEach(() => {
    diagnosticDir = mkdtempSync(join(tmpdir(), "garden-diagnostic-"));
  });

  afterEach(() => {
    rmSync(diagnosticDir, { recursive: true, force: true });
  });

  it("dumps a diagnostic envelope when the model returns a malformed signals shape", async () => {
    const extractor: SignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"not_signals":[]}' }))
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      model: "gpt-test-mini",
      endpoint: "https://example.test/v1",
      extractor,
      diagnosticDir,
      now: () => "2026-05-27T12:00:00.000Z"
    });

    // The original failure must still propagate — instrument is observation.
    await expect(
      provider.compile("Call me Ash.", createContext())
    ).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "invalid_response"
    } satisfies Partial<GardenProviderError>);

    const files = readdirSync(diagnosticDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const dump = JSON.parse(
      readFileSync(join(diagnosticDir, files[0]!), "utf8")
    ) as Record<string, unknown>;

    // Schema must carry every field a Phase A.2 preflight reader expects.
    expect(dump).toMatchObject({
      captured_at: "2026-05-27T12:00:00.000Z",
      provider_kind: GardenProviderKind.OFFICIAL_API,
      model_id: "gpt-test-mini",
      endpoint: "https://example.test/v1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: "surface-1",
      response_body_total_chars: 18
    });
    expect(typeof dump.response_body_prefix).toBe("string");
    expect((dump.response_body_prefix as string).startsWith('{"not_signals"')).toBe(true);
    expect(typeof dump.user_prompt_prefix).toBe("string");
    expect((dump.user_prompt_prefix as string).length).toBeLessThanOrEqual(512);
  });

  it("dumps a diagnostic envelope when the extractor reports invalid_json", async () => {
    const extractor: SignalExtractor = {
      extract: vi.fn(async () => {
        throw new SignalExtractorError(
          "invalid_json",
          "Signal extractor returned no text content."
        );
      })
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      model: "gpt-test-mini",
      extractor,
      diagnosticDir,
      now: () => "2026-05-27T12:30:00.000Z"
    });

    await expect(
      provider.compile("Call me Ash.", createContext())
    ).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "invalid_response"
    } satisfies Partial<GardenProviderError>);

    const files = readdirSync(diagnosticDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const dump = JSON.parse(
      readFileSync(join(diagnosticDir, files[0]!), "utf8")
    ) as Record<string, unknown>;
    expect(dump.signal_extractor_error).toMatchObject({
      is_signal_extractor_error: true,
      kind: "invalid_json",
      name: "SignalExtractorError"
    });
    // No raw body was captured because the extractor threw before returning.
    expect(dump.response_body_prefix).toBeNull();
    expect(dump.response_body_total_chars).toBeNull();
  });

  it("does not dump when diagnosticDir is explicitly null and skips network errors", async () => {
    // diagnosticDir: null — instrument disabled, fs untouched.
    const nullDirProvider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: { extract: vi.fn(async () => ({ rawJson: '{"not_signals":[]}' })) },
      diagnosticDir: null
    });
    await expect(
      nullDirProvider.compile("Call me Ash.", createContext())
    ).rejects.toMatchObject({ name: "GardenProviderError", kind: "invalid_response" });
    // diagnosticDir untouched (still empty from beforeEach).
    expect(readdirSync(diagnosticDir).filter((f) => f.endsWith(".json"))).toHaveLength(0);

    // Network/timeout errors are NOT invalid_response — no dump expected.
    const timeoutProvider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: vi.fn(async () => {
          throw new SignalExtractorError("timeout", "Signal extractor request timed out.");
        })
      },
      diagnosticDir
    });
    await expect(
      timeoutProvider.compile("Call me Ash.", createContext())
    ).rejects.toMatchObject({ name: "GardenProviderError", kind: "network" });
    expect(readdirSync(diagnosticDir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });
});

function createContext() {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface-1",
    turn_messages: [
      {
        role: "user" as const,
        content: "Call me Ash.",
        message_id: "message-1",
        created_at: "2026-04-23T09:00:00.000Z"
      }
    ]
  };
}

function createExtractor(rawJson: string): SignalExtractor {
  return {
    extract: vi.fn(async () => ({ rawJson }))
  };
}
