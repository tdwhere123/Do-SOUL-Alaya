import type { Context } from "hono";

class RequestBodyLimitError extends Error {
  public readonly status = 413;

  public constructor() {
    super("Payload Too Large");
    this.name = "BodyLimitError";
  }
}

export function applyLazyRequestBodyLimit(context: Context, maxSize: number): void {
  const body = context.req.raw.body;
  if (body === null) {
    return;
  }

  const requestInit: RequestInit & { duplex: "half" } = {
    body: limitReadableStream(body, maxSize),
    duplex: "half"
  };
  context.req.raw = new Request(context.req.raw, requestInit);
}

function limitReadableStream(
  body: ReadableStream<Uint8Array>,
  maxSize: number
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let size = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      size += value.byteLength;
      if (size > maxSize) {
        controller.error(new RequestBodyLimitError());
        void reader.cancel().catch(() => undefined);
        return;
      }

      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    }
  });
}
