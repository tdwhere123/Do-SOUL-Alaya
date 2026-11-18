import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
const encodeBudget = vi.hoisted(() => ({ expireAt: 0, seen: 0, cancel: undefined as AbortController | undefined }));
vi.mock("../../../runs/recall-measurement/text-mcp-consumer/codec.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../runs/recall-measurement/text-mcp-consumer/codec.js")>();
  return {
    ...actual,
    encodeTextMcpRequest(input: Parameters<typeof actual.encodeTextMcpRequest>[0]) {
      const encoded = actual.encodeTextMcpRequest(input);
      encodeBudget.seen += 1;
      const cancel = encodeBudget.cancel;
      if (cancel !== undefined) queueMicrotask(() => cancel.abort());
      if (encodeBudget.expireAt > 0 && encodeBudget.seen >= encodeBudget.expireAt) {
        vi.spyOn(performance, "now").mockReturnValue(1e15);
      }
      return encoded;
    }
  };
});
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ALAYA_MCP_SERVER_INSTRUCTIONS } from "@do-soul/alaya/mcp-server";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { bindBenchDaemonTestSignal } from "../../../harness/daemon-task.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { buildOrdinaryRecallRequest, mapOrdinaryRecallScope }
  from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";
import { queryProposalFromCoordinates } from "../../../runs/recall-measurement/ordinary/query-coordinate-proposal.js";
import {
  TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION, TEXT_MCP_CONSUMER_PAID_READINESS, TEXT_MCP_WALL_MS_MEANING
} from "../../../runs/recall-measurement/text-mcp-consumer/contract.js";
import { executeTextMcpConsumer } from "../../../runs/recall-measurement/text-mcp-consumer/execute.js";
import { ordinaryIndexedSnapshot, simulateIndexedQueryPreparation } from "./ordinary-indexed-snapshot.test-support.js";
import { HIDDEN_GOLD } from "./native-recall.test-support.js";

const PROJECTS = ["Aster", "Birch", "Cedar", "Dock"] as const;
const CEILINGS = {
  max_model_turns: 4, max_tool_calls: 4, max_input_bytes: 1_500_000, max_output_bytes: 64_000, wall_ms: 120_000
} as const;

let base: Awaited<ReturnType<typeof ordinaryIndexedSnapshot>>;
let preparation: ReturnType<typeof simulateIndexedQueryPreparation>;
let recallArgs: Record<string, unknown>;
beforeAll(async () => {
  preparation = simulateIndexedQueryPreparation();
  base = await ordinaryIndexedSnapshot(PROJECTS.map(name => `Project ${name} was mentioned.`));
  const mapped = mapOrdinaryRecallScope(base.config.authorized_scopes);
  if (mapped.status !== "mapped") throw new Error(mapped.reason);
  recallArgs = buildOrdinaryRecallRequest({
    query: base.queries[0]!.original_query, scope_class: mapped.scope_class,
    source_observed_at: base.config.interpretation_clock
  }) as Record<string, unknown>;
}, 120000);
afterAll(() => {
  preparation?.mockRestore();
  if (base !== undefined) rmSync(base.root, { recursive: true, force: true });
  isolation.restore(); expect(isolation.violations).toEqual([]);
});
afterEach(() => {
  encodeBudget.expireAt = 0;
  encodeBudget.seen = 0;
  encodeBudget.cancel = undefined;
  if (vi.isMockFunction(performance.now)) vi.mocked(performance.now).mockRestore();
});

function input(root: string, extra: Record<string, unknown> = {}) {
  const query = base.queries[0]!;
  return {
    config: base.config, root: join(base.root, root),
    query: { query_key: query.query_key, original_query: query.original_query },
    host_issued_initial_recall: false, model_kind: "scripted" as const, ceilings: { ...CEILINGS }, ...extra
  };
}

function answerThen(read: Record<string, unknown>) {
  let turns = 0;
  return {
    complete: () => {
      turns += 1;
      if (turns === 1) return { text: JSON.stringify(read), finishReason: "stop" as const };
      return { text: JSON.stringify({ action: "answer", text: "terminal-answer" }), finishReason: "stop" as const };
    },
    turns: () => turns
  };
}

function hangingPort(mode: "ignore" | "ack" = "ignore") {
  let invoked = 0;
  let release: (value: { text: string; finishReason: string | null }) => void = () => undefined;
  const pending = new Promise<{ text: string; finishReason: string | null }>(resolve => { release = resolve; });
  return {
    complete: (request: { abortSignal?: AbortSignal }) => {
      invoked += 1;
      if (mode === "ack") {
        request.abortSignal?.addEventListener("abort", () => {
          release({ text: JSON.stringify({ action: "answer", text: "acked-late" }), finishReason: "stop" });
        }, { once: true });
      }
      return pending;
    },
    invoked: () => invoked,
    releaseLateAnswer: () => release({
      text: JSON.stringify({ action: "answer", text: "late-answer" }), finishReason: "stop"
    })
  };
}

