export function parseHttpProviderUrl(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("provider url is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("provider url must use http or https");
  }
  if (url.hostname.length === 0) {
    throw new Error("provider url is invalid");
  }
  return url;
}

export function assertPublicHttpProviderUrl(
  endpoint: string,
  options: { readonly allowPrivate?: boolean } = {}
): void {
  const url = parseHttpProviderUrl(endpoint);
  if (options.allowPrivate === true) {
    return;
  }
  if (isBlockedProviderHost(url.hostname)) {
    throw new Error(
      "provider url must not target a private, loopback, link-local, or metadata host"
    );
  }
}

export function isBlockedProviderHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isBlockedProviderHostname(host)) {
    return true;
  }
  const mapped = parseIpv4MappedFromIpv6(host);
  const ipv4 = mapped ?? parseIpv4(host);
  if (ipv4 !== null) {
    return isBlockedIpv4(ipv4);
  }
  if (host.includes(":")) {
    return isBlockedIpv6(host);
  }
  return false;
}

function isBlockedProviderHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  );
}

function parseIpv4MappedFromIpv6(host: string): readonly [number, number, number, number] | null {
  const mapped = /^::ffff:(?:0:)?(.+)$/u.exec(host);
  if (mapped === null) {
    return null;
  }
  const rest = mapped[1]!;
  const dotted = parseIpv4(rest);
  if (dotted !== null) {
    return dotted;
  }
  const groups = rest.split(":");
  if (groups.length !== 2) {
    return null;
  }
  const high = parseHex16(groups[0]!);
  const low = parseHex16(groups[1]!);
  if (high === null || low === null) {
    return null;
  }
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

function parseHex16(value: string): number | null {
  if (!/^[0-9a-f]{1,4}$/u.test(value)) {
    return null;
  }
  return Number.parseInt(value, 16);
}

function parseIpv4(host: string): readonly [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => {
    if (!/^\d+$/u.test(part)) {
      return Number.NaN;
    }
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });
  if (octets.some((value) => !Number.isInteger(value))) {
    return null;
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isBlockedIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 127 || a === 10 || a === 0 || a >= 224) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  }
  return false;
}

function isBlockedIpv6(host: string): boolean {
  return (
    host === "::1" ||
    host === "::" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("ff")
  );
}
