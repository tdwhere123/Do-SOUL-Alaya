import { createHash } from "node:crypto";
import { ProviderChatCompletionError } from "./errors.js";
import type { ProviderHttpResponseEvidence } from "./types.js";

export const MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES = 64 * 1024;
// Full response evidence is base64-encoded beside decoded content in a 32 MiB shard.
export const MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Match Response.text() while retaining the original bytes for evidence. */
export function decodeProviderResponseBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

export async function readProviderResponseWithEvidence(
  response: Response,
  observe?: (snapshot: () => ProviderHttpResponseEvidence) => void,
  maxRetainedBytes = MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES
): Promise<{
  readonly bodyText: string;
  readonly evidence: ProviderHttpResponseEvidence;
}> {
  const reader = response.body?.getReader();
  const digest = createHash("sha256");
  const chunks: Uint8Array[] = [];
  const retained: Uint8Array[] = [];
  let byteLength = 0;
  let retainedLength = 0;
  let completed = false;
  const evidence = (bodyComplete: boolean): ProviderHttpResponseEvidence => Object.freeze({
    contentType: response.headers.get("content-type"),
    bodyBase64: Buffer.concat(retained).toString("base64"),
    bodyByteLength: byteLength,
    bodySha256: digest.copy().digest("hex"),
    bodyTruncated: byteLength > maxRetainedBytes,
    bodyComplete
  });
  observe?.(() => evidence(completed));
  if (reader === undefined) {
    completed = true;
    const empty = evidence(true);
    return { bodyText: "", evidence: empty };
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = next.value;
      chunks.push(bytes);
      byteLength += bytes.byteLength;
      digest.update(bytes);
      if (retainedLength < maxRetainedBytes) {
        const prefix = bytes.subarray(0, maxRetainedBytes - retainedLength);
        retained.push(prefix);
        retainedLength += prefix.byteLength;
      }
    }
    completed = true;
    const complete = evidence(true);
    return { bodyText: decodeProviderResponseBytes(Buffer.concat(chunks)), evidence: complete };
  } catch (cause) {
    throw new ProviderChatCompletionError(
      "provider chat completion body read failed",
      "body_read_error",
      response.status,
      { cause, httpResponse: evidence(false) }
    );
  } finally {
    reader.releaseLock();
  }
}
