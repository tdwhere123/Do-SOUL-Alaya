import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeCapabilitiesSchema,
  RuntimeCancelResultSchema,
  RuntimeEventSchema,
  RuntimeSessionConfigSchema,
  RuntimeSessionSchema,
  RuntimeTurnInputSchema,
  type RuntimeEvent
} from "@do-what/protocol";
import { ScriptedRuntimeAdapter } from "../index.js";
import { ScriptedRuntimeAdapter as ScriptedRuntimeAdapterFromBarrel } from "../test-doubles/index.js";

const VALID_TIMESTAMP = "2026-04-10T00:00:00.000Z";
const VALID_SESSION_CONFIG = RuntimeSessionConfigSchema.parse({
  role: "worker",
  workspace_id: "workspace-1",
  run_id: "run-1",
  cwd: "/workspace/project",
  writable_roots: ["/workspace/project"],
  tool_profile: "default",
  allowed_mcp_servers: ["filesystem"],
  sandbox_policy: "workspace_write",
  permission_policy: "ask",
  network_policy: "restricted"
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ScriptedRuntimeAdapter exports", () => {
  it("is exported through the core barrel and the test-doubles barrel", () => {
    expect(ScriptedRuntimeAdapterFromBarrel).toBe(ScriptedRuntimeAdapter);
  });
});

