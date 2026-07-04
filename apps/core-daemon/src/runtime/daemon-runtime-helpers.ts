import { pino, type Logger, type LoggerOptions } from "pino";
import {
  ManifestationBudgetConfigSchema,
  type ManifestationBudgetConfig
} from "@do-soul/alaya-protocol";
import type { WorkspaceService } from "@do-soul/alaya-core";

type ConfigRepoPort = {
  getParsed<TValue>(
    key: string,
    parser: { parse(value: unknown): TValue }
  ): TValue | null | Promise<TValue | null>;
};

type CurrencyRecord = Readonly<{
  updated_at: string;
}>;

type CurrencyRecordRepo = {
  findById(id: string): Promise<CurrencyRecord | null>;
};

export type LoggerPort = Readonly<{
  trace(message: string, meta: Record<string, unknown>): void;
  debug(message: string, meta: Record<string, unknown>): void;
  info(message: string, meta: Record<string, unknown>): void;
  warn(message: string, meta: Record<string, unknown>): void;
  error(message: string, meta: Record<string, unknown>): void;
  fatal(message: string, meta: Record<string, unknown>): void;
}>;

export type WarnLogger = LoggerPort;

type UnhandledRejectionListener = (reason: unknown) => void;

type UnhandledRejectionProcessPort = {
  exitCode?: number | string | null;
  on(event: "unhandledRejection", listener: UnhandledRejectionListener): unknown;
};

type UnhandledRejectionHandlerOptions = Readonly<{
  shutdown?: () => Promise<unknown> | unknown;
}>;

const UNHANDLED_REJECTION_LOGGER_KEY = Symbol.for(
  "do-soul.alaya.unhandledRejectionLogger"
);
const UNHANDLED_REJECTION_LISTENER_KEY = Symbol.for(
  "do-soul.alaya.unhandledRejectionListener"
);
const UNHANDLED_REJECTION_SEEN_KEY = Symbol.for(
  "do-soul.alaya.unhandledRejectionSeen"
);
const UNHANDLED_REJECTION_SHUTDOWN_KEY = Symbol.for(
  "do-soul.alaya.unhandledRejectionShutdown"
);
const UNHANDLED_REJECTION_SHUTDOWN_PROMISE_KEY = Symbol.for(
  "do-soul.alaya.unhandledRejectionShutdownPromise"
);

type UnhandledRejectionProcessState = UnhandledRejectionProcessPort & {
  [UNHANDLED_REJECTION_LOGGER_KEY]?: Pick<LoggerPort, "error">;
  [UNHANDLED_REJECTION_LISTENER_KEY]?: UnhandledRejectionListener;
  [UNHANDLED_REJECTION_SEEN_KEY]?: boolean;
  [UNHANDLED_REJECTION_SHUTDOWN_KEY]?: () => Promise<unknown> | unknown;
  [UNHANDLED_REJECTION_SHUTDOWN_PROMISE_KEY]?: Promise<void>;
};

// Defense-in-depth field redaction. pino paths only match a single level
// (`token` = top-level, `*.token` = one nested level); there is no recursive
// `**`. The summarizers in middleware/error-handler.ts remain the first line —
// this is the belt-and-suspenders second line for secrets that slip through.
const REDACT_PATHS: readonly string[] = [
  // tokens / api keys / secrets / credentials (top-level + one nested level)
  "token",
  "*.token",
  "request_token",
  "*.request_token",
  "reviewer_token",
  "*.reviewer_token",
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "secret",
  "*.secret",
  "credential",
  "*.credential",
  "password",
  "*.password",
  // auth headers
  "authorization",
  "*.authorization",
  "headers.authorization",
  // keychain secrets
  "keychainSecret",
  "*.keychainSecret",
  // DB / engine connection strings
  "connectionString",
  "*.connectionString",
  // raw error messages (already stripped by the summarizers; redact here too)
  "*.message",
  "err.message",
  "error.message",
  "cause.message"
];

function resolveLogLevel(): LoggerOptions["level"] {
  // ALAYA_-prefixed per the project env convention; bare LOG_LEVEL kept as fallback.
  const raw = (process.env.ALAYA_LOG_LEVEL ?? process.env.LOG_LEVEL)?.trim().toLowerCase();
  const allowed = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
  return raw !== undefined && allowed.includes(raw) ? (raw as LoggerOptions["level"]) : "info";
}

