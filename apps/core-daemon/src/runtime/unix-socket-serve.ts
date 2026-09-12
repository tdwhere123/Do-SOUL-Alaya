import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { createConnection } from "node:net";
import { createAdaptorServer } from "@hono/node-server";

type FetchCallback = Parameters<typeof createAdaptorServer>[0]["fetch"];

const SOCKET_PROBE_TIMEOUT_MS = 250;

export async function serveDaemonUnixSocket(
  fetch: FetchCallback,
  socketPath: string
): Promise<Server> {
  await removeStaleUnixSocket(socketPath);
  const server = createAdaptorServer({ fetch }) as Server;
  const previousUmask = process.umask(0o077);
  try {
    await listenUnixPath(server, socketPath);
  } finally {
    process.umask(previousUmask);
  }
  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  server.once("close", () => {
    try {
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
    } catch {
      // Stale path cleanup is best-effort after close.
    }
  });
  return server;
}

async function removeStaleUnixSocket(socketPath: string): Promise<void> {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(socketPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (!stats.isSocket()) {
    throw Object.assign(new Error(`unix socket path exists and is not a socket: ${socketPath}`), {
      code: "EEXIST"
    });
  }
  if (await isLiveUnixSocket(socketPath)) {
    throw Object.assign(new Error(`unix socket already in use: ${socketPath}`), {
      code: "EADDRINUSE"
    });
  }
  unlinkSync(socketPath);
}

function isLiveUnixSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(true);
    }, SOCKET_PROBE_TIMEOUT_MS);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

function listenUnixPath(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