describe("ScriptedRuntimeAdapter contract", () => {
  it("rejects invalid scripted events during construction", () => {
    expect(
      () =>
        new ScriptedRuntimeAdapter([
          {
            session_id: "scripted-source-session",
            emitted_at: VALID_TIMESTAMP,
            type: "message_delta"
          } as unknown as RuntimeEvent
        ])
    ).toThrow();
  });

  it("exposes the default capability set and validates custom capabilities against the protocol schema", () => {
    const adapter = new ScriptedRuntimeAdapter([]);
    const customCapabilities = RuntimeCapabilitiesSchema.parse({
      supports_resume: false,
      supports_interrupt: true,
      supports_streaming_updates: true,
      supports_tool_events: false,
      supports_permission_requests: false,
      supports_artifact_events: true,
      supports_terminal_events: true
    });
    const customAdapter = new ScriptedRuntimeAdapter([], customCapabilities);

    expect(adapter.getCapabilities()).toEqual(
      RuntimeCapabilitiesSchema.parse({
        supports_resume: true,
        supports_interrupt: true,
        supports_streaming_updates: true,
        supports_tool_events: true,
        supports_permission_requests: true,
        supports_artifact_events: false,
        supports_terminal_events: false
      })
    );
    expect(customAdapter.getCapabilities()).toEqual(customCapabilities);
    expect(
      () =>
        new ScriptedRuntimeAdapter([], {
          ...customCapabilities,
          supports_resume: "yes"
        } as never)
    ).toThrow();
  });

  it("validates createSession input and returns a session that matches the schema", async () => {
    const adapter = new ScriptedRuntimeAdapter([makeEvent({ type: "session_started" })]);

    await expect(
      adapter.createSession({
        ...VALID_SESSION_CONFIG,
        role: "principal",
        tool_profile: "coding"
      } as never)
    ).rejects.toThrow();

    const session = await adapter.createSession(VALID_SESSION_CONFIG);

    expect(RuntimeSessionSchema.parse(session)).toEqual(session);
    expect(session.session_id).toBe("scripted-source-session");
  });

  it("validates prompt input, requires a created session, and rejects unknown sessions", async () => {
    const adapter = new ScriptedRuntimeAdapter([makeEvent({ type: "session_started" })]);

    await expect(adapter.prompt("scripted-source-session", RuntimeTurnInputSchema.parse({ prompt: "continue" }))).rejects.toThrow(
      "Unknown scripted runtime session: scripted-source-session"
    );

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    await expect(adapter.prompt("unknown-session", RuntimeTurnInputSchema.parse({ prompt: "continue" }))).rejects.toThrow(
      "Unknown scripted runtime session: unknown-session"
    );
    await expect(adapter.prompt(session.session_id, { prompt: "" } as never)).rejects.toThrow();

    await expect(adapter.prompt(session.session_id, RuntimeTurnInputSchema.parse({ prompt: "continue" }))).resolves.toBeUndefined();
  });

  it("requires a created session before replay", async () => {
    const adapter = new ScriptedRuntimeAdapter([makeEvent({ type: "session_started" })]);

    await expect(adapter.replay()).rejects.toThrow("ScriptedRuntimeAdapter requires createSession() before replay().");
  });

  it("validates cancel input and returns structured results for active and finished sessions", async () => {
    const adapter = new ScriptedRuntimeAdapter([makeEvent({ type: "session_started" })]);
    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const received: RuntimeEvent[] = [];

    adapter.onEvent((event) => {
      received.push(event);
    });

    await expect(adapter.cancel("unknown-session")).rejects.toThrow("Unknown scripted runtime session: unknown-session");

    const firstResult = await adapter.cancel(session.session_id);
    const secondResult = await adapter.cancel(session.session_id);

    expect(RuntimeCancelResultSchema.parse(firstResult)).toEqual(firstResult);
    expect(firstResult).toMatchObject({
      session_id: session.session_id,
      status: "cancelled"
    });
    expect(RuntimeCancelResultSchema.parse(secondResult)).toEqual(secondResult);
    expect(secondResult).toMatchObject({
      session_id: session.session_id,
      status: "already_finished"
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "session_finished",
      session_id: session.session_id,
      status: "cancelled",
      result_summary: "cancelled by scripted adapter"
    });
  });

  it("stops replay after cancel and does not emit scripted events afterward", async () => {
    const adapter = new ScriptedRuntimeAdapter([
      makeEvent({ type: "session_started" }),
      makeEvent({ type: "message_delta", delta: "ignored after cancel", sequence: 0 }),
      makeEvent({ type: "session_finished", status: "completed", result_summary: "done" })
    ]);
    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const received: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      received.push(event);
    });

    await expect(adapter.cancel("unknown-session")).rejects.toThrow("Unknown scripted runtime session: unknown-session");

    const result = await adapter.cancel(session.session_id);

    expect(RuntimeCancelResultSchema.parse(result)).toEqual(result);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "session_finished",
      session_id: session.session_id,
      status: "cancelled",
      result_summary: "cancelled by scripted adapter"
    });

    await adapter.replay();
    expect(received).toHaveLength(1);
  });

  it("continues notifying later handlers when one handler throws", async () => {
    const event = makeEvent({ type: "session_started" });
    const adapter = new ScriptedRuntimeAdapter([event]);
    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const throwingHandler = vi.fn(() => {
      throw new Error("handler failed");
    });
    const laterHandler = vi.fn();

    adapter.onEvent(throwingHandler);
    adapter.onEvent(laterHandler);

    await expect(adapter.replay()).resolves.toBeUndefined();
    expect(throwingHandler).toHaveBeenCalledWith(expect.objectContaining({ session_id: session.session_id }));
    expect(laterHandler).toHaveBeenCalledWith(expect.objectContaining({ session_id: session.session_id }));
  });

  it("replays a streaming sequence in the original order", async () => {
    const events = [
      makeEvent({ type: "session_started" }),
      makeEvent({ type: "message_delta", delta: "hello", sequence: 0 }),
      makeEvent({ type: "message_delta", delta: " world", sequence: 1 }),
      makeEvent({ type: "session_finished", status: "completed", result_summary: "done" })
    ];
    const adapter = new ScriptedRuntimeAdapter(events);
    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const received = await replay(adapter);

    expect(received).toEqual(withSessionId(events, session.session_id));
  });

  it("replays a tool and permission sequence in the original order", async () => {
    const events = [
      makeEvent({ type: "session_started" }),
      makeEvent({ type: "tool_call_started", call_id: "call-1", tool_id: "tool.read_workspace" }),
      makeEvent({
        type: "permission_requested",
        request_id: "perm-1",
        tool_id: "tool.read_workspace",
        reason: "needs workspace access"
      }),
      makeEvent(
        {
          type: "tool_call_finished",
          call_id: "call-1",
          tool_id: "tool.read_workspace",
          outcome: "success",
          result_summary: "read complete"
        },
        "mismatched-source-session"
      ),
      makeEvent({ type: "session_finished", status: "completed", result_summary: "done" })
    ];
    const adapter = new ScriptedRuntimeAdapter(events);
    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const received = await replay(adapter);

    expect(received).toEqual(withSessionId(events, session.session_id));
    expect(events[3]?.session_id).toBe("mismatched-source-session");
    expect(received[3]?.session_id).toBe(session.session_id);
  });

  it("replays a patch and runtime error sequence in the original order", async () => {
    const events = [
      makeEvent({ type: "session_started" }),
      makeEvent({ type: "patch_emitted", patch_id: "patch-1", path_hints: ["packages/core/src/index.ts"] }),
      makeEvent({ type: "runtime_error", error_code: "scripted_error", message: "boom" }),
      makeEvent({ type: "session_finished", status: "failed", result_summary: null })
    ];
    const adapter = new ScriptedRuntimeAdapter(events);
    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const received = await replay(adapter);

    expect(received).toEqual(withSessionId(events, session.session_id));
  });

  it("does not touch external dependencies while constructing, prompting, cancelling, or replaying", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ScriptedRuntimeAdapter([makeEvent({ type: "session_started" })]);
    const session = await adapter.createSession(VALID_SESSION_CONFIG);

    await adapter.prompt(session.session_id, RuntimeTurnInputSchema.parse({ prompt: "continue" }));
    await adapter.replay();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function makeEvent(event: Record<string, unknown>, sessionId = "scripted-source-session"): RuntimeEvent {
  return RuntimeEventSchema.parse({
    session_id: sessionId,
    emitted_at: VALID_TIMESTAMP,
    ...event
  });
}

function withSessionId(events: readonly RuntimeEvent[], sessionId: string): RuntimeEvent[] {
  return events.map((event) =>
    RuntimeEventSchema.parse({
      ...event,
      session_id: sessionId
    })
  );
}

async function replay(adapter: ScriptedRuntimeAdapter): Promise<RuntimeEvent[]> {
  const received: RuntimeEvent[] = [];
  const unsubscribe = adapter.onEvent((event) => {
    received.push(event);
  });

  try {
    await adapter.replay();
    return received;
  } finally {
    unsubscribe();
  }
}
