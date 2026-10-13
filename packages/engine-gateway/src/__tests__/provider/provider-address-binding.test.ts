import { createServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import { connect, type AddressInfo } from "node:net";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, type Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { fetchProviderChatCompletion } from "../../provider/chat-completion/fetch-chat-completion.js";

const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn<(hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>>()
}));
vi.mock("node:dns/promises", () => ({ lookup }));
const request = {
  providerUrl: "http://provider.example/v1", apiKey: "test-fixture-credential",
  model: "fixture", systemPrompt: "system", userPrompt: "user", timeoutMs: 2_000
};
const originalDispatcher = getGlobalDispatcher();
const certificate = readFileSync(new URL("./fixtures/loopback-provider-cert.pem", import.meta.url));
const testKey = readFileSync(new URL("./fixtures/loopback-provider-key.pem", import.meta.url));
afterEach(() => { expect(getGlobalDispatcher()).toBe(originalDispatcher); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks(); });

type Received = { host?: string; authorization?: string; servername?: string };
async function withServer(run: (port: number, received: Received[]) => Promise<void>, options: { secure?: boolean; delayMs?: number } = {}) {
  const received: Received[] = [];
  const handle: RequestListener = (req, res) => {
    received.push({ host: req.headers.host, authorization: req.headers.authorization,
      ...(req.socket instanceof TLSSocket ? { servername: req.socket.servername || undefined } : {}) });
    const timer = setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    }, options.delayMs ?? 0);
    res.on("close", () => clearTimeout(timer));
  };
  const server = options.secure ? createHttpsServer({ key: testKey, cert: certificate }, handle) : createServer(handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run((server.address() as AddressInfo).port, received); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function withProxy(targetPort: number, run: (url: string, tunnels: string[]) => Promise<void>) {
  const tunnels: string[] = [];
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); };
  const proxy = createServer();
  proxy.on("connection", track);
  proxy.on("connect", (req, client, head) => {
    tunnels.push(req.url!);
    // The local upstream stands in for the admitted public destination.
    const upstream = connect({ host: "127.0.0.1", port: targetPort }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    track(upstream);
    client.on("close", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, tunnels); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
}

describe("provider address binding", () => {
  it("falls back from an unreachable admitted IPv6 address to admitted IPv4 without resolving again", async () => {
    await withServer(async (port, received) => {
      lookup.mockResolvedValueOnce([{ address: "2606:4700:4700::1111", family: 6 }, { address: "93.184.216.34", family: 4 }])
        .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const connected: string[] = [];
      await expect(fetchProviderChatCompletion({ ...request, transportFactory: ({ factory }) =>
        new Agent({ factory, connect(options, callback) {
          connected.push(options.hostname);
          if (options.hostname === "2606:4700:4700::1111") {
            callback(Object.assign(new Error("fixture IPv6 unavailable"), { code: "ENETUNREACH" }), null);
            return;
          }
          const socket = connect({ host: "127.0.0.1", port });
          socket.once("connect", () => callback(null, socket));
          socket.once("error", error => callback(error, null));
        } }) })).resolves.toMatchObject({ text: "ok" });
      expect(connected).toEqual(["2606:4700:4700::1111", "93.184.216.34"]);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(received).toEqual([{ host: "provider.example", authorization: "Bearer test-fixture-credential" }]);
    });
  });

  it("selects direct transport using the original NO_PROXY hostname before pinning", async () => {
    await withServer(async (port, received) => withProxy(port, async (proxyUrl, tunnels) => {
      lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      const connected: string[] = [];
      const result = await fetchProviderChatCompletion({ ...request, transportFactory: ({ factory }) =>
        new EnvHttpProxyAgent({ factory, httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy: "provider.example",
          connect(options, callback) {
            connected.push(options.hostname);
            const socket = connect({ host: "127.0.0.1", port });
            socket.once("connect", () => callback(null, socket));
            socket.once("error", error => callback(error, null));
          } }) });
      expect(result.text).toBe("ok");
      expect(tunnels).toEqual([]);
      expect(connected).toEqual(["93.184.216.34"]);
      expect(received).toEqual([{ host: "provider.example", authorization: "Bearer test-fixture-credential" }]);
      expect(lookup).toHaveBeenCalledTimes(1);
    }));
  });

  it("pins the proxy CONNECT target and verifies TLS using the original hostname and SNI", async () => {
    await withServer(async (port, received) => withProxy(port, async (proxyUrl, tunnels) => {
      lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      await expect(fetchProviderChatCompletion({ ...request, providerUrl: "https://provider.example/v1",
        transportFactory: ({ factory, requestTls }) => new EnvHttpProxyAgent({ factory,
          httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy: "", requestTls: { ...requestTls, ca: certificate } })
      })).resolves.toMatchObject({ text: "ok" });
      expect(tunnels).toEqual(["93.184.216.34:443"]);
      expect(received).toEqual([{ host: "provider.example", authorization: "Bearer test-fixture-credential", servername: "provider.example" }]);
    }), { secure: true });
  });

  it("uses the native enabled proxy by default and closes only its request-owned transport", async () => {
    await withServer(async (port, received) => withProxy(port, async (proxyUrl, tunnels) => {
      lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      vi.stubEnv("NODE_USE_ENV_PROXY", "1"); vi.stubEnv("NODE_OPTIONS", "");
      vi.stubEnv("http_proxy", proxyUrl); vi.stubEnv("https_proxy", proxyUrl); vi.stubEnv("no_proxy", "");
      const globalClose = vi.spyOn(originalDispatcher, "close"), globalDestroy = vi.spyOn(originalDispatcher, "destroy");
      let owned: Dispatcher | undefined;
      let closeSpy: MockInstance | undefined;
      await fetchProviderChatCompletion({ ...request, env: process.env, fetchImpl: async (url, init) => {
        owned = (init as RequestInit & { dispatcher: Dispatcher }).dispatcher;
        expect(owned).toBeInstanceOf(EnvHttpProxyAgent);
        closeSpy = vi.spyOn(owned, "close");
        return fetch(url, init);
      } });
      expect(tunnels).toEqual(["93.184.216.34:80"]);
      expect(received).toHaveLength(1);
      expect(closeSpy).toHaveBeenCalled();
      expect(globalClose).not.toHaveBeenCalled(); expect(globalDestroy).not.toHaveBeenCalled();
    }));
  });

  it("does not enable ambient proxy variables when native proxy use is explicitly disabled", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubEnv("NODE_USE_ENV_PROXY", "1"); vi.stubEnv("NODE_OPTIONS", "--no-use-env-proxy");
    vi.stubEnv("http_proxy", "http://127.0.0.1:1");
    let owned: Dispatcher | undefined;
    let closeSpy: MockInstance | undefined;
    await fetchProviderChatCompletion({ ...request, env: process.env, fetchImpl: async (_url, init) => {
      owned = (init as RequestInit & { dispatcher: Dispatcher }).dispatcher;
      expect(owned).toBeInstanceOf(Agent);
      closeSpy = vi.spyOn(owned, "close");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } });
    } });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("destroys only its owned proxied transport when the deadline expires", async () => {
    await withServer(async (port, received) => withProxy(port, async (proxyUrl, tunnels) => {
      lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      let destroySpy: MockInstance | undefined;
      await expect(fetchProviderChatCompletion({ ...request, timeoutMs: 150,
        transportFactory: ({ factory }) => {
          const owned = new EnvHttpProxyAgent({ factory, httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy: "" });
          destroySpy = vi.spyOn(owned, "destroy");
          return owned;
        }
      })).rejects.toMatchObject({ kind: "timeout" });
      await vi.waitFor(() => expect(destroySpy).toHaveBeenCalled());
      expect(received).toHaveLength(1);
      expect(tunnels.length).toBeGreaterThanOrEqual(1);
    }), { delayMs: 1000 });
  });

  it("pins the admitted public address instead of using a later private DNS answer", async () => {
    await withServer(async (port, received) => {
      vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
        .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const connectedHosts: string[] = [];
      let agent: Agent | undefined;
      const transportFactory: NonNullable<Parameters<typeof fetchProviderChatCompletion>[0]["transportFactory"]> = ({ factory }) => agent = new Agent({ factory, connect(options, callback) {
        connectedHosts.push(options.hostname);
        if (options.hostname === "93.184.216.34") {
          callback(new Error("fixture public endpoint unavailable"), null);
        } else {
          // Simulate the unpinned hostname's changed DNS answer at connect time.
          const socket = connect({ host: "127.0.0.1", port });
          socket.once("connect", () => callback(null, socket));
          socket.once("error", error => callback(error, null));
        }
      } });
      try {
        await expect(fetchProviderChatCompletion({ ...request, transportFactory })).rejects.toMatchObject({ kind: "network_error" });
        expect(connectedHosts).toEqual(["93.184.216.34"]);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(received).toEqual([]);
        expect(agent?.destroyed).toBe(true);
      } finally { await agent?.destroy(); }
    });
  });

  it("preserves the provider Host header over a connection to the admitted public address", async () => {
    await withServer(async (port, received) => {
      vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      const connectedHosts: string[] = [];
      let agent: Agent | undefined;
      const transportFactory: NonNullable<Parameters<typeof fetchProviderChatCompletion>[0]["transportFactory"]> = ({ factory }) => agent = new Agent({ factory, connect(options, callback) {
        connectedHosts.push(options.hostname);
        // Local transport fixture stands in for the admitted public endpoint.
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => callback(null, socket));
        socket.once("error", error => callback(error, null));
      } });
      try {
        await expect(fetchProviderChatCompletion({ ...request, transportFactory })).resolves.toMatchObject({ text: "ok" });
        expect(connectedHosts).toEqual(["93.184.216.34"]);
        expect(received).toEqual([{ host: "provider.example", authorization: "Bearer test-fixture-credential" }]);
        expect(agent?.closed).toBe(true);
      } finally { await agent?.destroy(); }
    });
  });

  it("keeps explicitly opted-in local provider transport working", async () => {
    await withServer(async (port, received) => {
      await expect(fetchProviderChatCompletion({ ...request,
        providerUrl: `http://127.0.0.1:${port}/v1`, env: { ALAYA_ALLOW_PRIVATE_PROVIDER_URL: "1" }
      })).resolves.toMatchObject({ text: "ok" });
      expect(received).toHaveLength(1);
      expect(lookup).not.toHaveBeenCalled();
    });
  });
});
