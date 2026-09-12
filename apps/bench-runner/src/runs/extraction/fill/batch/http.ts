import { normalizeGeminiEndpoint } from "../../../provider/gemini-endpoint.js";
import type { GeminiBatchHttp } from "./contract.js";
import { MAX_BATCH_ARTIFACT_BYTES } from "./plan.js";
import { record, resourceName } from "./native-codec.js";

export function createGeminiBatchHttp(input: {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs: number;
  readonly maxResponseBytes?: number;
}): GeminiBatchHttp {
  const endpoint = normalizeGeminiEndpoint(input.endpoint ?? "https://generativelanguage.googleapis.com");
  const maxBytes = input.maxResponseBytes ?? MAX_BATCH_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BATCH_ARTIFACT_BYTES) {
    throw new Error("invalid Gemini Batch HTTP bound");
  }
  const fetchImpl = input.fetch ?? fetch;
  async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const url = new URL(path, endpoint);
    if (url.origin !== endpoint.origin) throw new Error("foreign Gemini Batch upload URL");
    const response = await fetchImpl(url, {
      ...init, redirect: "error",
      headers: { "x-goog-api-key": input.apiKey, ...init.headers },
      signal: signal === undefined ? AbortSignal.timeout(input.timeoutMs)
        : AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)])
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Gemini Batch HTTP ${response.status}`);
    }
    return response;
  }
  const json = async (path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> =>
    JSON.parse(await readBoundedResponse(await request(path, init, signal), maxBytes));
  const post = (value: unknown): RequestInit => ({
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value)
  });
  return {
    endpoint: endpoint.origin,
    upload: async (jsonl, displayName, signal) => {
      const bytes = Buffer.byteLength(jsonl, "utf8");
      if (bytes > MAX_BATCH_ARTIFACT_BYTES) throw new Error("Gemini Batch upload exceeds local limit");
      const start = await request("/upload/v1beta/files", {
        ...post({ file: { displayName } }),
        headers: {
          "content-type": "application/json", "x-goog-upload-protocol": "resumable",
          "x-goog-upload-command": "start", "x-goog-upload-header-content-length": String(bytes),
          "x-goog-upload-header-content-type": "application/jsonl"
        }
      }, signal);
      const uploadUrl = start.headers.get("x-goog-upload-url");
      await start.body?.cancel();
      if (uploadUrl === null) throw new Error("Gemini Batch upload session URL missing");
      const uploaded = await json(uploadUrl, {
        method: "POST", headers: {
          "content-type": "application/jsonl", "x-goog-upload-offset": "0",
          "x-goog-upload-command": "upload, finalize"
        }, body: jsonl
      }, signal);
      const name = record(record(uploaded).file).name;
      return resourceName(name, "files");
    },
    create: (model, inputFile, displayName, signal) => {
      if (!/^gemini-[a-zA-Z0-9._-]+$/u.test(model)) throw new Error("invalid Gemini model");
      return json(`/v1beta/models/${model}:batchGenerateContent`, post({
        batch: { displayName, inputConfig: { fileName: resourceName(inputFile, "files") } }
      }), signal);
    },
    get: (job, signal) => json(`/v1beta/${resourceName(job, "batches")}`, {}, signal),
    cancel: async (job, signal) => {
      const response = await request(`/v1beta/${resourceName(job, "batches")}:cancel`, post({}), signal);
      await response.body?.cancel();
    },
    download: async (file, signal) => readBoundedResponse(await request(
      `/download/v1beta/${resourceName(file, "files")}:download?alt=media`, {}, signal
    ), maxBytes)
  };
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Gemini response exceeds byte cap");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Gemini response body missing");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("Gemini response exceeds byte cap");
      chunks.push(next.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
