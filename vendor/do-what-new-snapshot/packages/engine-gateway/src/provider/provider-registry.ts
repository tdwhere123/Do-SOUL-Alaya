import { isIP } from "node:net";
import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  EngineError,
  EngineErrorKind,
  EngineProvider,
  type EngineBinding
} from "@do-what/protocol";

export function resolveLanguageModel(
  binding: EngineBinding,
  getEnv: (key: string) => string | undefined = key => process.env[key],
  apiKeyOverride?: string
): LanguageModel {
  const apiKey = apiKeyOverride ?? resolveApiKey(binding, getEnv);

  switch (binding.provider) {
    case EngineProvider.OPENAI: {
      if (binding.base_url !== null) {
        throw new EngineError(
          "OpenAI bindings do not accept a base URL override.",
          EngineErrorKind.MODEL_ERROR
        );
      }

      const openai = createOpenAI({
        apiKey,
        baseURL: undefined
      });
      return openai.chat(binding.model);
    }
    case EngineProvider.ANTHROPIC: {
      if (binding.base_url !== null) {
        throw new EngineError(
          "Anthropic bindings do not accept a base URL override.",
          EngineErrorKind.MODEL_ERROR
        );
      }

      const anthropic = createAnthropic({ apiKey });
      return anthropic.languageModel(binding.model);
    }
    case EngineProvider.CUSTOM: {
      const openai = createOpenAI({
        apiKey,
        baseURL: validateCustomProviderBaseUrl(binding.base_url, getEnv)
      });
      return openai.chat(binding.model);
    }
    default:
      throw new EngineError(`Unknown provider: ${binding.provider}`, EngineErrorKind.MODEL_ERROR);
  }
}

export function readApiKey(
  binding: EngineBinding,
  getEnv: (key: string) => string | undefined = key => process.env[key]
): string | undefined {
  if ("api_key" in binding && typeof binding.api_key === "string" && binding.api_key.length > 0) {
    return binding.api_key;
  }

  const envName = "api_key_ref" in binding ? binding.api_key_ref : undefined;
  return typeof envName === "string" ? getEnv(envName) : undefined;
}

export function resolveApiKey(
  binding: EngineBinding,
  getEnv: (key: string) => string | undefined
): string {
  const apiKey = readApiKey(binding, getEnv);

  if (!apiKey) {
    throw new EngineError("Authentication with the model provider failed.", EngineErrorKind.AUTH);
  }

  return apiKey;
}

function validateCustomProviderBaseUrl(
  baseUrl: string | null,
  getEnv: (key: string) => string | undefined
): string {
  if (!baseUrl) {
    throw new EngineError("Custom providers require a base URL.", EngineErrorKind.MODEL_ERROR);
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new EngineError("Custom providers require a public HTTPS base URL.", EngineErrorKind.MODEL_ERROR);
  }

  const hostname = normalizeHostname(parsed.hostname);
  const rawHostname = normalizeHostname(readRawHostname(baseUrl) ?? hostname);

  if (
    getEnv("DO_WHAT_ALLOW_UNSAFE_CUSTOM_PROVIDER_BASE_URL") === "1" &&
    isLoopbackCustomProviderBaseUrl(parsed, hostname, rawHostname)
  ) {
    return baseUrl;
  }

  if (
    parsed.protocol !== "https:" ||
    isBlockedHostname(hostname) ||
    isBlockedNonDottedQuadIpv4(rawHostname)
  ) {
    throw new EngineError("Custom providers require a public HTTPS base URL.", EngineErrorKind.MODEL_ERROR);
  }

  return baseUrl;
}

function isLoopbackCustomProviderBaseUrl(url: URL, hostname: string, rawHostname: string): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  if (isBlockedNonDottedQuadIpv4(rawHostname)) {
    return false;
  }

  return hostname === "localhost" || isLoopbackIpv4(hostname) || hostname === "::1";
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.+$/, "")
    .toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }

  return isBlockedIpv4(hostname) || isBlockedIpv6(hostname);
}

