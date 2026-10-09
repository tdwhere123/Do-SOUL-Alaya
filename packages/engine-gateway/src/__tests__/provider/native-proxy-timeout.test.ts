import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it, vi } from "vitest";
import { executeProviderChatCompletion, type ProviderChatCompletionRequest } from "../../provider/chat-completion/index.js";

async function withDelayedProxy(run: (request: ProviderChatCompletionRequest,
  observed: { calls: number; tunnels: number; disconnected: number }) => Promise<void>) {
  const observed = { calls: 0, tunnels: 0, disconnected: 0 };
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); };
  const wire = JSON.stringify({ choices: [{ message: { content: '{"probe":true}' }, finish_reason: "stop" }] });
  const target = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the exact request before delaying headers */ }
    observed.calls += 1;
    const timer = setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" }); response.end(wire);
    }, 1600);
    response.on("close", () => { clearTimeout(timer); observed.disconnected += 1; });
  });
  target.on("connection", track);
  const proxy = createServer();
  proxy.on("connection", track);
  proxy.on("connect", (request, client, head) => {
    observed.tunnels += 1;
    const [host, port] = request.url!.split(":");
    expect(host).toBe("127.0.0.1");
    expect(Number(port)).toBe((target.address() as AddressInfo).port);
    const upstream = connect(Number(port), host!, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    track(upstream);
    client.on("close", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const original = getGlobalDispatcher();
  const agent = new EnvHttpProxyAgent({ httpProxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    noProxy: "", headersTimeout: 50, bodyTimeout: 50 });
  setGlobalDispatcher(agent);
  const closeSpy = vi.spyOn(agent, "close");
  const destroySpy = vi.spyOn(agent, "destroy");
  const request: ProviderChatCompletionRequest = {
    providerUrl: `http://127.0.0.1:${(target.address() as AddressInfo).port}`,
    apiKey: "loopback-only", model: "step-3.5-flash-2603", profile: "step-3.5-2603-low-json-schema-v1",
    systemPrompt: "JSON only", userPrompt: "probe", mode: "json", timeoutMs: 5000,
    jsonSchema: { name: "probe", schema: { type: "object" } }, maxOutputTokens: 8192,
    retainHttpResponseEvidence: true, env: { ALAYA_ALLOW_PRIVATE_PROVIDER_URL: "1" }
  };
  try {
    await run(request, observed);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();
  } finally {
    closeSpy.mockRestore(); destroySpy.mockRestore();
    setGlobalDispatcher(original);
    await agent.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>(resolve => target.close(() => resolve())),
      new Promise<void>(resolve => proxy.close(() => resolve()))]);
  }
}

it("aligns native finite header waits while inheriting the runtime proxy and leaving ordinary waits unchanged", async () => {
  await withDelayedProxy(async (request, observed) => {
    const retry0 = { maxRetries: 0, retryDelaysMs: [] };
    await expect(executeProviderChatCompletion({ ...request, profile: undefined,
      jsonSchema: undefined, retainHttpResponseEvidence: undefined }, retry0)).rejects
      .toMatchObject({ kind: "network_error", cause: { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } } });
    const result = await executeProviderChatCompletion(request, retry0);
    expect(result.result).toMatchObject({ text: '{"probe":true}', finishReason: "stop", httpStatus: 200,
      completion: { mode: "json", complete: true }, httpResponse: { bodyComplete: true, bodyTruncated: false } });
    expect(observed.calls).toBe(2);
    expect(observed.tunnels).toBe(2);
  });
});

it.each(["caller", "deadline"] as const)("cancels a native proxied header wait at the %s bound without another request", async mode => {
  await withDelayedProxy(async (request, observed) => {
    const controller = new AbortController();
    const timer = mode === "caller" ? setTimeout(() => controller.abort(), 250) : undefined;
    try {
      await expect(executeProviderChatCompletion({ ...request, timeoutMs: mode === "deadline" ? 250 : 5000,
        abortSignal: controller.signal }, { maxRetries: 0, retryDelaysMs: [] })).rejects
        .toMatchObject({ kind: mode === "caller" ? "aborted" : "timeout", httpStatus: null });
      await vi.waitFor(() => expect(observed.disconnected).toBe(1));
      expect(observed.calls).toBe(1);
      // The inherited pool may replace a cancelled connection; CONNECT is not a provider request.
      expect(observed.tunnels).toBeGreaterThanOrEqual(1);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  });
});