it("dispatches model-selected soul.recall through live MCP and preserves the literal envelope", async () => {
  const expected = structuredClone(recallArgs);
  const port = answerThen({ action: "read", tool: "soul.recall", arguments: expected });
  const execution = await executeTextMcpConsumer(input("model-selected-recall"), port);
  expect(execution.terminal).toEqual({ outcome: "answered", text: "terminal-answer" });
  expect(execution.consumer_model_calls).toBe(2);
  expect(execution.mcp_dispatches).toBe(1);
  expect(execution.live_surface?.instructions).toBe(ALAYA_MCP_SERVER_INSTRUCTIONS);
  expect(execution.live_surface?.tools.some(tool =>
    typeof tool === "object" && tool !== null && "name" in tool && tool.name === "soul.recall")).toBe(true);
  expect(execution.diagnostic_restriction).toBe(TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION);
  expect(execution.paid_readiness).toEqual(TEXT_MCP_CONSUMER_PAID_READINESS);
  expect(execution.model_work).toEqual({ status: "settled", wall_ms_meaning: TEXT_MCP_WALL_MS_MEANING });
  expect(execution.claims).toEqual({
    native_provider_tool_calling: false, cli_host_equivalence: false, answer_quality: "not_verified"
  });
  const call = execution.events.find(event => event.kind === "mcp_call")!;
  expect(call.origin).toBe("model_selected");
  expect(canonicalJson(call.arguments)).toBe(canonicalJson(expected));
  expect(call.response_state).toBe("received");
  expect(call.envelope).toMatchObject({ content: expect.any(Array) });
  const second = execution.events.filter(event => event.kind === "model_turn")[1] as {
    gatewayBody: { messages: { content: string }[] };
  };
  expect(second.gatewayBody.messages[0]!.content).toContain(ALAYA_MCP_SERVER_INSTRUCTIONS);
  expect(second.gatewayBody.messages[1]!.content).toContain(canonicalJson(call.envelope));
  expect(second.gatewayBody.messages[1]!.content).not.toContain("first_page");
  expect(JSON.stringify(execution)).not.toContain(HIDDEN_GOLD);
  expect(JSON.stringify(execution)).toMatch(/Aster|Birch|Cedar|Dock/u);
  expect(hashRegularFileNoFollow(base.config.snapshot_path)).toBe(base.config.snapshot_sha256);
  expect(readdirSync(join(base.root, "model-selected-recall")).filter(name => name.startsWith("native-session-")))
    .toEqual([]);
}, 120000);

it("refuses coordinate-bearing soul.recall on a plain-query profile without calling MCP", async () => {
  const port = answerThen({
    action: "read", tool: "soul.recall",
    arguments: { ...recallArgs, query_coordinates: { question_time: { intervals: [{ start: "2023-09-01", end: "2023-09-13" }] } } }
  });
  const execution = await executeTextMcpConsumer(input("plain-query-refusal", {
    caller_capability_profile: "plain_query"
  }), port);
  expect(execution.terminal).toEqual({
    outcome: "host_policy_refusal", tool: "soul.recall",
    reason: "plain_query forbids query_coordinates and interpretation_proposal"
  });
  expect(execution.mcp_dispatches).toBe(0);
  expect(execution.caller_capability_profile).toBe("plain_query");
  expect(execution.live_surface?.instructions).toBe(ALAYA_MCP_SERVER_INSTRUCTIONS);
}, 120000);

it("records host-issued initial recall as controlled setup and does not require a model fetch-first", async () => {
  let turns = 0;
  const execution = await executeTextMcpConsumer(input("host-setup", { host_issued_initial_recall: true }), {
    complete: request => {
      turns += 1;
      expect(request.userPrompt).toContain("controlled setup; not model-generated");
      return { text: JSON.stringify({ action: "answer", text: "from-setup" }), finishReason: "stop" };
    }
  });
  expect(turns).toBe(1);
  expect(execution.host_setup).toBe(true);
  expect(execution.mcp_dispatches).toBe(1);
  expect(execution.events[0]).toMatchObject({
    kind: "host_setup", generated_by: "host_controlled_setup", tool: "soul.recall"
  });
  expect(execution.terminal).toEqual({ outcome: "answered", text: "from-setup" });
}, 120000);

