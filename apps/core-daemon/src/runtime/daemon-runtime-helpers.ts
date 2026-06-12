import { pino, type Logger, type LoggerOptions } from "pino";
import {
  ManifestationBudgetConfigSchema,
  type ManifestationBudgetConfig
} from "@do-soul/alaya-protocol";
import type { WorkspaceService } from "@do-soul/alaya-core";

type ConfigRepoPort = {
  get<TValue>(key: string): TValue | null | Promise<TValue | null>;
};

type CurrencyRecord = Readonly<{
  updated_at: string;
}>;

type CurrencyRecordRepo = {
  findById(id: string): Promise<CurrencyRecord | null>;
};

export type WarnLogger = Readonly<{
  warn(message: string, meta: Record<string, unknown>): void;
}>;

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
  // Human-readable transport for interactive (TTY) sessions only; the daemon's
  // non-TTY prod path stays raw NDJSON. pino-pretty is a devDependency, so this
  // branch must never run in a deployed daemon (no TTY there).
  if (process.stdout.isTTY === true) {
    options.transport = { target: "pino-pretty", options: { colorize: true } };
  }
  return pino(options);
}

// Reuse a single base logger across createWarnLogger() calls (pino transports
// spin up worker threads; one is enough for the whole daemon process).
let sharedPinoLogger: Logger | null = null;

function getSharedPinoLogger(): Logger {
  sharedPinoLogger ??= createBasePinoLogger();
  return sharedPinoLogger;
}

export function createWarnLogger(): WarnLogger {
  const logger = getSharedPinoLogger();
  return Object.freeze({
    // pino is object-first: warn(meta, message). The WarnLogger port is
    // message-first, so swap the argument order at the boundary.
    warn: (message: string, meta: Record<string, unknown>) => {
      logger.warn(meta, message);
    }
  });
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
      error: error instanceof Error ? error.message : String(error)
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
        error: error instanceof Error ? error.message : String(error)
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
      const rawConfig = await configRepo.get<ManifestationBudgetConfig>(configKey);
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
