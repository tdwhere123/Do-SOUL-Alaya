import { DEFAULT_DAEMON_HOST } from "./daemon/support/daemon-defaults.js";

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
  return envLike.ALAYA_ALLOW_REMOTE_DAEMON === "1";
}

export function isWildcardBindOptInEnabled(envLike: DaemonHostEnvLike): boolean {
  return envLike.ALAYA_ALLOW_WILDCARD_BIND === "1";
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
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackHost(normalized.slice("::ffff:".length));
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
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

export function resolveDaemonListenPolicy(envLike: DaemonHostEnvLike): DaemonListenPolicy {
  const socketPath = resolveUnixSocketPath(envLike);
  const configuredHost = readOptionalEnvValue(envLike.DAEMON_HOST);
  const tcpHostCandidate =
    configuredHost !== undefined && !isUnixSocketPath(configuredHost)
      ? configuredHost
      : DEFAULT_DAEMON_HOST;

  if (socketPath !== undefined) {
    // Unix socket is the supported non-loopback alternative; never also bind wildcard TCP.
    return { kind: "unix", path: socketPath, tcpHost: DEFAULT_DAEMON_HOST };
  }

  if (isLoopbackHost(tcpHostCandidate)) {
    return { kind: "loopback", host: tcpHostCandidate };
  }

  if (!isRemoteDaemonOptInEnabled(envLike)) {
    throw new Error(
      `DAEMON_HOST="${tcpHostCandidate}" is not loopback. Set ALAYA_ALLOW_REMOTE_DAEMON=1 to allow remote daemon listening.`
    );
  }

  if (isWildcardHost(tcpHostCandidate) && !isWildcardBindOptInEnabled(envLike)) {
    throw new Error(
      `DAEMON_HOST="${tcpHostCandidate}" is a wildcard bind. Set ALAYA_ALLOW_WILDCARD_BIND=1 in addition to ALAYA_ALLOW_REMOTE_DAEMON=1.`
    );
  }

  throw new Error(
    `Plaintext remote HTTP is unsupported for DAEMON_HOST="${tcpHostCandidate}". Bind loopback (127.0.0.1) or set ALAYA_DAEMON_SOCKET to a unix socket path.`
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

export function resolveDaemonHostFromEnv(envLike: DaemonHostEnvLike): string {
  const policy = resolveDaemonListenPolicy(envLike);
  return policy.kind === "unix" ? policy.tcpHost : policy.host;
}
