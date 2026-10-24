import { createServer } from "node:http";
import { LocalOnnxEmbeddingClient, ReconciliationService, type ReconciliationDecision } from "@do-soul/alaya-core";
import { expect, vi } from "vitest";
import { fetchLoopbackProvider } from "./loopback-provider-fetch.js";

/** Exercise the real Garden transport/parser without a provider or native inference. */
export async function installOfflineReconciliationFixture() {
  const unexpected: string[] = [];
  const requests: unknown[] = [];
  const decisions: ReconciliationDecision[] = [];
  const guardedFetch = globalThis.fetch;
  const endpoint = "https://fixture-provider.invalid/v1";
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", endpoint);
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:OFFLINE_RECONCILIATION_TEST_KEY");
  vi.stubEnv("OFFLINE_RECONCILIATION_TEST_KEY", "fixture-only");
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      kind: "add", reason: "offline fixture: distinct planted facts"
    }) }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback fixture address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.href === `${endpoint}/chat/completions` && typeof init?.body === "string" &&
        init.body.includes("You reconcile a new atomic fact against existing memory rows")) {
      return fetchLoopbackProvider(guardedFetch, new URL(url.pathname, origin), init);
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      unexpected.push(`fetch:${url.origin}${url.pathname}`);
      throw new Error("unexpected provider dependency in offline runner fixture");
    }
    return guardedFetch(input, init);
  });
  const onnxSpies = (["warmup", "embedTexts", "bindSourceEmbedding"] as const).map((method) =>
    vi.spyOn(LocalOnnxEmbeddingClient.prototype, method).mockImplementation(() => {
      unexpected.push(`onnx:${method}`);
      throw new Error("unexpected ONNX dependency in offline runner fixture");
    }));
  const original = ReconciliationService.prototype.runWithDecision;
  const decisionSpy = vi.spyOn(ReconciliationService.prototype, "runWithDecision")
    .mockImplementation(async function (this: ReconciliationService, ...args) {
      const result = await original.apply(this, args);
      decisions.push(result);
      return result;
    });
  return {
    requests,
    decisions,
    async close() {
      try {
        // Assertions live outside transport/decision callbacks: catch-and-ADD cannot hide a failure.
        expect(unexpected).toEqual([]);
        expect(decisions.filter((decision) => /unavailable|invalid|rule-only/iu.test(decision.reason))).toEqual([]);
        expect(decisions.filter((decision) => decision.reason === "offline fixture: distinct planted facts"))
          .toHaveLength(requests.length);
        console.log("[offline runner isolation]", JSON.stringify({ unexpected, requests, decisions }));
      } finally {
        fetchSpy.mockRestore();
        decisionSpy.mockRestore();
        for (const spy of onnxSpies) spy.mockRestore();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  };
}
