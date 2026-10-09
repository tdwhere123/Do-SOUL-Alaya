import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ProviderChatCompletionError } from "./errors.js";
import { createProviderChatDeadline, type ProviderChatDeadlineOptions } from "./request-deadline.js";
import {
  assertPublicHttpProviderUrl,
  isBlockedProviderHost,
  parseEnvBoolean,
  parseHttpProviderUrl,
  type EnvLookup
} from "@do-soul/alaya-protocol";

const PRIVATE_PROVIDER_OPT_IN = "ALAYA_ALLOW_PRIVATE_PROVIDER_URL";

export function assertAllowedProviderChatUrl(
  endpoint: string,
  env: EnvLookup = {}
): void {
  assertPublicHttpProviderUrl(endpoint, {
    allowPrivate: parseEnvBoolean(env[PRIVATE_PROVIDER_OPT_IN], PRIVATE_PROVIDER_OPT_IN)
  });
}

export async function assertAllowedProviderChatUrlResolved(
  endpoint: string,
  env: EnvLookup = {},
  deadlineOptions?: ProviderChatDeadlineOptions
): Promise<void> {
  if (deadlineOptions === undefined) return await assertResolvedProviderUrl(endpoint, env);
  const deadline = createProviderChatDeadline(deadlineOptions);
  try {
    deadlineOptions.abortSignal?.throwIfAborted();
    await deadline.settle(assertResolvedProviderUrl(endpoint, env));
  } catch (cause) {
    // Caller cancellation keeps its original reason; readiness is not a transport attempt.
    deadlineOptions.abortSignal?.throwIfAborted();
    if (deadline.signal.aborted) {
      throw new ProviderChatCompletionError("provider readiness timed out", "timeout", null, { cause });
    }
    throw cause;
  } finally { deadline.dispose(); }
}

async function assertResolvedProviderUrl(endpoint: string, env: EnvLookup): Promise<void> {
  assertAllowedProviderChatUrl(endpoint, env);
  if (parseEnvBoolean(env[PRIVATE_PROVIDER_OPT_IN], PRIVATE_PROVIDER_OPT_IN)) {
    return;
  }
  await assertProviderHostResolvesPublic(endpoint);
}

export async function assertProviderHostResolvesPublic(endpoint: string): Promise<void> {
  const host = parseHttpProviderUrl(endpoint).hostname.replace(/^\[|\]$/gu, "");
  if (isIP(host) !== 0) {
    return;
  }
  let answers: readonly { readonly address: string }[];
  try {
    answers = await lookup(host, { all: true });
  } catch {
    throw new Error("provider url host could not be resolved");
  }
  if (answers.length === 0) {
    throw new Error("provider url host could not be resolved");
  }
  for (const answer of answers) {
    if (isBlockedProviderHost(answer.address)) {
      throw new Error(
        "provider url must not target a private, loopback, link-local, or metadata host"
      );
    }
  }
}
