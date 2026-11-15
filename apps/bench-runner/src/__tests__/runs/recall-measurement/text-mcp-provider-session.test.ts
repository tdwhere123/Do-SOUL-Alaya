import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary({ ownedTemporaryFixtures: true });
});
const mcpDispatch = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("../../../runs/recall-measurement/text-mcp-consumer/live-mcp.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../runs/recall-measurement/text-mcp-consumer/live-mcp.js")>();
  return {
    ...actual,
    async dispatchTextMcpRead(
      ...args: Parameters<typeof actual.dispatchTextMcpRead>
    ) {
      mcpDispatch.calls += 1;
      if (mcpDispatch.fail) {
        return {
          tool: args[1], arguments: structuredClone(args[2]),
          response_state: "transport_error" as const, envelope: null
        };
      }
      return actual.dispatchTextMcpRead(...args);
    }
  };
});
process.env.NODE_ENV = "test";
process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL = "true";

import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import mutableFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { executeProviderChatCompletion, ProviderChatCompletionError, providerExecutionFailureOf } from "@do-soul/alaya-engine-gateway";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";
import { prepareSemanticProviderRequest } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { mapGardenHttpAttemptFailure, toBenchTransportFailureAttempt } from "../../../runs/compile-seed/http/garden-http-failure-attempt.js";
import { wrapGardenHttpTransportError } from "../../../runs/compile-seed/http/garden-http-terminal-error.js";
import { providerRawAttemptPath } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { buildOrdinaryRecallRequest, mapOrdinaryRecallScope } from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";
import { TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA, TEXT_MCP_ACTION_SCHEMA_NAME, encodeTextMcpRequest } from "../../../runs/recall-measurement/text-mcp-consumer/codec.js";
import { TEXT_MCP_PROVIDER_BOUND_KIND } from "../../../runs/recall-measurement/text-mcp-consumer/session-authority.js";
import { consumeTextMcpProviderSession } from "../../../runs/recall-measurement/text-mcp-consumer/session-execute.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { ordinaryIndexedSnapshot, simulateIndexedQueryPreparation } from "./ordinary-indexed-snapshot.test-support.js";
import { HIDDEN_GOLD } from "./native-recall.test-support.js";
import { issueTextMcpProviderSession, sessionProviderConfig } from "../../support/text-mcp-provider-session-fixture.js";

const PROJECTS = ["Aster", "Birch", "Cedar", "Dock"] as const;
const CEILINGS = {
  max_model_turns: 2, max_tool_calls: 4, max_input_bytes: 1_500_000, max_output_bytes: 64_000, wall_ms: 60_000
} as const;

let base: Awaited<ReturnType<typeof ordinaryIndexedSnapshot>>;
let preparation: ReturnType<typeof simulateIndexedQueryPreparation>;
let recallArgs: Record<string, unknown>;
const received: { url?: string; body: string }[] = [];
const answers: string[] = [];
let response: "success" | "unknown" | "hang" = "success";
let ready: () => void | Promise<void> = () => undefined;
let onRequest: () => void = () => undefined;
let afterExtract: () => void = () => undefined;
let endpoint = "";

const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  expect(req.headers.authorization).toBe("Bearer");
  const index = received.length;
  received.push({ url: req.url, body });
  onRequest();
  if (response === "hang") return;
  const answer = answers[index] ?? JSON.stringify({ action: "answer", text: "default-answer" });
  const packet = {
    choices: [{ delta: { content: answer }, finish_reason: "stop" }],
    ...(response === "unknown" ? {} : { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
  };
  res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  res.end(`data: ${JSON.stringify(packet)}\n\ndata: [DONE]\n\n`);
});

beforeAll(async () => {
  preparation = simulateIndexedQueryPreparation();
  base = await ordinaryIndexedSnapshot(PROJECTS.map(name => `Project ${name} was mentioned.`));
  const mapped = mapOrdinaryRecallScope(base.config.authorized_scopes);
  if (mapped.status !== "mapped") throw new Error(mapped.reason);
  recallArgs = buildOrdinaryRecallRequest({
    query: base.queries[0]!.original_query, scope_class: mapped.scope_class,
    source_observed_at: base.config.interpretation_clock
  }) as Record<string, unknown>;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback server missing");
  endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
}, 120000);

afterAll(() => {
  preparation?.mockRestore();
  server.closeAllConnections();
  server.close();
  if (base !== undefined) rmSync(base.root, { recursive: true, force: true });
  isolation.restore();
  expect(isolation.violations).toEqual([]);
});

