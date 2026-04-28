import { describe, expect, it, vi } from "vitest";
import {
  RuntimeCancelResultSchema,
  RuntimeCapabilitiesSchema,
  RuntimeSessionConfigSchema,
  RuntimeSessionSchema,
  type RuntimeEvent
} from "@do-what/protocol";
import { ClaudeRuntimeAdapter } from "../runtime-adapters/claude-runtime-adapter.js";
import { CoreError } from "../errors.js";
import { StubClaudeSDKClientFactory, type StubClaudeTurnScript } from "../test-doubles/stub-claude-sdk-client.js";
import {
  makeFilesPersistedMessage,
  makePartialAssistantMessage,
  makeResultErrorMessage,
  makeResultMessage
} from "./fixtures/claude-sdk-messages.js";

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

describe("ClaudeRuntimeAdapter", () => {
  it("creates a runtime session, exposes the verified capability set, and rejects overlapping sessions", async () => {
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([
        {
          messages: [makeResultMessage("done")]
        }
      ])
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);

    expect(RuntimeSessionSchema.parse(session)).toEqual(session);
    expect(adapter.getCapabilities()).toEqual(
      RuntimeCapabilitiesSchema.parse({
        supports_resume: false,
        supports_interrupt: true,
        supports_streaming_updates: true,
        supports_tool_events: false,
        supports_permission_requests: false,
        supports_artifact_events: true,
        supports_terminal_events: false
      })
    );

    await expect(adapter.createSession(VALID_SESSION_CONFIG)).rejects.toEqual(
      new CoreError("CONFLICT", "Claude runtime session already active.")
    );
  });

  it("emits required events plus patch_emitted when the public stream contains persisted files", async () => {
    const { completed, script } = createTrackedTurnScript({
      messages: [
        makePartialAssistantMessage("hello"),
        makeFilesPersistedMessage("packages/core/src/index.ts", "00000000-0000-4000-8000-000000000008"),
        makeResultMessage("done")
      ]
    });
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([script]),
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    await Promise.all([completed, finished.promise]);

    expect(events).toEqual([
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_started",
        session_id: session.session_id
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "message_delta",
        session_id: session.session_id,
        delta: "hello",
        sequence: 0
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "patch_emitted",
        session_id: session.session_id,
        patch_id: "00000000-0000-4000-8000-000000000008",
        path_hints: ["packages/core/src/index.ts"]
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_finished",
        session_id: session.session_id,
        status: "completed",
        result_summary: "done"
      }
    ]);
  });

  it("emits runtime_error plus a failed session_finished when the iterator throws", async () => {
    const { completed, script } = createTrackedTurnScript({
      error: new Error("boom"),
      messages: []
    });
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([script]),
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    await Promise.all([completed, finished.promise]);

    expect(events).toEqual([
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_started",
        session_id: session.session_id
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "runtime_error",
        session_id: session.session_id,
        error_code: "sdk_query_failed",
        message: "boom"
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_finished",
        session_id: session.session_id,
        status: "failed",
        result_summary: null
      }
    ]);
  });

  it("does not emit session_started when startTurn fails before the SDK turn is acquired", async () => {
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: {
        async startTurn() {
          throw new Error("startup failed");
        }
      },
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    await finished.promise;

    expect(events).toEqual([
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "runtime_error",
        session_id: session.session_id,
        error_code: "sdk_query_failed",
        message: "startup failed"
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_finished",
        session_id: session.session_id,
        status: "failed",
        result_summary: null
      }
    ]);
  });

  it("fails the session if the SDK turn does not expose interrupt support", async () => {
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: {
        async startTurn() {
          return {
            messages: createAsyncIterable([makePartialAssistantMessage("late")])
          };
        }
      },
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    await finished.promise;

    expect(events).toEqual([
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "runtime_error",
        session_id: session.session_id,
        error_code: "sdk_query_failed",
        message: "Claude SDK turn did not expose interrupt support."
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_finished",
        session_id: session.session_id,
        status: "failed",
        result_summary: null
      }
    ]);
  });

  it("uses the runtime cancel hook when available", async () => {
    const completionGate = createDeferred<void>();
    const interrupt = vi.fn(async () => {
      completionGate.resolve(undefined);
    });
    const { completed, script } = createTrackedTurnScript({
      beforeComplete: async () => {
        await completionGate.promise;
      },
      cancel: interrupt,
      messages: []
    });
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([script]),
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    const result = await adapter.cancel(session.session_id);
    await Promise.all([completed, finished.promise]);

    expect(RuntimeCancelResultSchema.parse(result)).toMatchObject({
      session_id: session.session_id,
      status: "cancelled"
    });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: "session_finished",
      session_id: session.session_id,
      status: "cancelled"
    });
  });

  it("does not emit post-cancel runtime events when cancellation wins before the turn handle resolves", async () => {
    let releaseStartTurn!: () => void;
    const cancelObserved = createDeferred<void>();
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: {
        async startTurn() {
          await new Promise<void>((resolve) => {
            releaseStartTurn = resolve;
          });

          return {
            cancel: vi.fn(async () => {
              cancelObserved.resolve(undefined);
            }),
            messages: createAsyncIterable([
              makePartialAssistantMessage("should-not-emit")
            ])
          };
        }
      },
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    const cancelResultPromise = adapter.cancel(session.session_id);
    releaseStartTurn();
    const cancelResult = await cancelResultPromise;
    await cancelObserved.promise;

    expect(RuntimeCancelResultSchema.parse(cancelResult)).toMatchObject({
      session_id: session.session_id,
      status: "cancelled"
    });
    expect(events).toEqual([
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        result_summary: "cancelled by claude runtime adapter",
        session_id: session.session_id,
        status: "cancelled",
        type: "session_finished"
      }
    ]);
  });

  it("fails the pending cancel request when the SDK interrupt rejects after startTurn resolves", async () => {
    let releaseStartTurn!: () => void;
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: {
        async startTurn() {
          await new Promise<void>((resolve) => {
            releaseStartTurn = resolve;
          });

          return {
            cancel: async () => {
              throw new Error("interrupt failed");
            },
            messages: createAsyncIterable([makePartialAssistantMessage("should-not-emit")])
          };
        }
      },
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    const cancelPromise = adapter.cancel(session.session_id);
    releaseStartTurn();

    await expect(cancelPromise).rejects.toMatchObject({
      message: "Claude runtime interrupt failed."
    });
    await finished.promise;

    expect(events).toEqual([
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "runtime_error",
        session_id: session.session_id,
        error_code: "sdk_interrupt_failed",
        message: "interrupt failed"
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_finished",
        session_id: session.session_id,
        status: "failed",
        result_summary: null
      }
    ]);
  });

  it("fails the session deterministically when the cancel hook rejects", async () => {
    const { completed, script } = createTrackedTurnScript({
      beforeComplete: async () => {
        await new Promise(() => {
          // Keep the turn open until cancel runs.
        });
      },
      cancel: async () => {
        throw new Error("interrupt failed");
      },
      messages: []
    });
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([script]),
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });

    await expect(adapter.cancel(session.session_id)).rejects.toMatchObject({
      message: "Claude runtime interrupt failed."
    });
    await Promise.race([completed, finished.promise]);

    expect(events).toEqual([
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_started",
        session_id: session.session_id
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "runtime_error",
        session_id: session.session_id,
        error_code: "sdk_interrupt_failed",
        message: "interrupt failed"
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_finished",
        session_id: session.session_id,
        status: "failed",
        result_summary: null
      }
    ]);
  });

  it("maps SDK result failures to a failed session_finished event", async () => {
    const { completed, script } = createTrackedTurnScript({
      messages: [makeResultErrorMessage(["out of context"])]
    });
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([script]),
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    await Promise.all([completed, finished.promise]);

    expect(events).toEqual([
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_started",
        session_id: session.session_id
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_finished",
        session_id: session.session_id,
        status: "failed",
        result_summary: "out of context"
      }
    ]);
  });

  it("stops delivering events after the handler unsubscribes", async () => {
    const { completed, script } = createTrackedTurnScript({
      messages: [makePartialAssistantMessage("hello"), makeResultMessage("done")]
    });
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([script]),
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const events: RuntimeEvent[] = [];
    const unsubscribe = adapter.onEvent((event) => {
      events.push(event);
    });

    unsubscribe();
    await adapter.prompt(session.session_id, { prompt: "continue" });
    await completed;

    expect(events).toEqual([]);
  });

  it("rejects prompt() after the session already finished", async () => {
    const { completed, script } = createTrackedTurnScript({
      messages: [makeResultMessage("done")]
    });
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([script])
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    await adapter.prompt(session.session_id, { prompt: "continue" });
    await completed;

    await expect(adapter.prompt(session.session_id, { prompt: "again" })).rejects.toEqual(
      new CoreError("CONFLICT", `Claude runtime session already finished: ${session.session_id}`)
    );
  });

  it("does not emit later stream events when cancellation lands mid-iteration", async () => {
    const releaseNextMessage = createDeferred<void>();
    const iterationCompleted = createDeferred<void>();
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: {
        async startTurn() {
          return {
            cancel: async () => {
              releaseNextMessage.resolve(undefined);
            },
            messages: {
              async *[Symbol.asyncIterator]() {
                try {
                  yield makePartialAssistantMessage("first");
                  await releaseNextMessage.promise;
                  yield makePartialAssistantMessage("should-not-emit");
                } finally {
                  iterationCompleted.resolve(undefined);
                }
              }
            }
          };
        }
      },
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const sawFirstDelta = createDeferred<void>();
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "message_delta" && event.delta === "first") {
        sawFirstDelta.resolve(undefined);
      }
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    await sawFirstDelta.promise;
    await adapter.cancel(session.session_id);
    await Promise.all([iterationCompleted.promise, finished.promise]);

    expect(events).toEqual([
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_started",
        session_id: session.session_id
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "message_delta",
        session_id: session.session_id,
        delta: "first",
        sequence: 0
      },
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_finished",
        session_id: session.session_id,
        status: "cancelled",
        result_summary: "cancelled by claude runtime adapter"
      }
    ]);
  });

  it("emits session_finished(cancelled) without session_started when cancel is called before prompt", async () => {
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([]),
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
    });

    const result = await adapter.cancel(session.session_id);

    expect(RuntimeCancelResultSchema.parse(result)).toMatchObject({
      session_id: session.session_id,
      status: "cancelled"
    });
    expect(events).toEqual([
      {
        emitted_at: "2026-04-13T10:00:00.000Z",
        type: "session_finished",
        session_id: session.session_id,
        status: "cancelled",
        result_summary: "cancelled by claude runtime adapter"
      }
    ]);
  });

  it("does not produce an unhandled rejection when an event handler throws", async () => {
    const { completed, script } = createTrackedTurnScript({
      messages: [makePartialAssistantMessage("hello"), makeResultMessage("done")]
    });
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([script]),
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    let handlerCallCount = 0;
    // This handler throws on every event to simulate a misbehaving consumer.
    adapter.onEvent(() => {
      handlerCallCount++;
      throw new Error("handler explosion");
    });
    // A second handler still receives events because handler failures are isolated.
    adapter.onEvent((event) => {
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    await Promise.all([completed, finished.promise]);

    // All events were delivered despite the throwing handler.
    // (session_started, message_delta, session_finished = 3 calls on the throwing handler)
    expect(handlerCallCount).toBeGreaterThanOrEqual(3);
  });

  it("emits session_finished(failed) with null result_summary when SDK error has empty errors array", async () => {
    const { completed, script } = createTrackedTurnScript({
      messages: [makeResultErrorMessage([])]
    });
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([script]),
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    await Promise.all([completed, finished.promise]);

    expect(events.at(-1)).toMatchObject({
      type: "session_finished",
      status: "failed",
      result_summary: null
    });
  });

  it("emits session_finished(failed) with null result_summary when SDK error has whitespace-only errors", async () => {
    const { completed, script } = createTrackedTurnScript({
      messages: [makeResultErrorMessage(["", "  "])]
    });
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([script]),
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    await Promise.all([completed, finished.promise]);

    expect(events.at(-1)).toMatchObject({
      type: "session_finished",
      status: "failed",
      result_summary: null
    });
  });

  it("emits session_finished(failed) with a trimmed string result_summary when SDK errors are returned as a string", async () => {
    const stringErrorMessage = {
      ...makeResultErrorMessage([]),
      errors: "  out of context  " as unknown as readonly string[]
    };
    const { completed, script } = createTrackedTurnScript({
      messages: [stringErrorMessage]
    });
    const adapter = new ClaudeRuntimeAdapter({
      clientFactory: new StubClaudeSDKClientFactory([script]),
      now: () => "2026-04-13T10:00:00.000Z"
    });

    const session = await adapter.createSession(VALID_SESSION_CONFIG);
    const finished = createDeferred<void>();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "session_finished") {
        finished.resolve(undefined);
      }
    });

    await adapter.prompt(session.session_id, { prompt: "continue" });
    await Promise.all([completed, finished.promise]);

    expect(events.at(-1)).toMatchObject({
      type: "session_finished",
      status: "failed",
      result_summary: "out of context"
    });
  });
});

function createAsyncIterable<T>(values: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) {
        yield value;
      }
    }
  };
}

function createTrackedTurnScript(
  script: Omit<StubClaudeTurnScript, "onComplete">
): {
  readonly completed: Promise<void>;
  readonly script: StubClaudeTurnScript;
} {
  const completion = createDeferred<void>();

  return {
    completed: completion.promise,
    script: {
      ...script,
      onComplete: () => {
        completion.resolve(undefined);
      }
    }
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve
  };
}