it("denies non-allowed writes locally without calling MCP", async () => {
  const execution = await executeTextMcpConsumer(input("write-denied"), {
    complete: () => ({
      text: JSON.stringify({ action: "read", tool: "soul.capture_host_session", arguments: { messages: [] } }),
      finishReason: "stop"
    })
  });
  expect(execution.terminal).toMatchObject({
    outcome: "host_policy_refusal", tool: "soul.capture_host_session"
  });
  expect(execution.mcp_dispatches).toBe(0);
  expect(execution.events.some(event => event.kind === "mcp_call")).toBe(false);
}, 120000);

it("preserves a native MCP error envelope and does not treat it as valid-empty", async () => {
  const port = answerThen({ action: "read", tool: "soul.recall", arguments: {} });
  const execution = await executeTextMcpConsumer(input("native-error"), port);
  const call = execution.events.find(event => event.kind === "mcp_call")!;
  expect(call.response_state).toBe("public_error");
  expect(call.envelope).toMatchObject({ isError: true, content: expect.any(Array) });
  expect(call.envelope).not.toEqual({ results: [] });
  const second = execution.events.filter(event => event.kind === "model_turn")[1] as {
    gatewayBody: { messages: { content: string }[] };
  };
  expect(second.gatewayBody.messages[1]!.content).toContain(canonicalJson(call.envelope));
  expect(execution.terminal).toEqual({ outcome: "answered", text: "terminal-answer" });
}, 120000);

it("stops at input, output, and tool ceilings without extra model or MCP dispatch", async () => {
  const inputCeiling = await executeTextMcpConsumer(input("input-ceiling", {
    ceilings: { ...CEILINGS, max_input_bytes: 500 }
  }), { complete: () => { throw new Error("model must not run after input ceiling"); } });
  expect(inputCeiling.terminal).toEqual({ outcome: "input_ceiling" });
  expect(inputCeiling.consumer_model_calls).toBe(0);

  const outputCeiling = await executeTextMcpConsumer(input("output-ceiling", {
    ceilings: { ...CEILINGS, max_output_bytes: 8 }
  }), { complete: () => ({ text: "x".repeat(32), finishReason: "stop" }) });
  expect(outputCeiling.terminal).toEqual({ outcome: "output_ceiling" });
  expect(outputCeiling.mcp_dispatches).toBe(0);

  const toolCeiling = await executeTextMcpConsumer(input("tool-ceiling", {
    ceilings: { ...CEILINGS, max_tool_calls: 0 }
  }), {
    complete: () => ({
      text: JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }), finishReason: "stop"
    })
  });
  expect(toolCeiling.terminal).toEqual({ outcome: "tool_call_ceiling" });
  expect(toolCeiling.consumer_model_calls).toBe(1);
  expect(toolCeiling.mcp_dispatches).toBe(0);
}, 120000);

it("cancels without a second model turn and leaves the original snapshot unchanged", async () => {
  const controller = new AbortController();
  bindBenchDaemonTestSignal(controller.signal);
  let turns = 0;
  await expect(executeTextMcpConsumer(input("cancelled"), {
    complete: () => {
      turns += 1;
      controller.abort();
      return {
        text: JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }), finishReason: "stop"
      };
    }
  })).rejects.toMatchObject({ code: "CANCELLED" });
  expect(turns).toBe(1);
  expect(hashRegularFileNoFollow(base.config.snapshot_path)).toBe(base.config.snapshot_sha256);
}, 120000);

it("counts host setup toward max_tool_calls and admits time/tool ceilings before dispatch", async () => {
  let turns = 0;
  const tools = await executeTextMcpConsumer(input("setup-tool-ceiling", {
    host_issued_initial_recall: true, ceilings: { ...CEILINGS, max_tool_calls: 0 }
  }), { complete: () => { turns += 1; throw new Error("model must not run after tool ceiling"); } });
  expect(turns).toBe(0);
  expect(tools.terminal).toEqual({ outcome: "tool_call_ceiling" });
  expect(tools.mcp_dispatches).toBe(0);
  expect(tools.host_setup).toBe(false);
  const timed = await executeTextMcpConsumer(input("setup-time-ceiling", {
    host_issued_initial_recall: true, ceilings: { ...CEILINGS, wall_ms: 1 }
  }), { complete: () => { turns += 1; throw new Error("model must not run after time ceiling"); } });
  expect(turns).toBe(0);
  expect(timed.terminal).toEqual({ outcome: "time_ceiling", model_work: "idle" });
  expect(timed.model_work.status).toBe("idle");
  expect(timed.mcp_dispatches).toBe(0);
  expect(timed.host_setup).toBe(false);
}, 120000);

