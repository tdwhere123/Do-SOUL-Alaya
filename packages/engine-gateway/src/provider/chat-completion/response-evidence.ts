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

/**
 * Retain at most maxRetainedBytes. Length and digest cover every byte actually
 * read. maxReadBytes, when set, cancels once that many bytes have been received;
 * it does not drop the remainder of the chunk that crossed the cap.
 */
export async function readProviderResponseWithEvidence(
  response: Response,
  observe?: (snapshot: () => ProviderHttpResponseEvidence) => void,
  maxRetainedBytes = MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES,
  maxReadBytes?: number
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
    // Truncation compares retained bytes with received bytes. Cancellation alone is incompleteness.
    bodyTruncated: byteLength > retainedLength,
    bodyComplete
  });
  observe?.(() => evidence(completed));
  if (reader === undefined) {
    completed = true;
    return { bodyText: "", evidence: evidence(true) };
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = next.value;
      digest.update(bytes);
      byteLength += bytes.byteLength;
      if (maxReadBytes === undefined) chunks.push(bytes);
      if (retainedLength < maxRetainedBytes) {
        const prefix = bytes.subarray(0, maxRetainedBytes - retainedLength);
        retained.push(Buffer.from(prefix));
        retainedLength += prefix.byteLength;
      }
      if (maxReadBytes !== undefined && byteLength >= maxReadBytes) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation failure must not rewrite received-byte evidence as a body-read failure.
        }
        return {
          bodyText: decodeProviderResponseBytes(Buffer.concat(retained)),
          evidence: evidence(false)
        };
      }
    }
    completed = true;
    const body = maxReadBytes === undefined ? Buffer.concat(chunks) : Buffer.concat(retained);
    return { bodyText: decodeProviderResponseBytes(body), evidence: evidence(true) };
  } catch (cause) {
    throw new ProviderChatCompletionError(
      "provider chat completion body read failed",
      "body_read_error",
      response.status,
      { cause, httpResponse: evidence(false) }
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cleanup must not replace received-byte evidence or a body-read failure.
    }
  }
}
