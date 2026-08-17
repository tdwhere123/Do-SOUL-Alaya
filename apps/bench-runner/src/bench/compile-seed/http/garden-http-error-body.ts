import { releaseGardenHttpReader } from
  "./stream/garden-http-reader-release.js";

const MAX_ERROR_BODY_BYTES = 16 * 1024;

/**
 * Reads only the bounded prefix needed for a redacted failure fingerprint.
 * A body that stalls or fails is diagnostic-optional: status remains truth.
 */
export async function readBoundedGardenHttpErrorBody(
  response: Response,
  attemptSettlement: Promise<never>,
  onProgress: () => void = () => undefined
): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const decoder = new TextDecoder();
  let body = "";
  let bytesRead = 0;
  let completed = false;
  try {
    while (bytesRead < MAX_ERROR_BODY_BYTES) {
      const result = await Promise.race([reader.read(), attemptSettlement]);
      if (result.done) {
        completed = true;
        body += decoder.decode();
        return body;
      }
      onProgress();
      const remaining = MAX_ERROR_BODY_BYTES - bytesRead;
      const boundedChunk = result.value.subarray(0, remaining);
      bytesRead += boundedChunk.byteLength;
      body += decoder.decode(boundedChunk, { stream: bytesRead < MAX_ERROR_BODY_BYTES });
      if (result.value.byteLength > boundedChunk.byteLength ||
          bytesRead === MAX_ERROR_BODY_BYTES) {
        body += decoder.decode();
        return body;
      }
    }
    return body;
  } catch {
    return undefined;
  } finally {
    releaseGardenHttpReader(reader, completed);
  }
}