it("binds the complete callable before await so later port mutation is ignored", async () => {
  const port = {
    complete: () => ({ text: JSON.stringify({ action: "answer", text: "captured" }), finishReason: "stop" as const })
  };
  const pending = executeTextMcpConsumer(input("captured-complete"), port);
  port.complete = () => ({ text: JSON.stringify({ action: "answer", text: "mutated" }), finishReason: "stop" });
  expect((await pending).terminal).toEqual({ outcome: "answered", text: "captured" });
}, 120000);

it("rejects a late answer after pending complete() is cancelled", async () => {
  const hang = hangingPort();
  const controller = new AbortController();
  bindBenchDaemonTestSignal(controller.signal);
  const pending = executeTextMcpConsumer(input("pending-cancel"), hang);
  await vi.waitFor(() => { expect(hang.invoked()).toBe(1); }, { timeout: 15_000 });
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    code: "CANCELLED", cause: { model_work: "unsettled_unknown", wall_ms_meaning: TEXT_MCP_WALL_MS_MEANING }
  });
  hang.releaseLateAnswer();
  await Promise.resolve();
  expect(hashRegularFileNoFollow(base.config.snapshot_path)).toBe(base.config.snapshot_sha256);
}, 120000);

it("rejects a late answer after pending complete() exceeds wall_ms", async () => {
  const hang = hangingPort();
  const execution = await executeTextMcpConsumer(input("pending-time", {
    ceilings: { ...CEILINGS, wall_ms: 10_000 }
  }), hang);
  expect(hang.invoked()).toBe(1);
  expect(execution.terminal).toEqual({ outcome: "time_ceiling", model_work: "unsettled_unknown" });
  expect(execution.model_work.status).toBe("unsettled_unknown");
  expect(JSON.stringify(execution.events)).not.toContain("late-answer");
  hang.releaseLateAnswer();
  await Promise.resolve();
  expect(execution.terminal).toEqual({ outcome: "time_ceiling", model_work: "unsettled_unknown" });
  expect(execution.mcp_dispatches).toBe(0);
}, 120000);

it("does not dispatch or accept answers from length, null, or unknown finishReason", async () => {
  const length = await executeTextMcpConsumer(input("finish-length"), {
    complete: () => ({
      text: JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }), finishReason: "length"
    })
  });
  expect(length.terminal).toEqual({ outcome: "model_incomplete", finishReason: "length" });
  expect(length.mcp_dispatches).toBe(0);
  const missing = await executeTextMcpConsumer(input("finish-null"), {
    complete: () => ({
      text: JSON.stringify({ action: "answer", text: "should-not-accept" }), finishReason: null
    })
  });
  expect(missing.terminal).toEqual({ outcome: "model_unknown", finishReason: null });
  expect(missing.mcp_dispatches).toBe(0);
  const unknown = await executeTextMcpConsumer(input("finish-unknown"), {
    complete: () => ({
      text: JSON.stringify({ action: "answer", text: "should-not-accept" }), finishReason: "content_filter"
    })
  });
  expect(unknown.terminal).toEqual({ outcome: "model_unknown", finishReason: "content_filter" });
  expect(unknown.mcp_dispatches).toBe(0);
}, 120000);

it("passes an admitted frozen interpretation proposal unchanged on host setup", async () => {
  const query = base.queries[0]!;
  const proposal = queryProposalFromCoordinates(query.original_query, base.config.interpretation_clock, {
    status: "formed",
    coordinates: { time: { kind: "window", alternatives: [{ start: "2023-09-12", end: "2023-09-12" }] } }
  })!;
  const frozen = structuredClone(proposal);
  const execution = await executeTextMcpConsumer(input("frozen-proposal", {
    host_issued_initial_recall: true,
    query: { query_key: query.query_key, original_query: query.original_query, interpretation_proposal: proposal }
  }), {
    complete: () => ({ text: JSON.stringify({ action: "answer", text: "from-setup" }), finishReason: "stop" })
  });
  expect(execution.host_setup).toBe(true);
  expect(canonicalJson((execution.events[0] as { arguments: { interpretation_proposal: unknown } }).arguments
    .interpretation_proposal)).toBe(canonicalJson(frozen));
  expect(execution.terminal).toEqual({ outcome: "answered", text: "from-setup" });
}, 120000);

