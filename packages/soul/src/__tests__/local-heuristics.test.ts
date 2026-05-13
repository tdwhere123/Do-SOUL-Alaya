import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateMemorySignalSchema, SignalSource } from "@do-soul/alaya-protocol";
import type { GardenCompileContext } from "../garden/compute-provider.js";
import { LocalHeuristics } from "../garden/local-heuristics.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.useRealTimers();
});

describe("LocalHeuristics", () => {
  it("extracts a preference signal from stable preference phrasing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:20:30.000Z"));
    const provider = new LocalHeuristics();

    const signals = await provider.compile(
      "I always use TypeScript strict mode for application code.",
      createContext()
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_kind: "potential_preference",
      object_kind: "preference",
      confidence: expect.any(Number),
      domain_tags: [],
      evidence_refs: [],
      created_at: "2026-03-18T10:20:30.000Z",
      raw_payload: expect.objectContaining({
        pattern_category: "preference",
        matched_text: "I always use TypeScript strict mode for application code.",
        schema_grounding: expect.objectContaining({ status: "valid" }),
        detected_object: expect.objectContaining({ object_kind: "preference" }),
        validation_result: expect.objectContaining({ status: "valid" })
      })
    });
    expect(signals[0].raw_payload.field_candidates).toEqual([
      {
        field_name: "preference",
        value: "I always use TypeScript strict mode for application code.",
        evidence: "I always use TypeScript strict mode for application code.",
        confidence: 0.6
      }
    ]);
    expect(UUID_PATTERN.test(signals[0].signal_id)).toBe(true);
    expect(CandidateMemorySignalSchema.parse(signals[0])).toEqual(signals[0]);
  });

  it("extracts a decision signal from explicit team-decision phrasing", async () => {
    const provider = new LocalHeuristics();

    const signals = await provider.compile(
      "We decided to use PostgreSQL for the main database.",
      createContext()
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_kind: "potential_claim",
      object_kind: "decision"
    });
    expect(CandidateMemorySignalSchema.parse(signals[0])).toEqual(signals[0]);
  });

  it("extracts a constraint signal from must/cannot phrasing", async () => {
    const provider = new LocalHeuristics();

    const signals = await provider.compile(
      "Must always validate user input at the API boundary.",
      createContext()
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_kind: "potential_claim",
      object_kind: "constraint"
    });
    expect(CandidateMemorySignalSchema.parse(signals[0])).toEqual(signals[0]);
  });

  it("returns zero signals for small-talk or non-declarative content", async () => {
    const provider = new LocalHeuristics();

    await expect(provider.compile("Hello, how are you today?", createContext())).resolves.toEqual([]);
    await expect(provider.compile("The weather is nice.", createContext())).resolves.toEqual([]);
  });

  it("extracts multiple signals from a mixed turn and produces unique ids", async () => {
    const provider = new LocalHeuristics();

    const signals = await provider.compile(
      "I prefer React for web UI and we decided to use TypeScript for the app.",
      createContext()
    );

    expect(signals).toHaveLength(2);
    expect(signals.map((signal) => signal.signal_kind)).toEqual([
      "potential_preference",
      "potential_claim"
    ]);
    expect(new Set(signals.map((signal) => signal.signal_id)).size).toBe(2);

    for (const signal of signals) {
      expect(UUID_PATTERN.test(signal.signal_id)).toBe(true);
      expect(CandidateMemorySignalSchema.parse(signal)).toEqual(signal);
    }
  });

  it("extracts a preference signal from Chinese phrasing", async () => {
    const provider = new LocalHeuristics();

    const signals = await provider.compile(
      "我偏好亮色主题。",
      createContext()
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_kind: "potential_preference",
      object_kind: "preference"
    });
  });

  it.each([
    "请叫我阿黄。",
    "叫我阿黄。",
    "我叫小明。",
    "我的名字是小明。"
  ])("extracts a durable Chinese naming preference from %s", async (turnContent) => {
    const provider = new LocalHeuristics();

    const signals = await provider.compile(turnContent, createContext());

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_kind: "potential_preference",
      object_kind: "preference"
    });
    expect(CandidateMemorySignalSchema.parse(signals[0])).toEqual(signals[0]);
  });

  it("does not extract a naming preference from imperative Chinese \"叫我...\" phrasing", async () => {
    const provider = new LocalHeuristics();

    const signals = await provider.compile(
      "叫我一声，我马上过去。",
      createContext()
    );

    expect(signals).toHaveLength(0);
  });

  it("extracts a decision signal from Chinese team-decision phrasing", async () => {
    const provider = new LocalHeuristics();

    const signals = await provider.compile(
      "我们决定以后都用TypeScript开发。",
      createContext()
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_kind: "potential_claim",
      object_kind: "decision"
    });
  });

  it("extracts a constraint signal from Chinese constraint phrasing", async () => {
    const provider = new LocalHeuristics();

    const signals = await provider.compile(
      "绝不允许跳过代码审查流程！",
      createContext()
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_kind: "potential_claim",
      object_kind: "constraint"
    });
  });
});

function createContext(): GardenCompileContext {
  return {
    workspace_id: "ws_1",
    run_id: "run_1",
    surface_id: null,
    turn_messages: [
      {
        message_id: "msg_user_1",
        role: "user",
        content: "Please remember this."
      },
      {
        message_id: "msg_assistant_1",
        role: "assistant",
        content: "Understood."
      }
    ]
  };
}
