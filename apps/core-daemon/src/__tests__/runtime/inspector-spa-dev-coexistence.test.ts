import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../runtime/app.js";
import { startInspectorServer } from "../../../../inspector/src/runtime/server.js";

vi.mock("../../../../inspector/src/launch/launch-proof.js", () => ({
  readInspectorLaunchProof: () => "spa-coexist-code"
}));

const DAEMON_PORT = 5173;
const INSPECTOR_PORT = 5174;
const SPA_PORT = 5175;
const TOKEN = "spa-coexist-token";
const LAUNCH_CODE = "spa-coexist-code";
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../inspector/web");

describe("inspector SPA dev coexistence", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    process.exitCode = undefined;
    const pending = closers.splice(0).reverse().map((close) => close());
    await Promise.all(pending);
  });

  it("forwards cookie session /api through Vite 5175 onto production daemon security on 5173", async () => {
    const daemon = await listenProductionDaemonSecurity();
    closers.push(() => closeHono(daemon));
    expect(daemon.address()).toMatchObject({ address: "127.0.0.1", port: DAEMON_PORT });

    const inspector = await startInspectorServer({
      env: {
        ALAYA_DAEMON_URL: `http://127.0.0.1:${DAEMON_PORT}`,
        ALAYA_INSPECTOR_WORKSPACE_ID: "ws-coexist",
        ALAYA_INSPECTOR_PORT: String(INSPECTOR_PORT),
        ALAYA_REQUEST_TOKEN: TOKEN
      },
      stdout: discardStream(),
      stderr: discardStream()
    });
    closers.push(() => closeHono(inspector));
    expect(inspector.address()).toMatchObject({ address: "127.0.0.1", port: INSPECTOR_PORT });

    const vite = await listenCheckedInViteConfig();
    closers.push(() => vite.close());
    expect(vite.address).toMatchObject({ address: "127.0.0.1", port: SPA_PORT });

    const launched = await fetch(`http://127.0.0.1:${SPA_PORT}/api/launch-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: LAUNCH_CODE })
    });
    expect(launched.status).toBe(200);
    const headerCookies = launched.headers.getSetCookie().join("\n");
    const setCookie = headerCookies.length > 0 ? headerCookies : (launched.headers.get("set-cookie") ?? "");
    const cookie = cookieHeaderFromSetCookie(setCookie);

    const unauthenticated = await fetch(`http://127.0.0.1:${SPA_PORT}/api/status`);
    expect(unauthenticated.status).toBe(401);

    const status = await fetch(`http://127.0.0.1:${SPA_PORT}/api/status`, {
      headers: { cookie }
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      success: true,
      data: { daemon: { db_reachable: true, ready: true } }
    });
  }, 60_000);

  it("fails closed when Vite 5175 is already bound, using checked-in strictPort", async () => {
    const occupied = createNetServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(SPA_PORT, "127.0.0.1", () => resolve());
    });
    closers.push(() => closeNet(occupied));

    const vite = await createViteFromCheckedInConfig();
    closers.push(async () => {
      await vite.close();
    });
    await expect(vite.listen()).rejects.toThrow(/Port 5175 is already in use/u);
  }, 60_000);
});

async function listenProductionDaemonSecurity(): Promise<ServerType> {
  // Labelled bounded /status fixture: production createApp token/CORS/desktop
  // wiring plus registerStatusRoutes stubs. No provider or database startup.
  const app = createApp({
    requestProtection: {
      allowedOrigin: "http://localhost:5173",
      requestToken: TOKEN,
      allowDesktopOriginlessRequests: true
    },
    routes: {
      status: {
        startupStepsProvider: () => ["http-app"],
        principalCodingEngineAvailableProvider: () => true,
        probeDatabase: () => true,
        isDraining: () => false,
        mcp: {
          listAllowedServerNames: () => [],
          listEnrolledToolIds: () => [],
          getHealth: () => ({ servers: [] })
        },
        clock: () => "2026-05-05T00:00:00.000Z"
      }
    }
  });
  return await listenHono(app, DAEMON_PORT);
}

async function listenCheckedInViteConfig(): Promise<{
  readonly address: { readonly address: string; readonly port: number };
  close(): Promise<void>;
}> {
  const vite = await createViteFromCheckedInConfig();
  try {
    await vite.listen();
  } catch (error) {
    await vite.close();
    throw error;
  }
  const raw = vite.httpServer?.address();
  if (raw === null || raw === undefined || typeof raw === "string") {
    await vite.close();
    throw new Error("vite loopback address expected");
  }
  return {
    address: { address: raw.address, port: raw.port },
    close: async () => {
      await vite.close();
    }
  };
}

async function createViteFromCheckedInConfig(): Promise<{
  listen(): Promise<unknown>;
  close(): Promise<void>;
  readonly httpServer?: { address(): string | { address: string; port: number } | null };
}> {
  const requireWeb = createRequire(path.join(WEB_ROOT, "package.json"));
  const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href) as {
    createServer: (inline?: Record<string, unknown>) => Promise<{
      listen(): Promise<unknown>;
      close(): Promise<void>;
      readonly httpServer?: { address(): string | { address: string; port: number } | null };
    }>;
  };
  return await createServer({
    root: WEB_ROOT,
    configFile: path.join(WEB_ROOT, "vite.config.ts")
  });
}

function listenHono(app: ReturnType<typeof createApp>, port: number): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
    server.once("error", reject);
    if (server.listening) {
      resolve(server);
      return;
    }
    server.once("listening", () => resolve(server));
  });
}

function cookieHeaderFromSetCookie(setCookie: string): string {
  const match = /alaya_inspector_session=[^;]+/.exec(setCookie);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function discardStream(): NodeJS.WritableStream {
  return {
    write(): boolean {
      return true;
    }
  } as unknown as NodeJS.WritableStream;
}

function closeHono(server: ServerType): Promise<void> {
  if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeNet(server: ReturnType<typeof createNetServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
