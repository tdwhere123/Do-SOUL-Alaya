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
    const normalized = normalizeDaemonEnv(env);
    validateDaemonEnvInputs(normalized);
    return buildValidatedDaemonEnv(env, normalized);
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

function normalizeDaemonEnv(env: DaemonEnvLike) {
  return {
    port: readOptionalTrimmed(env.PORT),
    daemonHost: readOptionalTrimmed(env.DAEMON_HOST),
    allowedOrigin: readOptionalTrimmed(env.ALLOWED_ORIGIN),
    requestToken: readOptionalTrimmed(env.ALAYA_REQUEST_TOKEN),
    remoteOptIn: readOptionalTrimmed(env.ALAYA_ALLOW_REMOTE_DAEMON),
    reviewerToken: readOptionalTrimmed(env.ALAYA_REVIEWER_TOKEN),
    reviewerIdentity: readOptionalTrimmed(env.ALAYA_REVIEWER_IDENTITY)
  };
}

function validateDaemonEnvInputs(input: ReturnType<typeof normalizeDaemonEnv>): void {
  validatePort(input.port);
  validateDaemonHost(input.daemonHost);
  validateAllowedOrigin(input.allowedOrigin);
  validateRemoteOptIn(input.remoteOptIn);
  validateReviewerPair(input.reviewerToken, input.reviewerIdentity);
}

function validatePort(port: string | undefined): void {
  if (port === undefined) {
    return;
  }
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) {
    throw new Error(`Invalid daemon env PORT: ${port}`);
  }
}

function validateDaemonHost(daemonHost: string | undefined): void {
  if (daemonHost !== undefined && daemonHost.length === 0) {
    throw new Error("Invalid daemon env DAEMON_HOST: must not be empty.");
  }
}

function validateAllowedOrigin(allowedOrigin: string | undefined): void {
  if (allowedOrigin === undefined) {
    return;
  }
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

function validateRemoteOptIn(remoteOptIn: string | undefined): void {
  if (remoteOptIn !== undefined && remoteOptIn !== "0" && remoteOptIn !== "1") {
    throw new Error(
      `Invalid daemon env ALAYA_ALLOW_REMOTE_DAEMON: expected "0" or "1", got ${remoteOptIn}`
    );
  }
}

function validateReviewerPair(
  reviewerToken: string | undefined,
  reviewerIdentity: string | undefined
): void {
  if ((reviewerToken === undefined) !== (reviewerIdentity === undefined)) {
    throw new Error(
      "Invalid daemon env: ALAYA_REVIEWER_TOKEN and ALAYA_REVIEWER_IDENTITY must be configured together."
    );
  }
}

function buildValidatedDaemonEnv(
  env: DaemonEnvLike,
  normalized: ReturnType<typeof normalizeDaemonEnv>
): ValidatedDaemonEnv {
  validateLogLevel("ALAYA_LOG_LEVEL", readOptionalTrimmed(env.ALAYA_LOG_LEVEL));
  validateLogLevel("LOG_LEVEL", readOptionalTrimmed(env.LOG_LEVEL));

  return Object.freeze({
    ...(normalized.port === undefined ? {} : { PORT: normalized.port }),
    ...(normalized.daemonHost === undefined ? {} : { DAEMON_HOST: normalized.daemonHost }),
    ...(normalized.allowedOrigin === undefined
      ? {}
      : { ALLOWED_ORIGIN: normalized.allowedOrigin }),
    ...(normalized.requestToken === undefined
      ? {}
      : { ALAYA_REQUEST_TOKEN: normalized.requestToken }),
    ...(normalized.remoteOptIn === undefined
      ? {}
      : { ALAYA_ALLOW_REMOTE_DAEMON: normalized.remoteOptIn }),
    ...(env.ALAYA_LOG_LEVEL === undefined ? {} : { ALAYA_LOG_LEVEL: env.ALAYA_LOG_LEVEL }),
    ...(env.LOG_LEVEL === undefined ? {} : { LOG_LEVEL: env.LOG_LEVEL }),
    ...(normalized.reviewerToken === undefined
      ? {}
      : { ALAYA_REVIEWER_TOKEN: normalized.reviewerToken }),
    ...(normalized.reviewerIdentity === undefined
      ? {}
      : { ALAYA_REVIEWER_IDENTITY: normalized.reviewerIdentity })
  });
}

function validateLogLevel(label: string, value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  if (!ALLOWED_LOG_LEVELS.has(value as (typeof ALLOWED_LOG_LEVELS extends Set<infer T> ? T : never))) {
    throw new Error(`Invalid daemon env ${label}: ${value}`);
  }
}
