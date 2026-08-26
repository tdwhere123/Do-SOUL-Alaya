const PRIVATE_PROVIDER_OPT_IN = "ALAYA_ALLOW_PRIVATE_PROVIDER_URL";

export function assertAllowedProviderChatUrl(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.ALAYA_ALLOW_REMOTE_DAEMON !== "1") {
    return;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("provider url is invalid");
  }
  if (url.protocol !== "https:") {
    throw new Error("remote provider url must use https");
  }
  if (env[PRIVATE_PROVIDER_OPT_IN] === "1") {
    return;
  }
  if (isBlockedProviderHost(url.hostname)) {
    throw new Error("remote provider url must not target a private, loopback, link-local, or metadata host");
  }
}

function isBlockedProviderHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  const ipv4 = parseIpv4(host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host);
  if (ipv4 !== null) {
    return isBlockedIpv4(ipv4);
  }
  if (host.includes(":")) {
    return host === "::1" ||
      host.startsWith("fe80:") ||
      host.startsWith("fc") ||
      host.startsWith("fd");
  }
  return false;
}

function parseIpv4(host: string): readonly [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });
  if (octets.some((value) => !Number.isInteger(value))) return null;
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isBlockedIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}
