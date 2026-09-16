import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { createInspectorApp } from "../../runtime/app.js";

describe("inspector loopback listen session", () => {
  it("mints a session cookie through a real loopback listen socket", async () => {
    const staticRoot = await mkdtemp(path.join(tmpdir(), "inspector-listen-"));
    await writeFile(path.join(staticRoot, "index.html"), "<html>ok</html>", "utf8");
    const app = createInspectorApp({
      launchCode: "listen-code",
      staticRoot
    });
    const { server, origin } = await listenLoopback(app);
    try {
      const html = await fetch(`${origin}/`);
      expect(html.status).toBe(200);
      const setCookie = readSetCookie(html);
      expect(setCookie).toMatch(/alaya_inspector_session=/);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).not.toContain("listen-code");

      const status = await fetch(`${origin}/api/status`, {
        headers: { cookie: cookieHeaderFromSetCookie(setCookie) }
      });
      expect(status.status).not.toBe(401);

      const replay = await fetch(`${origin}/api/launch-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "listen-code" })
      });
      expect(replay.status).toBe(401);
    } finally {
      await closeServer(server);
      await rm(staticRoot, { recursive: true, force: true });
    }
  });
});

function listenLoopback(app: ReturnType<typeof createInspectorApp>): Promise<{
  readonly server: ServerType;
  readonly origin: string;
}> {
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0
      },
      (info) => {
        resolve({ server, origin: `http://127.0.0.1:${info.port}` });
      }
    );
    server.once("error", reject);
  });
}

function closeServer(server: ServerType): Promise<void> {
  if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function readSetCookie(response: Response): string {
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    return cookies.join("\n");
  }
  return response.headers.get("set-cookie") ?? "";
}

function cookieHeaderFromSetCookie(setCookie: string): string {
  const match = /alaya_inspector_session=[^;]+/.exec(setCookie);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}
