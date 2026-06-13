const ALLOWED_LOG_LEVELS = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent"
] as const);

type DaemonEnvLike = Readonly<Record<string, string | undefined>>;

export type ValidatedDaemonEnv = Readonly<{
  readonly PORT?: string;
  readonly DAEMON_HOST?: string;
  readonly ALLOWED_ORIGIN?: string;
  readonly ALAYA_REQUEST_TOKEN?: string;
  readonly ALAYA_ALLOW_REMOTE_DAEMON?: string;
  readonly ALAYA_LOG_LEVEL?: string;
  readonly LOG_LEVEL?: string;
  readonly ALAYA_REVIEWER_TOKEN?: string;
  readonly ALAYA_REVIEWER_IDENTITY?: string;
}>;

export const DaemonEnvSchema = Object.freeze({
  parse(env: DaemonEnvLike): ValidatedDaemonEnv {
    const port = readOptionalTrimmed(env.PORT);
    if (port !== undefined) {
      const parsedPort = Number(port);
      if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) {
        throw new Error(`Invalid daemon env PORT: ${port}`);
      }
    }

    const daemonHost = readOptionalTrimmed(env.DAEMON_HOST);
    if (daemonHost !== undefined && daemonHost.length === 0) {
      throw new Error("Invalid daemon env DAEMON_HOST: must not be empty.");
    }

    const allowedOrigin = readOptionalTrimmed(env.ALLOWED_ORIGIN);
    if (allowedOrigin !== undefined) {
      let parsedOrigin: URL;
      try {
        parsedOrigin = new URL(allowedOrigin);
      } catch {
        throw new Error(`Invalid daemon env ALLOWED_ORIGIN: ${allowedOrigin}`);
      }
      if (
        (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") ||
        parsedOrigin.pathname !== "/" ||
        parsedOrigin.search.length > 0 ||
        parsedOrigin.hash.length > 0
      ) {
        throw new Error(
          `Invalid daemon env ALLOWED_ORIGIN: expected bare http(s) origin, got ${allowedOrigin}`
        );
      }
    }

    const remoteOptIn = readOptionalTrimmed(env.ALAYA_ALLOW_REMOTE_DAEMON);
    if (remoteOptIn !== undefined && remoteOptIn !== "0" && remoteOptIn !== "1") {
      throw new Error(
        `Invalid daemon env ALAYA_ALLOW_REMOTE_DAEMON: expected "0" or "1", got ${remoteOptIn}`
      );
    }

    validateLogLevel("ALAYA_LOG_LEVEL", readOptionalTrimmed(env.ALAYA_LOG_LEVEL));
    validateLogLevel("LOG_LEVEL", readOptionalTrimmed(env.LOG_LEVEL));

    const requestToken = readOptionalTrimmed(env.ALAYA_REQUEST_TOKEN);
    if (requestToken !== undefined && requestToken.length === 0) {
      throw new Error("Invalid daemon env ALAYA_REQUEST_TOKEN: must not be empty.");
    }

    const reviewerToken = readOptionalTrimmed(env.ALAYA_REVIEWER_TOKEN);
    const reviewerIdentity = readOptionalTrimmed(env.ALAYA_REVIEWER_IDENTITY);
    if ((reviewerToken === undefined) !== (reviewerIdentity === undefined)) {
      throw new Error(
        "Invalid daemon env: ALAYA_REVIEWER_TOKEN and ALAYA_REVIEWER_IDENTITY must be configured together."
      );
    }

    return Object.freeze({
      ...(port === undefined ? {} : { PORT: port }),
      ...(daemonHost === undefined ? {} : { DAEMON_HOST: daemonHost }),
      ...(allowedOrigin === undefined ? {} : { ALLOWED_ORIGIN: allowedOrigin }),
      ...(requestToken === undefined ? {} : { ALAYA_REQUEST_TOKEN: requestToken }),
      ...(remoteOptIn === undefined ? {} : { ALAYA_ALLOW_REMOTE_DAEMON: remoteOptIn }),
      ...(env.ALAYA_LOG_LEVEL === undefined ? {} : { ALAYA_LOG_LEVEL: env.ALAYA_LOG_LEVEL }),
      ...(env.LOG_LEVEL === undefined ? {} : { LOG_LEVEL: env.LOG_LEVEL }),
      ...(reviewerToken === undefined ? {} : { ALAYA_REVIEWER_TOKEN: reviewerToken }),
      ...(reviewerIdentity === undefined ? {} : { ALAYA_REVIEWER_IDENTITY: reviewerIdentity })
    });
  }
});

export function validateDaemonEnv(env: DaemonEnvLike = process.env): ValidatedDaemonEnv {
  return DaemonEnvSchema.parse(env);
}

function readOptionalTrimmed(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function validateLogLevel(label: string, value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  if (!ALLOWED_LOG_LEVELS.has(value as (typeof ALLOWED_LOG_LEVELS extends Set<infer T> ? T : never))) {
    throw new Error(`Invalid daemon env ${label}: ${value}`);
  }
}