afterEach(() => {
  received.length = 0;
  answers.length = 0;
  response = "success";
  ready = () => undefined;
  onRequest = () => undefined;
  afterExtract = () => undefined;
  mcpDispatch.fail = false;
  mcpDispatch.calls = 0;
});

function query() {
  const item = base.queries[0]!;
  return { query_key: item.query_key, original_query: item.original_query };
}

function issue(name: string, extra: Omit<Parameters<typeof issueTextMcpProviderSession>[0], "home" | "config" | "query"> = {}) {
  const home = join(base.root, name);
  mkdirSync(home, { recursive: true });
  return issueTextMcpProviderSession({ home, config: base.config, query: query(), ...extra });
}

function consumerOf(fixture: ReturnType<typeof issue>, extra: { host_issued_initial_recall?: boolean } = {}) {
  return {
    config: base.config, root: fixture.consumerRoot, query: query(),
    host_issued_initial_recall: extra.host_issued_initial_recall ?? fixture.grant.host_issued_initial_recall,
    ceilings: { ...CEILINGS, wall_ms: fixture.grant.limits.wall_ms }
  };
}

function dependencies(selected: ReturnType<typeof sessionProviderConfig>) {
  return {
    loadConfig: (): CompileSeedExtractionConfig => selected,
    createExtractor: (pinned: CompileSeedExtractionConfig) => ({
      assertTransportReady: async () => { await ready(); },
      extract: async (input: Parameters<typeof prepareSemanticProviderRequest>[1]) => {
        const request = prepareSemanticProviderRequest(pinned, input, TEXT_MCP_ACTION_SCHEMA_NAME).gatewayRequest;
        try {
          const execution = await executeProviderChatCompletion({
            ...request!, apiKey: "",
            fetchImpl: async (url, init) => {
              expect(url).toBe(`${selected.providerUrl}/chat/completions`);
              expect(init?.redirect).toBe("error");
              return fetch(endpoint, init);
            }
          }, { maxRetries: 0, retryDelaysMs: [] });
          const result = execution.result;
          afterExtract();
          return { rawJson: result.text, responseMetadata: { finishReason: result.finishReason },
            usage: result.usage, httpResponse: result.httpResponse };
        } catch (cause) {
          const error = mapGardenHttpAttemptFailure(cause,
            cause instanceof ProviderChatCompletionError ? cause.httpStatus : null,
            { timedOut: cause instanceof ProviderChatCompletionError && cause.kind === "timeout",
              aborted: cause instanceof ProviderChatCompletionError && cause.kind === "aborted" });
          const failure = toBenchTransportFailureAttempt(error, 0);
          throw wrapGardenHttpTransportError(error,
            providerExecutionFailureOf(cause)?.retryClassification ?? "failure_non_retryable_response",
            0, 0, failure === undefined ? [] : [failure]);
        }
      }
    })
  };
}

function expectedBody(events: readonly Record<string, unknown>[], surface: NonNullable<Awaited<ReturnType<typeof consumeTextMcpProviderSession>>["live_surface"]>,
  selected: ReturnType<typeof sessionProviderConfig>) {
  const encoded = encodeTextMcpRequest({ surface, query: query().original_query, events });
  return prepareSemanticProviderRequest(selected, {
    systemPrompt: encoded.systemPrompt, userPrompt: encoded.userPrompt, maxOutputTokens: 128,
    retryMode: "disabled", outputTokenField: "max_tokens", validateRawJson: () => undefined,
    responseJsonSchema: TEXT_MCP_ACTION_RESPONSE_JSON_SCHEMA
  }, TEXT_MCP_ACTION_SCHEMA_NAME).body;
}

it("refuses missing, closed, or drifted session authority without HTTP", async () => {
  const fixture = issue("authority-denial");
  await expect(consumeTextMcpProviderSession({
    grantPin: { ...fixture.pin, sha256: "0".repeat(64) }, mode: "execute", consumer: consumerOf(fixture)
  }, dependencies(fixture.selected))).rejects.toThrow(/pin mismatch/);
  expect(received).toEqual([]);
  const closed = issue("closed-session", { closedSessions: [join(base.root, "closed-session")] });
  await expect(consumeTextMcpProviderSession({
    grantPin: closed.pin, mode: "execute", consumer: consumerOf(closed)
  }, dependencies(closed.selected))).rejects.toThrow(/known closed/);
  expect(received).toEqual([]);
  const drifted = issue("config-drift");
  await expect(consumeTextMcpProviderSession({
    grantPin: drifted.pin, mode: "execute", consumer: consumerOf(drifted)
  }, { loadConfig: () => ({ ...drifted.selected, model: "mutated-model" }), createExtractor: dependencies(drifted.selected).createExtractor })).rejects.toThrow(/granted route/);
  expect(received).toEqual([]);
}, 30000);

