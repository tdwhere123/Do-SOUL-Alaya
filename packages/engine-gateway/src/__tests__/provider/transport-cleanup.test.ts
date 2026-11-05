import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, fetch as fixtureFetch } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  executeProviderChatCompletion, providerExecutionFailureOf,
  type ProviderChatCompletionRequest
} from "../../provider/chat-completion/index.js";

const body = JSON.stringify({ choices: [{ message: { content: "first response" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
const policy = { maxRetries: 2, retryDelaysMs: [0, 0], retryNetworkErrors: true };

async function withProvider(status: number, responseBody: string,
  run: (request: ProviderChatCompletionRequest, requests: () => number, agent: Agent) => Promise<void>) {
  let dispatches = 0;
  const server = createServer((req, res) => {
    dispatches += 1;
    req.resume();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(responseBody);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const agent = new Agent();
  const destroy = agent.destroy.bind(agent);
  try {
    await run({ providerUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: "local-fixture", model: "fixture", systemPrompt: "system", userPrompt: "user",
      env: { ALAYA_ALLOW_PRIVATE_PROVIDER_URL: "1" }, timeoutMs: 2_000,
      fetchImpl: fixtureFetch as unknown as typeof fetch, transportFactory: () => agent
    }, () => dispatches, agent);
  } finally {
    vi.restoreAllMocks();
    await destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("request settlement and transport retirement", () => {
  it("preserves completed response and usage when close fails without dispatching again", async () => {
    await withProvider(200, body, async (request, requests, agent) => {
      const closeError = new Error("close failed");
      vi.spyOn(agent, "close").mockRejectedValue(closeError);
      const result = await executeProviderChatCompletion(request, policy);
      expect(requests()).toBe(1);
      expect(result).toMatchObject({ retryCount: 0, result: { text: "first response",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } });
      expect(result.result.transportCleanup).toEqual({ status: "destroyed",
        failures: [{ operation: "close", cause: closeError }] });
    });
  });

  it("retains both retirement failures without replacing a successful response", async () => {
    await withProvider(200, body, async (request, requests, agent) => {
      const closeError = new Error("close failed"), destroyError = new Error("destroy failed");
      vi.spyOn(agent, "close").mockRejectedValue(closeError);
      vi.spyOn(agent, "destroy").mockRejectedValue(destroyError);
      const result = await executeProviderChatCompletion(request, policy);
      expect(requests()).toBe(1);
      expect(result.result.text).toBe("first response");
      expect(result.result.transportCleanup).toEqual({ status: "failed", failures: [
        { operation: "close", cause: closeError }, { operation: "destroy", cause: destroyError }
      ] });
    });
  });

  it("bounds a hanging close and destroys the dispatcher without losing completion", async () => {
    await withProvider(200, body, async (request, requests, agent) => {
      vi.spyOn(agent, "close").mockImplementation(() => new Promise<void>(() => {}));
      const result = await executeProviderChatCompletion(request, policy);
      expect(requests()).toBe(1);
      expect(result.result.text).toBe("first response");
      expect(result.result.transportCleanup).toMatchObject({ status: "destroyed", failures: [
        { operation: "close", cause: expect.objectContaining({ message: "provider transport retirement timed out" }) }
      ] });
    });
  });

  it.each([
    [400, '{"error":{"code":"invalid_request"}}', "http_error", "failure_non_retryable_4xx"],
    [200, "not-json", "response_parse_error", "failure_non_retryable_response"]
  ] as const)("preserves primary failure for HTTP %s when destroy fails", async (status, content, kind, classification) => {
    await withProvider(status, content, async (request, requests, agent) => {
      const destroyError = new Error("destroy failed");
      vi.spyOn(agent, "destroy").mockRejectedValue(destroyError);
      const error = await executeProviderChatCompletion(request, policy).catch(error => error);
      expect(requests()).toBe(1);
      expect(error).toMatchObject({ kind, httpStatus: status });
      expect(providerExecutionFailureOf(error)).toMatchObject({ retryCount: 0, retryClassification: classification });
      expect(error.transportCleanup).toEqual({ status: "failed",
        failures: [{ operation: "destroy", cause: destroyError }] });
    });
  });

  it("does not cancel a complete response while its dispatcher is closing", async () => {
    await withProvider(200, body, async (request, requests, agent) => {
      const caller = new AbortController();
      const close = agent.close.bind(agent);
      vi.spyOn(agent, "close").mockImplementation(async () => {
        caller.abort();
        await new Promise<void>(resolve => close(resolve));
      });
      const result = await executeProviderChatCompletion({ ...request, abortSignal: caller.signal }, policy);
      expect(requests()).toBe(1);
      expect(result.result.text).toBe("first response");
      expect(result.result.transportCleanup).toEqual({ status: "closed", failures: [] });
    });
  });

  it("preserves primary HTTP failure and separately records a failing retry observer", async () => {
    await withProvider(503, "busy", async (request, requests) => {
      const observerError = new Error("receipt observer failed");
      const error = await executeProviderChatCompletion(request, policy, {
        onAttemptFailure: () => { throw observerError; }
      }).catch(error => error);
      expect(requests()).toBe(1);
      expect(error).toMatchObject({ kind: "http_error", httpStatus: 503 });
      expect(providerExecutionFailureOf(error)).toMatchObject({ retryCount: 0,
        failures: [{ attempt: 1, kind: "http_error", httpStatus: 503 }], observerFailures: [observerError] });
    });
  });
});
