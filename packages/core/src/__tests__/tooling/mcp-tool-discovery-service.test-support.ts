import type { McpServerInfo } from "@do-soul/alaya-protocol";

export const validTimestamp = "2026-04-20T10:30:00.000Z";

export function createServer(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    server_name: "filesystem",
    transport_type: "stdio",
    status: "active",
    registered_at: validTimestamp,
    ...overrides
  };
}

export function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve
  };
}
