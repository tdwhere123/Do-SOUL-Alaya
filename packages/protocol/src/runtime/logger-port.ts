export type LoggerPort = Readonly<{
  trace(message: string, meta: Record<string, unknown>): void;
  debug(message: string, meta: Record<string, unknown>): void;
  info(message: string, meta: Record<string, unknown>): void;
  warn(message: string, meta: Record<string, unknown>): void;
  error(message: string, meta: Record<string, unknown>): void;
  fatal(message: string, meta: Record<string, unknown>): void;
}>;

export type LoggerCorrelationIds = Readonly<{
  readonly request_id?: string;
  readonly run_id?: string;
  readonly correlation_id?: string;
}>;

export type DiagnosticLogger = Pick<LoggerPort, "warn" | "error">;

const discardDiagnosticLogger: DiagnosticLogger = Object.freeze({
  warn: () => undefined,
  error: () => undefined
});

let diagnosticLogger: DiagnosticLogger = discardDiagnosticLogger;

/** Process-wide diagnostic sink for leaf packages that cannot import the daemon pino owner. */
export function bindDiagnosticLogger(logger: DiagnosticLogger): void {
  diagnosticLogger = logger;
}

export function diagnosticWarn(message: string, meta: Record<string, unknown> = {}): void {
  diagnosticLogger.warn(message, meta);
}

export function diagnosticError(message: string, meta: Record<string, unknown> = {}): void {
  diagnosticLogger.error(message, meta);
}

export function withLoggerCorrelation(
  meta: Record<string, unknown>,
  ids: LoggerCorrelationIds
): Record<string, unknown> {
  const enriched = { ...meta };
  if (ids.request_id !== undefined && ids.request_id.length > 0) {
    enriched.request_id = ids.request_id;
  }
  if (ids.run_id !== undefined && ids.run_id.length > 0) {
    enriched.run_id = ids.run_id;
  }
  if (ids.correlation_id !== undefined && ids.correlation_id.length > 0) {
    enriched.correlation_id = ids.correlation_id;
  }
  return enriched;
}

export function bindLoggerCorrelation(
  logger: LoggerPort,
  ids: LoggerCorrelationIds
): LoggerPort {
  return Object.freeze({
    trace: (message, meta) => logger.trace(message, withLoggerCorrelation(meta, ids)),
    debug: (message, meta) => logger.debug(message, withLoggerCorrelation(meta, ids)),
    info: (message, meta) => logger.info(message, withLoggerCorrelation(meta, ids)),
    warn: (message, meta) => logger.warn(message, withLoggerCorrelation(meta, ids)),
    error: (message, meta) => logger.error(message, withLoggerCorrelation(meta, ids)),
    fatal: (message, meta) => logger.fatal(message, withLoggerCorrelation(meta, ids))
  });
}
