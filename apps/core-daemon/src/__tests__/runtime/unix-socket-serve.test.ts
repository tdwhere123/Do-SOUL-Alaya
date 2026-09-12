import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serveDaemonUnixSocket } from "../../runtime/unix-socket-serve.js";

describe("serveDaemonUnixSocket", () => {
  it("listens on a unix socket path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alaya-unix-socket-"));
    const socketPath = path.join(dir, "alaya.sock");
    const server = await serveDaemonUnixSocket(async () => new Response("ok"), socketPath);
    try {
      await expect(canConnect(socketPath)).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to steal a live unix socket", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alaya-unix-socket-live-"));
    const socketPath = path.join(dir, "alaya.sock");
    const first = await serveDaemonUnixSocket(async () => new Response("ok"), socketPath);
    try {
      await expect(
        serveDaemonUnixSocket(async () => new Response("other"), socketPath)
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(canConnect(socketPath)).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        first.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to unlink a non-socket path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alaya-unix-socket-file-"));
    const socketPath = path.join(dir, "alaya.sock");
    await writeFile(socketPath, "not-a-socket");
    try {
      await expect(
        serveDaemonUnixSocket(async () => new Response("ok"), socketPath)
      ).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", reject);
  });
}