it("two-turn read then answer binds exact transcript wire, two reservations, and known usage", async () => {
  const fixture = issue("two-turn");
  answers.push(
    JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }),
    JSON.stringify({ action: "answer", text: "terminal-answer" })
  );
  const result = await consumeTextMcpProviderSession({
    grantPin: fixture.pin, mode: "execute", consumer: consumerOf(fixture)
  }, dependencies(fixture.selected));
  expect(result.failure).toBeNull();
  expect(result.model_kind).toBe(TEXT_MCP_PROVIDER_BOUND_KIND);
  expect(result.claims).toEqual({
    native_provider_tool_calling: false, scripted_complete_callback: false, answer_quality: "not_verified"
  });
  expect(result.invocations_this_invocation).toBe(2);
  expect(result.attempts_this_invocation).toBe(2);
  expect(result.mcp_dispatches).toBe(1);
  expect((result.ledger as { attempts: number; successfulShards: number }).attempts).toBe(2);
  expect((result.ledger as { successfulShards: number }).successfulShards).toBe(2);
  expect(result.cost.reported_input_tokens).toBe(22);
  expect(result.cost.unknown_usage_attempts).toBe(0);
  expect(result.turns.map(turn => turn.status)).toEqual(["admitted", "admitted"]);
  expect(result.live_surface).not.toBeNull();
  const call = result.events.find(event => event.kind === "mcp_call")!;
  expect(call.origin).toBe("model_selected");
  expect(canonicalJson(call.arguments)).toBe(canonicalJson(recallArgs));
  expect(call.response_state).toBe("received");
  expect(call.envelope).toMatchObject({ content: expect.any(Array) });
  expect(received).toHaveLength(2);
  expect(received[0]!.body).toBe(expectedBody([], result.live_surface!, fixture.selected));
  expect(received[1]!.body).toBe(expectedBody(result.events.slice(0, 2), result.live_surface!, fixture.selected));
  const secondPrompt = encodeTextMcpRequest({
    surface: result.live_surface!, query: query().original_query, events: result.events.slice(0, 2)
  }).userPrompt;
  expect(secondPrompt).toContain(canonicalJson(call.envelope));
  expect(JSON.stringify(result)).not.toContain(HIDDEN_GOLD);
  expect(JSON.stringify(result)).toMatch(/Aster|Birch|Cedar|Dock/u);
  expect(hashRegularFileNoFollow(base.config.snapshot_path)).toBe(base.config.snapshot_sha256);
  const raw = JSON.parse(readFileSync(providerRawAttemptPath(fixture.grant.execution_root, result.turns[0]!.key, 1), "utf8"));
  expect(raw.kind).toBe("task_consumer");
  expect(raw.http_response.bodyComplete).toBe(true);
  const replay = await consumeTextMcpProviderSession({
    grantPin: fixture.pin, mode: "execute", consumer: consumerOf(fixture)
  }, dependencies(fixture.selected));
  expect(replay.attempts_this_invocation).toBe(0);
  expect(received).toHaveLength(2);
}, 180000);

it("unknown usage and caller cancellation prevent the second turn", async () => {
  const unknown = issue("unknown-usage");
  answers.push(JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }));
  response = "unknown";
  const unknownResult = await consumeTextMcpProviderSession({
    grantPin: unknown.pin, mode: "execute", consumer: consumerOf(unknown)
  }, dependencies(unknown.selected));
  expect(unknownResult.attempts_this_invocation).toBe(1);
  expect(unknownResult.cost.unknown_usage_attempts).toBe(1);
  expect(unknownResult.turns[0]?.status).toBe("unknown_usage");
  expect(unknownResult.turns[1]).toBeUndefined();
  expect(received).toHaveLength(1);
  response = "unknown";
  const again = await consumeTextMcpProviderSession({
    grantPin: unknown.pin, mode: "execute", consumer: consumerOf(unknown)
  }, dependencies(unknown.selected));
  expect(again.attempts_this_invocation).toBe(0);
  expect(received).toHaveLength(1);

  received.length = 0;
  response = "hang";
  const cancelled = issue("cancel");
  answers.push(JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }));
  const controller = new AbortController();
  onRequest = () => controller.abort();
  const cancellation = await consumeTextMcpProviderSession({
    grantPin: cancelled.pin, mode: "execute", consumer: consumerOf(cancelled), abortSignal: controller.signal
  }, dependencies(cancelled.selected));
  expect(cancellation.attempts_this_invocation).toBe(1);
  expect((cancellation.ledger as { successfulShards: number }).successfulShards).toBe(0);
  expect(cancellation.turns[1]).toBeUndefined();
}, 180000);