it("rejects a synchronous CPU-overrun answer after the actual wait budget", async () => {
  const t0 = performance.now(), wall = 5_000;
  const execution = await executeTextMcpConsumer(input("cpu-late", {
    ceilings: { ...CEILINGS, wall_ms: wall }
  }), {
    complete: () => {
      while (performance.now() - t0 < wall + 400) { /* overrun the session wait budget */ }
      return { text: JSON.stringify({ action: "answer", text: "cpu-late" }), finishReason: "stop" };
    }
  });
  expect(execution.terminal).toEqual({ outcome: "time_ceiling", model_work: "settled_late" });
  expect(execution.model_work).toEqual({ status: "settled_late", wall_ms_meaning: TEXT_MCP_WALL_MS_MEANING });
  expect(execution.mcp_dispatches).toBe(0);
}, 120000);

it("observes a cooperative cancel ack without accepting the late answer", async () => {
  const ack = hangingPort("ack");
  const ackCtl = new AbortController();
  bindBenchDaemonTestSignal(ackCtl.signal);
  const acked = executeTextMcpConsumer(input("coop-cancel"), ack);
  await vi.waitFor(() => { expect(ack.invoked()).toBe(1); }, { timeout: 15_000 });
  ackCtl.abort();
  const cancelled = await acked.then(() => undefined, error => error) as Error & { code?: string; cause?: unknown };
  expect(cancelled).toMatchObject({ code: "CANCELLED" });
  expect(cancelled.message).toContain("model_work=acked");
  expect(cancelled.cause).toEqual({ model_work: "acked", wall_ms_meaning: TEXT_MCP_WALL_MS_MEANING });
}, 120000);

it("observes a cooperative deadline ack without accepting the late answer", async () => {
  const deadline = hangingPort("ack");
  const timed = await executeTextMcpConsumer(input("coop-deadline", {
    ceilings: { ...CEILINGS, wall_ms: 10_000 }
  }), deadline);
  expect(timed.terminal).toEqual({ outcome: "time_ceiling", model_work: "acked" });
  expect(timed.model_work.status).toBe("acked");
  expect(JSON.stringify(timed.events)).not.toContain("acked-late");
  expect(timed.mcp_dispatches).toBe(0);
}, 120000);

it("does not late-abort a completed turn after disposing the wait timer", async () => {
  const t0 = performance.now();
  let turnSignal: AbortSignal | undefined;
  const execution = await executeTextMcpConsumer(input("no-late-abort", {
    ceilings: { ...CEILINGS, wall_ms: 6_000 }
  }), {
    complete: request => {
      turnSignal = request.abortSignal;
      return { text: JSON.stringify({ action: "answer", text: "ok" }), finishReason: "stop" };
    }
  });
  expect(execution.terminal).toEqual({ outcome: "answered", text: "ok" });
  expect(turnSignal?.aborted).toBe(false);
  const wait = 6_500 - (performance.now() - t0);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  expect(turnSignal?.aborted).toBe(false);
}, 120000);

it("never begins model work after queued cancellation becomes observable", async () => {
  const controller = new AbortController();
  bindBenchDaemonTestSignal(controller.signal);
  encodeBudget.cancel = controller;
  const beganAfterCancel: boolean[] = [];
  const execution = executeTextMcpConsumer(input("cancel-before-invocation"), {
    complete: () => {
      beganAfterCancel.push(controller.signal.aborted);
      return { text: JSON.stringify({ action: "answer", text: "discarded" }), finishReason: "stop" };
    }
  });
  await expect(execution).rejects.toMatchObject({ code: "CANCELLED" });
  expect(beganAfterCancel).not.toContain(true);
}, 120000);

it("does not count request preparation that exhausts the wait budget as a model call", async () => {
  encodeBudget.expireAt = 1;
  let calls = 0;
  const execution = await executeTextMcpConsumer(input("prep-expire"), {
    complete: () => { calls += 1; throw new Error("complete must not run after preparation exhausted the wait budget"); }
  });
  expect(calls).toBe(0);
  expect(execution.consumer_model_calls).toBe(0);
  expect(execution.terminal).toEqual({ outcome: "time_ceiling", model_work: "idle" });
  expect(execution.model_work.status).toBe("idle");
}, 120000);

it("preserves a prior settled model_work when a later turn is refused before complete", async () => {
  encodeBudget.expireAt = 2;
  let calls = 0;
  const execution = await executeTextMcpConsumer(input("later-prep-expire"), {
    complete: () => {
      calls += 1;
      return {
        text: JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }), finishReason: "stop"
      };
    }
  });
  expect(calls).toBe(1);
  expect(execution.consumer_model_calls).toBe(1);
  expect(execution.model_work.status).toBe("settled");
  expect(execution.terminal).toEqual({ outcome: "time_ceiling", model_work: "settled" });
}, 120000);
