import { DEFAULT_DAEMON_HOST } from "./daemon-defaults.js";

type DaemonHostEnvLike = {
  DAEMON_HOST?: string;
  ALAYA_ALLOW_REMOTE_DAEMON?: string;
};

export function isRemoteDaemonOptInEnabled(envLike: DaemonHostEnvLike): boolean {
  return envLike.ALAYA_ALLOW_REMOTE_DAEMON === "1";
}

function readOptionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function resolveDaemonHostFromEnv(envLike: DaemonHostEnvLike): string {
  const configuredHost = readOptionalEnvValue(envLike.DAEMON_HOST);
  const host = configuredHost ?? DEFAULT_DAEMON_HOST;
  const allowRemoteDaemon = isRemoteDaemonOptInEnabled(envLike);

  if (!allowRemoteDaemon && !isLoopbackHost(host)) {
    throw new Error(
      `DAEMON_HOST="${host}" is not loopback. Set ALAYA_ALLOW_REMOTE_DAEMON=1 to allow remote daemon listening.`,
    );
  }

  return host;
}
