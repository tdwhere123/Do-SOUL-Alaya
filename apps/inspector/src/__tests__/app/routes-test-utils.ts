import type { createInspectorApp } from "../../runtime/app.js";

export async function authenticatedRequest(
  app: ReturnType<typeof createInspectorApp>,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return await app.request(path, withInspectorAuth(init));
}

export function withInspectorAuth(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("x-alaya-inspector-token", "token");
  return { ...init, headers };
}

export function createChunkedJsonRequest(url: string, bodyText: string): Request {
  const bytes = new TextEncoder().encode(bodyText);
  let sent = false;

  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alaya-inspector-token": "token"
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(bytes);
        controller.close();
      }
    }),
    duplex: "half"
  });
}

export function createNeverEndingChunkedJsonRequest(url: string, bodyText: string): Request {
  const bytes = new TextEncoder().encode(bodyText);
  let sent = false;

  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alaya-inspector-token": "token"
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          return;
        }
        sent = true;
        controller.enqueue(bytes);
      }
    }),
    duplex: "half"
  });
}

export function createEmptyChunkedJsonRequest(url: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alaya-inspector-token": "token"
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.close();
      }
    }),
    duplex: "half"
  });
}

export async function withResponseTimeout(
  responsePromise: Response | Promise<Response>,
  timeoutMs = 200
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      responsePromise,
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`response timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

