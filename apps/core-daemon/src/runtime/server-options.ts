import { DEFAULT_DAEMON_HOST } from "./daemon/support/daemon-defaults.js";
import { parseEnvBoolean } from "@do-soul/alaya-protocol";

export type DaemonHostEnvLike = {
  DAEMON_HOST?: string;
  ALAYA_ALLOW_REMOTE_DAEMON?: string;
  ALAYA_ALLOW_WILDCARD_BIND?: string;
  ALAYA_DAEMON_SOCKET?: string;
};

export type DaemonListenPolicy =
  | { readonly kind: "loopback"; readonly host: string }
  | { readonly kind: "unix"; readonly path: string; readonly tcpHost: string };

export function isRemoteDaemonOptInEnabled(envLike: DaemonHostEnvLike): boolean {
  return parseEnvBoolean(envLike.ALAYA_ALLOW_REMOTE_DAEMON, "ALAYA_ALLOW_REMOTE_DAEMON");
}

export function isWildcardBindOptInEnabled(envLike: DaemonHostEnvLike): boolean {
  return parseEnvBoolean(envLike.ALAYA_ALLOW_WILDCARD_BIND, "ALAYA_ALLOW_WILDCARD_BIND");
}

function readOptionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = stripBrackets(host);
  if (normalized.toLowerCase() === "localhost" || normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackHost(normalized.slice("::ffff:".length));
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeLoopbackTcpHost(host: string): string {
  return stripBrackets(host).toLowerCase() === "localhost" ? DEFAULT_DAEMON_HOST : host;
}

/**
 * Whether unknown-peer rate-limit fail-closed should default on.
 * Uses the listen-policy loopback classifier, including IPv4-mapped loopback.
 * A unix socket does not flip this: non-loopback `DAEMON_HOST` still fail-closes
 * missing peer/socket identity. Absent/empty host is the default loopback.
 */
export function isRemoteDaemonBind(envLike: DaemonHostEnvLike): boolean {
  const configuredHost = readOptionalEnvValue(envLike.DAEMON_HOST);
  const host = configuredHost ?? DEFAULT_DAEMON_HOST;
  return !isLoopbackHost(host);
}

export function isWildcardHost(host: string): boolean {
  const normalized = stripBrackets(host);
  return (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "::0" ||
    normalized === "*" ||
    normalized === "0:0:0:0:0:0:0:0"
  );
}

export function isUnixSocketPath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("unix:") || value.startsWith("unix://");
}

function normalizeUnixSocketPath(value: string): string {
  if (value.startsWith("unix://")) {
    return value.slice("unix://".length);
  }
  if (value.startsWith("unix:")) {
    return value.slice("unix:".length);
  }
  return value;
}

export function resolveUnixSocketPath(envLike: DaemonHostEnvLike): string | undefined {
  const fromEnv = readOptionalEnvValue(envLike.ALAYA_DAEMON_SOCKET);
  if (fromEnv !== undefined) {
    return normalizeUnixSocketPath(fromEnv);
  }
  const host = readOptionalEnvValue(envLike.DAEMON_HOST);
  if (host !== undefined && isUnixSocketPath(host)) {
    return normalizeUnixSocketPath(host);
  }
  return undefined;
}

export interface DaemonListenPolicyOverrides {
  readonly hostname?: string;
}

export function resolveDaemonListenPolicy(
  envLike: DaemonHostEnvLike,
  overrides?: DaemonListenPolicyOverrides
): DaemonListenPolicy {
  const overrideHost = readOptionalEnvValue(overrides?.hostname);
  const envSocketPath = resolveUnixSocketPath(envLike);
  const overrideSocketPath =
    overrideHost !== undefined && isUnixSocketPath(overrideHost)
      ? normalizeUnixSocketPath(overrideHost)
      : undefined;
  const socketPath = overrideSocketPath ?? envSocketPath;
  const configuredHost = readOptionalEnvValue(envLike.DAEMON_HOST);
  const tcpHostCandidate =
    overrideHost !== undefined && !isUnixSocketPath(overrideHost)
      ? overrideHost
      : configuredHost !== undefined && !isUnixSocketPath(configuredHost)
        ? configuredHost
        : DEFAULT_DAEMON_HOST;

  if (socketPath !== undefined) {
    // Unix socket is the supported non-loopback alternative; never also bind wildcard TCP.
    // Env DAEMON_HOST is superseded by ALAYA_DAEMON_SOCKET, while programmatic hostname
    // overrides must still be loopback.
    const unixTcpHost =
      overrideHost !== undefined && !isUnixSocketPath(overrideHost)
        ? overrideHost
        : DEFAULT_DAEMON_HOST;
    if (!isLoopbackHost(unixTcpHost)) {
      throw new Error(
        `Plaintext remote HTTP is unsupported for DAEMON_HOST / listen hostname "${unixTcpHost}". Bind loopback (${DEFAULT_DAEMON_HOST}) or set ALAYA_DAEMON_SOCKET to a unix socket path.`
      );
    }
    return { kind: "unix", path: socketPath, tcpHost: normalizeLoopbackTcpHost(unixTcpHost) };
  }

  if (isLoopbackHost(tcpHostCandidate)) {
    return { kind: "loopback", host: normalizeLoopbackTcpHost(tcpHostCandidate) };
  }

  throw new Error(
    `Plaintext remote HTTP is unsupported for DAEMON_HOST / listen hostname "${tcpHostCandidate}". Bind loopback (${DEFAULT_DAEMON_HOST}) or set ALAYA_DAEMON_SOCKET to a unix socket path.`
  );
}

export function warnIfRemoteDaemonListening(
  envLike: DaemonHostEnvLike,
  host: string,
  warn: (message: string) => void
): void {
  if (resolveUnixSocketPath(envLike) !== undefined || isUnixSocketPath(host)) {
    warn(
      `[daemon] unix socket bind enabled. Plaintext remote HTTP is unsupported; do not reuse a long-lived ALAYA_REQUEST_TOKEN for non-loopback binds.`
    );
    return;
  }

  if (!isRemoteDaemonOptInEnabled(envLike) || isLoopbackHost(host)) {
    return;
  }

  warn(
    `[daemon] SECURITY: plaintext remote HTTP on ${host} is unsupported. Use ALAYA_DAEMON_SOCKET or loopback (127.0.0.1). A long-lived ALAYA_REQUEST_TOKEN must not be reused for non-loopback binds.`
  );
}

export function resolveDaemonHostFromEnv(
  envLike: DaemonHostEnvLike,
  overrides?: DaemonListenPolicyOverrides
): string {
  const policy = resolveDaemonListenPolicy(envLike, overrides);
  return policy.kind === "unix" ? policy.tcpHost : policy.host;
}
