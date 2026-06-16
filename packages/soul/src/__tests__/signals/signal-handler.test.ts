import { describe, expect, it } from "vitest";
import { SoulSignalHandler, materializeCandidateSignal } from "@do-soul/alaya-soul";
import type { CandidateMemorySignal, ConversationRuntimeContext } from "@do-soul/alaya-protocol";

function makeRuntimeContext(overrides: Partial<ConversationRuntimeContext> = {}): ConversationRuntimeContext {
  return {
    workspace_id: "ctx-workspace",
    run_id: "ctx-run",
    surface_id: "ctx-surface",
    user_message_id: "ctx-msg",
    ...overrides
  };
}

function makeToolInput(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    workspace_id: "payload-workspace",
    run_id: "payload-run",
    surface_id: "payload-surface",
    signal_kind: "potential_claim",
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: ["test"],
    confidence: 0.8,
    evidence_refs: ["msg-1"],
    raw_payload: { excerpt: "test" },
    ...overrides
  };
}

describe("SoulSignalHandler — emit_candidate_signal scope binding", () => {
  it("uses runtimeContext workspace_id/run_id/surface_id, ignores tool payload values", async () => {
    let capturedSignal: CandidateMemorySignal | undefined;
    const handler = new SoulSignalHandler({
      receiveSignal: async (signal) => { capturedSignal = signal; }
    });

    await handler.handleToolUse(
      { id: "tu-1", type: "tool_use", name: "soul.emit_candidate_signal", input: makeToolInput() },
      makeRuntimeContext()
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.workspace_id).toBe("ctx-workspace");
    expect(capturedSignal!.run_id).toBe("ctx-run");
    expect(capturedSignal!.surface_id).toBe("ctx-surface");
    // Confirm payload values were NOT used
    expect(capturedSignal!.workspace_id).not.toBe("payload-workspace");
    expect(capturedSignal!.run_id).not.toBe("payload-run");
  });

  it("uses null surface_id from runtimeContext when surface_id is null", async () => {
    let capturedSignal: CandidateMemorySignal | undefined;
    const handler = new SoulSignalHandler({
      receiveSignal: async (signal) => { capturedSignal = signal; }
    });

    await handler.handleToolUse(
      { id: "tu-2", type: "tool_use", name: "soul.emit_candidate_signal", input: makeToolInput() },
      makeRuntimeContext({ surface_id: null })
    );

    expect(capturedSignal!.surface_id).toBeNull();
  });

  it("returns error tool_result when runtimeContext is missing", async () => {
    const handler = new SoulSignalHandler({
      receiveSignal: async () => {}
    });

    const result = await handler.handleToolUse(
      { id: "tu-3", type: "tool_use", name: "soul.emit_candidate_signal", input: makeToolInput() },
      undefined
    );

    expect(result.is_error).toBe(true);
    const parsed = JSON.parse(result.content) as { error: string };
    expect(parsed.error).toContain("Missing runtime context");
  });
});

describe("normalizeSignalInput — extra fields and coercions", () => {
  it("strips unknown extra fields so .strict() schema parse succeeds", async () => {
    let capturedSignal: CandidateMemorySignal | undefined;
    const handler = new SoulSignalHandler({
      receiveSignal: async (signal) => { capturedSignal = signal; }
    });

    // LLM often sends reasoning, _meta, and other extra fields alongside known ones
    const inputWithExtras = makeToolInput({
      reasoning: "I think this is a preference",
      _meta: { source: "chain-of-thought" },
      extra_debug: true
    });

    const result = await handler.handleToolUse(
      { id: "tu-extra", type: "tool_use", name: "soul.emit_candidate_signal", input: inputWithExtras },
      makeRuntimeContext()
    );

    // Must NOT be an error — extra fields should be stripped, not rejected
    expect(result.is_error).toBeFalsy();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.signal_kind).toBe("potential_claim");
  });

  it("coerces empty string surface_id to null", async () => {
    let capturedSignal: CandidateMemorySignal | undefined;
    const handler = new SoulSignalHandler({
      receiveSignal: async (signal) => { capturedSignal = signal; }
    });

    await handler.handleToolUse(
      { id: "tu-empty-surface", type: "tool_use", name: "soul.emit_candidate_signal", input: makeToolInput({ surface_id: "" }) },
      makeRuntimeContext({ surface_id: null })
    );

    expect(capturedSignal!.surface_id).toBeNull();
  });

  it("coerces empty string scope_hint to null", async () => {
    let capturedSignal: CandidateMemorySignal | undefined;
    const handler = new SoulSignalHandler({
      receiveSignal: async (signal) => { capturedSignal = signal; }
    });

    await handler.handleToolUse(
      { id: "tu-empty-scope", type: "tool_use", name: "soul.emit_candidate_signal", input: makeToolInput({ scope_hint: "" }) },
      makeRuntimeContext()
    );

    expect(capturedSignal!.scope_hint).toBeNull();
  });

  it("filters empty strings from domain_tags array", async () => {
    let capturedSignal: CandidateMemorySignal | undefined;
    const handler = new SoulSignalHandler({
      receiveSignal: async (signal) => { capturedSignal = signal; }
    });

    await handler.handleToolUse(
      {
        id: "tu-empty-tags",
        type: "tool_use",
        name: "soul.emit_candidate_signal",
        input: makeToolInput({ domain_tags: ["tag1", "", "tag2", ""] })
      },
      makeRuntimeContext()
    );

    expect(capturedSignal!.domain_tags).toEqual(["tag1", "tag2"]);
  });

  it("filters empty strings from evidence_refs array", async () => {
    let capturedSignal: CandidateMemorySignal | undefined;
    const handler = new SoulSignalHandler({
      receiveSignal: async (signal) => { capturedSignal = signal; }
    });

    await handler.handleToolUse(
      {
        id: "tu-empty-refs",
        type: "tool_use",
        name: "soul.emit_candidate_signal",
        input: makeToolInput({ evidence_refs: ["msg-1", "", "msg-2", ""] })
      },
      makeRuntimeContext()
    );

    expect(capturedSignal!.evidence_refs).toEqual(["msg-1", "msg-2"]);
  });
});

describe("materializeCandidateSignal — scopeOverride", () => {
  const baseInput = makeToolInput();
  const generatorsId = () => "signal-fixed";

  it("overrides workspace_id/run_id/surface_id when scopeOverride is provided", () => {
    const signal = materializeCandidateSignal({
      input: baseInput,
      source: "model_tool",
      generateSignalId: generatorsId,
      scopeOverride: { workspace_id: "override-ws", run_id: "override-run", surface_id: "override-surface" }
    });

    expect(signal.workspace_id).toBe("override-ws");
    expect(signal.run_id).toBe("override-run");
    expect(signal.surface_id).toBe("override-surface");
  });

  it("uses input values when no scopeOverride is provided", () => {
    const signal = materializeCandidateSignal({
      input: baseInput,
      source: "model_tool",
      generateSignalId: generatorsId
    });

    expect(signal.workspace_id).toBe("payload-workspace");
    expect(signal.run_id).toBe("payload-run");
    expect(signal.surface_id).toBe("payload-surface");
  });
});
