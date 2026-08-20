import { createHash } from "node:crypto";

const PROVIDER_FAILURE_BODY_DIGEST_BYTES = 16_384;
const MAX_IDENTITY_TOKEN_LENGTH = 128;

export interface ProviderFailureIdentity {
  readonly providerCode: string | null;
  readonly providerType: string | null;
  readonly bodyDigest: string | null;
}

const EMPTY_IDENTITY: ProviderFailureIdentity = Object.freeze({
  providerCode: null,
  providerType: null,
  bodyDigest: null
});

export function emptyProviderFailureIdentity(): ProviderFailureIdentity {
  return EMPTY_IDENTITY;
}

export function providerFailureIdentityFromBody(bodyText: string): ProviderFailureIdentity {
  return providerFailureIdentityFromBytes(Buffer.from(bodyText, "utf8"));
}

export async function readOptionalProviderFailureIdentity(
  response: Response
): Promise<ProviderFailureIdentity | undefined> {
  try {
    const bytes = await readBoundedProviderErrorBody(response);
    return bytes === undefined ? undefined : providerFailureIdentityFromBytes(bytes);
  } catch {
    return undefined;
  }
}

function providerFailureIdentityFromBytes(bytes: Uint8Array): ProviderFailureIdentity {
  const bounded = bytes.subarray(0, PROVIDER_FAILURE_BODY_DIGEST_BYTES);
  const parsed = readProviderErrorIdentity(Buffer.from(bounded).toString("utf8"));
  return Object.freeze({
    providerCode: parsed.code,
    providerType: parsed.type,
    bodyDigest: parsed.code !== null || parsed.type !== null
      ? null
      : createHash("sha256").update(bounded).digest("hex")
  });
}

async function readBoundedProviderErrorBody(response: Response): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let completed = false;
  try {
    while (bytesRead < PROVIDER_FAILURE_BODY_DIGEST_BYTES) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      const take = result.value.subarray(0, PROVIDER_FAILURE_BODY_DIGEST_BYTES - bytesRead);
      chunks.push(take);
      bytesRead += take.byteLength;
      if (result.value.byteLength > take.byteLength) break;
    }
    return bytesRead === 0 ? undefined : concatBytes(chunks);
  } finally {
    releaseReader(reader, completed);
  }
}

function releaseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  completed: boolean
): void {
  if (completed) {
    reader.releaseLock();
    return;
  }
  void cancelReader(reader);
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation failure must not retain the reader lock.
  }
  try {
    reader.releaseLock();
  } catch {
    // Cleanup remains best-effort after the read path has already settled.
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function readProviderErrorIdentity(rawBody: string): { code: string | null; type: string | null } {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { code: null, type: null };
    const nested = (parsed as { readonly error?: unknown }).error;
    const error = typeof nested === "object" && nested !== null ? nested : parsed;
    return {
      code: readIdentityField(error, "code"),
      type: readIdentityField(error, "type")
    };
  } catch {
    return { code: null, type: null };
  }
}

function readIdentityField(value: object, key: "code" | "type"): string | null {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" || typeof candidate === "number"
    ? safeProviderIdentityToken(String(candidate))
    : null;
}

export function safeProviderIdentityToken(value: string): string | null {
  return /^[A-Za-z0-9_.:-]+$/.test(value) && value.length <= MAX_IDENTITY_TOKEN_LENGTH
    ? value
    : null;
}