function createBasePinoLogger(): Logger {
  const options: LoggerOptions = {
    level: resolveLogLevel(),
    redact: { paths: [...REDACT_PATHS], censor: "[Redacted]" }
  };
  // invariant: diagnostics go to stderr (fd 2), never stdout. stdout is the
  // machine channel for CLI --json output and MCP stdio JSON-RPC frames; a log
  // line on stdout corrupts both. Human-readable transport for interactive
  // (TTY) sessions only; pino-pretty is a devDependency, so it must never run
  // in a deployed daemon (no TTY there).
  if (process.stdout.isTTY === true) {
    options.transport = {
      target: "pino-pretty",
      options: { colorize: true, destination: 2 }
    };
    return pino(options);
  }
  return pino(options, process.stderr);
}

// Reuse a single base logger across createWarnLogger() calls (pino transports
// spin up worker threads; one is enough for the whole daemon process).
let sharedPinoLogger: Logger | null = null;

function getSharedPinoLogger(): Logger {
  sharedPinoLogger ??= createBasePinoLogger();
  return sharedPinoLogger;
}

function formatUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWarnLogger(): LoggerPort {
  const logger = getSharedPinoLogger();
  return Object.freeze({
    trace: (message: string, meta: Record<string, unknown>) => {
      logger.trace(meta, message);
    },
    debug: (message: string, meta: Record<string, unknown>) => {
      logger.debug(meta, message);
    },
    info: (message: string, meta: Record<string, unknown>) => {
      logger.info(meta, message);
    },
    // pino is object-first: warn(meta, message). The WarnLogger port is
    // message-first, so swap the argument order at the boundary.
    warn: (message: string, meta: Record<string, unknown>) => {
      logger.warn(meta, message);
    },
    error: (message: string, meta: Record<string, unknown>) => {
      logger.error(meta, message);
    },
    fatal: (message: string, meta: Record<string, unknown>) => {
      logger.fatal(meta, message);
    }
  });
}

export function installUnhandledRejectionHandler(
  logger: Pick<LoggerPort, "error">,
  processPort: UnhandledRejectionProcessPort = process,
  options: UnhandledRejectionHandlerOptions = {}
): void {
  const processState = processPort as UnhandledRejectionProcessState;
  processState[UNHANDLED_REJECTION_LOGGER_KEY] = logger;
  if (options.shutdown !== undefined) {
    const priorShutdown = processState[UNHANDLED_REJECTION_SHUTDOWN_KEY];
    if (priorShutdown !== undefined && priorShutdown !== options.shutdown) {
      processState[UNHANDLED_REJECTION_SEEN_KEY] = false;
      processState[UNHANDLED_REJECTION_SHUTDOWN_PROMISE_KEY] = undefined;
    }
    processState[UNHANDLED_REJECTION_SHUTDOWN_KEY] = options.shutdown;
  }
  if (processState[UNHANDLED_REJECTION_LISTENER_KEY] !== undefined) {
    ensureUnhandledRejectionShutdown(processState, processPort);
    return;
  }

  const listener: UnhandledRejectionListener = (reason) => {
    processState[UNHANDLED_REJECTION_SEEN_KEY] = true;
    processState[UNHANDLED_REJECTION_LOGGER_KEY]?.error("unhandled rejection", {
      reason: formatUnknownErrorMessage(reason)
    });
    processPort.exitCode = 1;
    ensureUnhandledRejectionShutdown(processState, processPort);
  };

  processPort.on("unhandledRejection", listener);
  processState[UNHANDLED_REJECTION_LISTENER_KEY] = listener;
  ensureUnhandledRejectionShutdown(processState, processPort);
}

export async function warnOnRejectedBackgroundTask(
  task: Promise<unknown>,
  warn: WarnLogger["warn"],
  message: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  try {
    await task;
  } catch (error) {
    warn(message, {
      ...meta,
      error: formatUnknownErrorMessage(error)
    });
  }
}

