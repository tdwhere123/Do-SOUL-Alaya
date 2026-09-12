import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  assertPublicHttpProviderUrl,
  isBlockedProviderHost,
  parseHttpProviderUrl
} from "@do-soul/alaya-protocol";

const PRIVATE_PROVIDER_OPT_IN = "ALAYA_ALLOW_PRIVATE_PROVIDER_URL";

export function assertAllowedProviderChatUrl(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  assertPublicHttpProviderUrl(endpoint, {
    allowPrivate: env[PRIVATE_PROVIDER_OPT_IN] === "1"
  });
}

export async function assertAllowedProviderChatUrlResolved(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  assertAllowedProviderChatUrl(endpoint, env);
  if (env[PRIVATE_PROVIDER_OPT_IN] === "1") {
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