it("root drift during readiness sends nothing and interrupted publication recovers without HTTP", async () => {
  const duringWait = issue("root-during-readiness");
  answers.push(JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }));
  ready = async () => {
    renameSync(duringWait.grant.execution_root, `${duringWait.grant.execution_root}-moved`);
    mkdirSync(duringWait.grant.execution_root);
  };
  await expect(consumeTextMcpProviderSession({
    grantPin: duringWait.pin, mode: "execute", consumer: consumerOf(duringWait)
  }, dependencies(duringWait.selected))).rejects.toThrow(/root|lease|changed/);
  expect(received).toHaveLength(0);

  ready = () => undefined;
  const partial = issue("publication");
  answers.push(
    JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }),
    JSON.stringify({ action: "answer", text: "terminal-answer" })
  );
  const originalLink = mutableFs.linkSync;
  mutableFs.linkSync = function(from, to) {
    if (String(to).endsWith(".turn.json")) {
      throw Object.assign(new Error("authored publication interruption"), { code: "EACCES" });
    }
    return originalLink(from, to);
  };
  syncBuiltinESMExports();
  let interrupted: Awaited<ReturnType<typeof consumeTextMcpProviderSession>>;
  try {
    interrupted = await consumeTextMcpProviderSession({
      grantPin: partial.pin, mode: "execute", consumer: consumerOf(partial)
    }, dependencies(partial.selected));
  } finally {
    mutableFs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
  expect(interrupted.attempts_this_invocation).toBe(1);
  expect(interrupted.invocations_this_invocation).toBe(1);
  expect((interrupted.ledger as { unresolvedAttempts: unknown[] }).unresolvedAttempts).toHaveLength(1);
  expect(interrupted.turns[0]?.status).toBe("pending");
  const prior = received.length;
  const recovered = await consumeTextMcpProviderSession({
    grantPin: partial.pin, mode: "recover", consumer: consumerOf(partial)
  }, dependencies(partial.selected));
  expect(received).toHaveLength(prior);
  expect(recovered.turns[0]?.status).toBe("admitted");
  expect(recovered.turns[1]).toBeUndefined();
  expect(recovered.cost.reported_input_tokens).toBe(11);
  expect(recovered.mcp_dispatches).toBe(0);
}, 180000);

it("unresolved MCP delivery stays terminal on replay and host setup", async () => {
  mcpDispatch.fail = true;
  const modelFail = issue("unresolved-mcp-replay");
  answers.push(JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }));
  const first = await consumeTextMcpProviderSession({
    grantPin: modelFail.pin, mode: "execute", consumer: consumerOf(modelFail)
  }, dependencies(modelFail.selected));
  expect(first.attempts_this_invocation).toBe(1);
  expect(first.mcp_dispatches).toBe(1);
  expect(first.events.some(event => event.kind === "mcp_call" && event.response_state === "transport_error")).toBe(true);
  expect(first.turns[1]).toBeUndefined();
  expect(received).toHaveLength(1);
  const replay = await consumeTextMcpProviderSession({
    grantPin: modelFail.pin, mode: "execute", consumer: consumerOf(modelFail)
  }, dependencies(modelFail.selected));
  expect(received).toHaveLength(1);
  expect(replay.attempts_this_invocation).toBe(0);
  expect(replay.turns[1]).toBeUndefined();

  received.length = 0;
  answers.length = 0;
  mcpDispatch.calls = 0;
  const hostFail = issue("unresolved-host-setup", { hostIssuedInitialRecall: true });
  answers.push(JSON.stringify({ action: "answer", text: "should-not-run" }));
  const host = await consumeTextMcpProviderSession({
    grantPin: hostFail.pin, mode: "execute", consumer: consumerOf(hostFail)
  }, dependencies(hostFail.selected));
  expect(host.host_setup).toBe(true);
  expect(host.events.some(event => event.kind === "host_setup" && event.response_state === "transport_error")).toBe(true);
  expect(received).toHaveLength(0);
  expect(host.turns).toEqual([]);
  const hostReplay = await consumeTextMcpProviderSession({
    grantPin: hostFail.pin, mode: "execute", consumer: consumerOf(hostFail)
  }, dependencies(hostFail.selected));
  expect(received).toHaveLength(0);
  expect(hostReplay.turns).toEqual([]);
}, 180000);