function ensureUnhandledRejectionShutdown(
  processState: UnhandledRejectionProcessState,
  processPort: UnhandledRejectionProcessPort
): void {
  if (processState[UNHANDLED_REJECTION_SEEN_KEY] !== true) {
    return;
  }
  if (processState[UNHANDLED_REJECTION_SHUTDOWN_KEY] === undefined) {
    return;
  }
  if (processState[UNHANDLED_REJECTION_SHUTDOWN_PROMISE_KEY] !== undefined) {
    return;
  }

  processState[UNHANDLED_REJECTION_SHUTDOWN_PROMISE_KEY] = Promise.resolve(
    processState[UNHANDLED_REJECTION_SHUTDOWN_KEY]!()
  )
    .catch((error) => {
      processState[UNHANDLED_REJECTION_LOGGER_KEY]?.error(
        "unhandled rejection shutdown failed",
        {
          error: formatUnknownErrorMessage(error)
        }
      );
      processPort.exitCode = 1;
    })
    .then(() => undefined);
}

export type ReconcileBootstrapPathsForAllWorkspacesDeps = Readonly<{
  readonly workspaceRepo: Readonly<{
    list(): Promise<
      readonly Readonly<{
        readonly workspace_id: string;
        readonly workspace_state?: string;
      }>[]
    >;
  }>;
  readonly workspaceService: Pick<WorkspaceService, "reconcileBootstrapPaths">;
  readonly warn: WarnLogger["warn"];
}>;

export async function reconcileBootstrapPathsForAllWorkspaces(
  deps: ReconcileBootstrapPathsForAllWorkspacesDeps
): Promise<void> {
  let workspaces: readonly Readonly<{
    readonly workspace_id: string;
    readonly workspace_state?: string;
  }>[];
  try {
    workspaces = await deps.workspaceRepo.list();
  } catch (error) {
    deps.warn("bootstrap reconcile enumeration failed", {
      error: formatUnknownErrorMessage(error)
    });
    return;
  }

  for (const workspace of workspaces) {
    if (workspace.workspace_state !== undefined && workspace.workspace_state !== "active") {
      continue;
    }

    try {
      await deps.workspaceService.reconcileBootstrapPaths(workspace.workspace_id);
    } catch (error) {
      deps.warn("bootstrap reconcile failed", {
        workspace_id: workspace.workspace_id,
        error: formatUnknownErrorMessage(error)
      });
    }
  }
}

export function createManifestationBudgetConfigProvider(configRepo: ConfigRepoPort): Readonly<{
  getConfig(workspaceId: string): Promise<Readonly<ManifestationBudgetConfig> | null>;
}> {
  return Object.freeze({
    getConfig: async (workspaceId: string): Promise<Readonly<ManifestationBudgetConfig> | null> => {
      const configKey = `workspace:${workspaceId}:manifestation_budget`;
      const rawConfig = await configRepo.getParsed(configKey, ManifestationBudgetConfigSchema);
      return rawConfig === null ? null : ManifestationBudgetConfigSchema.parse(rawConfig);
    }
  });
}

export function createTargetCurrencyCheckPort(input: {
  readonly claimFormRepo: CurrencyRecordRepo;
  readonly slotRepo: CurrencyRecordRepo;
}): Readonly<{
  checkCurrency(
    targetEntityType: string,
    targetEntityId: string,
    sinceTimestamp: string
  ): Promise<
    | Readonly<{ status: "missing" }>
    | Readonly<{ status: "fresh" }>
    | Readonly<{ status: "stale"; stale_since: string }>
  >;
}> {
  return Object.freeze({
    checkCurrency: async (targetEntityType, targetEntityId, sinceTimestamp) => {
      const sinceEpoch = Date.parse(sinceTimestamp);
      if (!Number.isFinite(sinceEpoch)) {
        return { status: "missing" as const };
      }

      const resolveStatus = (updatedAt: string) => {
        const updatedEpoch = Date.parse(updatedAt);
        if (!Number.isFinite(updatedEpoch)) {
          return { status: "missing" as const };
        }

        return updatedEpoch > sinceEpoch
          ? { status: "stale" as const, stale_since: updatedAt }
          : { status: "fresh" as const };
      };

      switch (targetEntityType) {
        case "claim":
        case "claim_form": {
          const claim = await input.claimFormRepo.findById(targetEntityId);
          return claim === null ? { status: "missing" as const } : resolveStatus(claim.updated_at);
        }
        case "slot": {
          const slot = await input.slotRepo.findById(targetEntityId);
          return slot === null ? { status: "missing" as const } : resolveStatus(slot.updated_at);
        }
        default:
          return { status: "missing" as const };
      }
    }
  });
}
