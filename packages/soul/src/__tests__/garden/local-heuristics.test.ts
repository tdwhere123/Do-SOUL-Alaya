import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateMemorySignalSchema, SignalSource } from "@do-soul/alaya-protocol";
import type { GardenCompileContext } from "../../garden/compute-provider.js";
import { LocalHeuristics } from "../../garden/local-heuristics.js";

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
        preference_profile: {
          preference_subject: "operator",
          preference_predicate: "prefer",
          preference_object: "TypeScript strict mode for application code",
          preference_category: "TypeScript",
          preference_polarity: "positive",
          projection_schema_version: 1
        },
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

  it("extracts a time_concern fact signal from dated factual phrasing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T10:20:30.000Z"));
    const provider = new LocalHeuristics();

    const signals = await provider.compile(
      "We reviewed the release blocker yesterday and agreed to keep the fix loop open.",
      createContext()
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_kind: "potential_claim",
      object_kind: "fact",
      domain_tags: ["time_concern"],
      confidence: 0.52,
      raw_payload: expect.objectContaining({
        pattern_category: "time_concern",
        matched_text: "yesterday",
        time_concern: {
          window_digest: "yesterday",
          matched_text: "yesterday",
          event_time_start: "2026-03-19T00:00:00.000Z",
          event_time_end: "2026-03-19T23:59:59.999Z",
          time_precision: "day",
          time_source: "relative_resolved",
          projection_schema_version: "1"
        },
        temporal_projection: {
          event_time_start: "2026-03-19T00:00:00.000Z",
          event_time_end: "2026-03-19T23:59:59.999Z",
          time_precision: "day",
          time_source: "relative_resolved",
          projection_schema_version: "1"
        },
        schema_grounding: expect.objectContaining({ status: "valid" }),
        detected_object: expect.objectContaining({ object_kind: "fact" })
      })
    });
    expect(signals[0].raw_payload.field_candidates).toEqual([
      {
        field_name: "fact",
        value: "We reviewed the release blocker yesterday and agreed to keep the fix loop open.",
        evidence: "We reviewed the release blocker yesterday and agreed to keep the fix loop open.",
        confidence: 0.52
      }
    ]);
    expect(CandidateMemorySignalSchema.parse(signals[0])).toEqual(signals[0]);
  });

  it("extracts a strict temporal projection from Chinese explicit dates", async () => {
    const provider = new LocalHeuristics();

    const signals = await provider.compile("2026年3月19日我们完成发布复盘。", createContext());

    expect(signals).toHaveLength(1);
    expect(signals[0]!.raw_payload).toMatchObject({
      matched_text: "2026年3月19日",
      temporal_projection: {
        event_time_start: "2026-03-19T00:00:00.000Z",
        event_time_end: "2026-03-19T23:59:59.999Z",
        time_precision: "day",
        time_source: "explicit",
        projection_schema_version: "1"
      }
    });
  });

  it("does not rollover impossible explicit calendar dates", async () => {
    const provider = new LocalHeuristics();

    const signals = await provider.compile("2026-02-31 we reviewed the blocker.", createContext());

    expect(signals).toHaveLength(1);
    expect(signals[0]!.raw_payload).not.toHaveProperty("temporal_projection");
    expect(signals[0]!.raw_payload.time_concern).toEqual({
      window_digest: "2026-02-31",
      matched_text: "2026-02-31"
    });
  });

  it("extracts a time_concern fact signal from Chinese dated phrasing", async () => {
    const provider = new LocalHeuristics();

    const signals = await provider.compile(
      "昨天我们确认继续完成全部修复。",
      createContext()
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signal_kind: "potential_claim",
      object_kind: "fact",
      domain_tags: ["time_concern"],
      raw_payload: expect.objectContaining({
        matched_text: "昨天",
        time_concern: expect.objectContaining({
          window_digest: "昨天",
          matched_text: "昨天"
        })
      })
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