function isBlockedIpv4(hostname: string): boolean {
  if (!isCanonicalDottedQuadIpv4(hostname)) {
    return false;
  }

  const octets = hostname.split(".").map((value) => Number.parseInt(value, 10));
  return isBlockedIpv4Octets(octets);
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (isIP(normalized) !== 6) {
    return false;
  }

  const hextets = expandIpv6Hextets(normalized);
  if (hextets === "blocked") {
    return true;
  }

  if (hextets.every((value) => value === 0)) {
    return true;
  }

  if (hextets.slice(0, -1).every((value) => value === 0) && hextets[7] === 1) {
    return true;
  }

  if (hextets.slice(0, 5).every((value) => value === 0) && hextets[5] === 0xffff) {
    const mappedOctets = [
      hextets[6] >> 8,
      hextets[6] & 0xff,
      hextets[7] >> 8,
      hextets[7] & 0xff
    ];
    if (isBlockedIpv4Octets(mappedOctets)) {
      return true;
    }
  }

  const [firstHextet] = hextets;
  return (
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
  );
}

function isLoopbackIpv4(hostname: string): boolean {
  if (!isCanonicalDottedQuadIpv4(hostname)) {
    return false;
  }

  return Number.parseInt(hostname.split(".")[0] ?? "", 10) === 127;
}

function isCanonicalDottedQuadIpv4(hostname: string): boolean {
  return /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(
    hostname
  );
}

function isBlockedIpv4Octets(octets: readonly number[]): boolean {
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

function isBlockedNonDottedQuadIpv4(hostname: string): boolean {
  if (hostname.includes(":") || isCanonicalDottedQuadIpv4(hostname)) {
    return false;
  }

  return /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(hostname);
}

function expandIpv6Hextets(hostname: string): readonly number[] | "blocked" {
  const parts = hostname.split("::");
  if (parts.length > 2) {
    return "blocked";
  }

  const left = readIpv6Segments(parts[0] ?? "");
  const right = readIpv6Segments(parts[1] ?? "");
  if (left === "blocked" || right === "blocked") {
    return "blocked";
  }

  if (parts.length === 1) {
    return left.length === 8 ? left : "blocked";
  }

  const missingSegments = 8 - left.length - right.length;
  if (missingSegments < 1) {
    return "blocked";
  }

  return [
    ...left,
    ...Array.from({ length: missingSegments }, () => 0),
    ...right
  ];
}

function readIpv6Segments(part: string): readonly number[] | "blocked" {
  if (part.length === 0) {
    return [];
  }

  const values: number[] = [];
  for (const segment of part.split(":")) {
    if (segment.length === 0) {
      return "blocked";
    }

    if (segment.includes(".")) {
      if (!isCanonicalDottedQuadIpv4(segment)) {
        return "blocked";
      }

      const octets = segment.split(".").map((value) => Number.parseInt(value, 10));
      values.push(
        (octets[0] << 8) | octets[1],
        (octets[2] << 8) | octets[3]
      );
      continue;
    }

    const value = Number.parseInt(segment, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) {
      return "blocked";
    }

    values.push(value);
  }

  return values;
}

function readRawHostname(baseUrl: string): string | null {
  const schemeIndex = baseUrl.indexOf("://");
  if (schemeIndex === -1) {
    return null;
  }

  let authority = baseUrl.slice(schemeIndex + 3);
  const authorityEnd = authority.search(/[/?#]/);
  if (authorityEnd !== -1) {
    authority = authority.slice(0, authorityEnd);
  }

  const userInfoIndex = authority.lastIndexOf("@");
  if (userInfoIndex !== -1) {
    authority = authority.slice(userInfoIndex + 1);
  }

  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    return closingBracket === -1 ? null : authority.slice(1, closingBracket);
  }

  const portIndex = authority.lastIndexOf(":");
  if (portIndex !== -1 && authority.indexOf(":") === portIndex) {
    return authority.slice(0, portIndex);
  }

  return authority;
}