it("aborted execute does not dispatch host setup or replayed MCP", async () => {
  const host = issue("abort-host-setup", { hostIssuedInitialRecall: true });
  const abortedHost = new AbortController();
  abortedHost.abort();
  const hostResult = await consumeTextMcpProviderSession({
    grantPin: host.pin, mode: "execute", consumer: consumerOf(host), abortSignal: abortedHost.signal
  }, dependencies(host.selected));
  expect(hostResult.failure).toMatch(/cancelled/i);
  expect(mcpDispatch.calls).toBe(0);
  expect(received).toHaveLength(0);

  const partial = issue("abort-replay-mcp");
  answers.push(JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }));
  const originalLink = mutableFs.linkSync;
  mutableFs.linkSync = function(from, to) {
    if (String(to).endsWith(".turn.json")) {
      throw Object.assign(new Error("authored publication interruption"), { code: "EACCES" });
    }
    return originalLink(from, to);
  };
  syncBuiltinESMExports();
  try {
    await consumeTextMcpProviderSession({
      grantPin: partial.pin, mode: "execute", consumer: consumerOf(partial)
    }, dependencies(partial.selected));
  } finally {
    mutableFs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
  await consumeTextMcpProviderSession({
    grantPin: partial.pin, mode: "recover", consumer: consumerOf(partial)
  }, dependencies(partial.selected));
  const before = received.length;
  mcpDispatch.calls = 0;
  const aborted = new AbortController();
  aborted.abort();
  const replayed = await consumeTextMcpProviderSession({
    grantPin: partial.pin, mode: "execute", consumer: consumerOf(partial), abortSignal: aborted.signal
  }, dependencies(partial.selected));
  expect(replayed.failure).toMatch(/cancelled/i);
  expect(mcpDispatch.calls).toBe(0);
  expect(received).toHaveLength(before);

  mcpDispatch.calls = 0;
  const mid = issue("abort-after-model");
  answers.push(JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }));
  const midAbort = new AbortController();
  afterExtract = () => midAbort.abort();
  const stopped = await consumeTextMcpProviderSession({
    grantPin: mid.pin, mode: "execute", consumer: consumerOf(mid), abortSignal: midAbort.signal
  }, dependencies(mid.selected));
  expect(stopped.failure).toMatch(/cancelled/i);
  expect(stopped.attempts_this_invocation).toBe(1);
  expect(mcpDispatch.calls).toBe(0);
  expect(stopped.events.some(event => event.kind === "mcp_call")).toBe(false);
}, 180000);

it("publication failure after a completed turn keeps live invocation and transcript counts", async () => {
  const fixture = issue("partial-after-success", { maxModelTurns: 2 });
  answers.push(
    JSON.stringify({ action: "read", tool: "soul.recall", arguments: recallArgs }),
    JSON.stringify({ action: "answer", text: "terminal-answer" })
  );
  let turnPublications = 0;
  const originalLink = mutableFs.linkSync;
  mutableFs.linkSync = function(from, to) {
    if (String(to).endsWith(".turn.json")) {
      turnPublications += 1;
      if (turnPublications >= 2) {
        throw Object.assign(new Error("authored publication interruption"), { code: "EACCES" });
      }
    }
    return originalLink(from, to);
  };
  syncBuiltinESMExports();
  let interrupted: Awaited<ReturnType<typeof consumeTextMcpProviderSession>>;
  try {
    interrupted = await consumeTextMcpProviderSession({
      grantPin: fixture.pin, mode: "execute", consumer: consumerOf(fixture)
    }, dependencies(fixture.selected));
  } finally {
    mutableFs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
  expect(interrupted.failure).toMatch(/authored publication interruption/);
  expect(interrupted.invocations_this_invocation).toBe(2);
  expect(interrupted.attempts_this_invocation).toBe(2);
  expect(interrupted.mcp_dispatches).toBe(1);
  expect(interrupted.events.some(event => event.kind === "mcp_call" && event.response_state === "received")).toBe(true);
  expect(interrupted.turns[0]?.status).toBe("admitted");
  expect(interrupted.turns[1]?.status).toBe("pending");
}, 180000);
