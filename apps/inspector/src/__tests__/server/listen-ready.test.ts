import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerType } from "@hono/node-server";
import { startInspectorServer } from "../../runtime/server.js";

vi.mock("../../launch/launch-proof.js", () => ({
  readInspectorLaunchProof: () => "listen-ready-code"
}));

describe("inspector listen readiness", () => {
  const servers: ServerType[] = [];

  afterEach(async () => {
    process.exitCode = undefined;
    const closing = servers.splice(0).map(closeServer);
    await Promise.all(closing);
  });

  it("does not write ready before listening, then emits once and returns the listening server", async () => {
    const port = await allocateLoopbackPort();
    const stdout = createWriteCollector();
    const pending = startInspectorServer({
      env: inspectorListenEnv(port),
      stdout: stdout.stream,
      stderr: createWriteCollector().stream
    });

    expect(stdout.text()).toBe("");

    const server = await pending;
    servers.push(server);

    expect(stdout.text()).toBe("inspector_ready\n");
    expect(server.listening).toBe(true);
    expect(server.address()).toMatchObject({ address: "127.0.0.1", port });
    expect(server.listenerCount("error")).toBe(0);
    server.emit("listening");
    expect(stdout.text()).toBe("inspector_ready\n");
  });

  it("rejects a bind failure with the same error and does not write ready", async () => {
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const address = occupied.address();
    if (address === null || typeof address === "string") {
      occupied.close();
      throw new Error("loopback port expected");
    }
    const stdout = createWriteCollector();
    try {
      await expect(
        startInspectorServer({
          env: inspectorListenEnv(address.port),
          stdout: stdout.stream,
          stderr: createWriteCollector().stream
        })
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(stdout.text()).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function inspectorListenEnv(port: number): NodeJS.ProcessEnv {
  return {
    ALAYA_DAEMON_URL: "http://127.0.0.1:5173",
    ALAYA_INSPECTOR_WORKSPACE_ID: "ws-1",
    ALAYA_INSPECTOR_PORT: String(port)
  };
}

function createWriteCollector(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      }
    } as NodeJS.WritableStream,
    text: () => chunks.join("")
  };
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo | null;
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("loopback port expected");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
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
