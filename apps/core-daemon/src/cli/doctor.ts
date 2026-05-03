import { access, constants as fsConstants } from "node:fs/promises";
import type { EmbeddingStatus, ToolchainStatus } from "@do-soul/alaya-protocol";
import type { DaemonStartupStepRecord } from "../index.js";
import { ALAYA_SYSEXITS, type AlayaCliArgsSchema, type AlayaCliContext, type AlayaSubcommandSpec } from "./bridge.js";

export interface DoctorCommandDependencies {
  readonly getToolchainStatus: () => Promise<ToolchainStatus>;
  readonly getEmbeddingStatus?: (workspaceId: string) => Promise<EmbeddingStatus>;
  readonly getMcpHealth?: () => Promise<Readonly<{ transport: "ready" | "not_ready"; enrolled_tools: number }>>;
  readonly getGardenHealth?: () => Promise<Readonly<{ status: "healthy" | "degraded"; last_pass_at: string | null }>>;
  /**
   * Optional schema readiness probe (p5-system-review-r3 MR-I11). When
   * provided, doctor reports `storage.schema_ok` so an operator can
   * tell apart "db file exists and is writable" from "db is fully
   * migrated for this binary".
   */
  readonly getSchemaSummary?: (
    dbPath: string
  ) => Promise<Readonly<{ persistedMaxVersion: number | null; knownMaxVersion: number; schemaOk: boolean }>>;
  readonly startupStepsProvider?: (
    context: Pick<AlayaCliContext, "daemon">
  ) => readonly DaemonStartupStepRecord[];
  readonly defaultWorkspaceId?: string;
  readonly clock?: () => string;
}

interface DoctorArgs {
  readonly workspaceId: string | null;
}

type DoctorCheckStatus = "pass" | "fail";

interface DoctorReport {
  readonly checked_at: string;
  readonly overall: "green" | "degraded";
  readonly startup: Readonly<{
    ready: boolean;
    completed_steps: readonly string[];
    missing_steps: readonly string[];
  }>;
  readonly storage: Readonly<{
    db_path: string;
    exists: boolean;
    writable: boolean;
    schema_ok: boolean | null;
    schema_version_persisted: number | null;
    schema_version_expected: number | null;
  }>;
  readonly provider: Readonly<{
    workspace_id: string;
    embedding: EmbeddingStatus | null;
    configured: boolean;
  }>;
  readonly mcp: Readonly<{
    transport: "ready" | "not_ready";
    enrolled_tools: number;
  }>;
  readonly garden: Readonly<{
    status: "healthy" | "degraded";
    last_pass_at: string | null;
  }>;
  readonly checks: Readonly<Record<"runtime" | "storage" | "provider" | "mcp" | "garden", DoctorCheckStatus>>;
}

const STARTUP_STEPS = [
  "database",
  "repositories",
  "core-services",
  "garden-runtime",
  "mcp-tooling",
  "http-app"
] as const;

export function createDoctorCommand(
  deps: DoctorCommandDependencies
): AlayaSubcommandSpec<DoctorArgs> {
  const now = deps.clock ?? (() => new Date().toISOString());

  return {
    name: "doctor",
    description: "Report runtime, storage, MCP, Garden, and provider health.",
    argsSchema: doctorArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => {
      const startupSteps =
        deps.startupStepsProvider?.(ctx) ?? ctx.daemon.startupSteps;
      const completedSteps = startupSteps.map((step) => step.step);
      const missingSteps = STARTUP_STEPS.filter((step) => !completedSteps.includes(step));
      const daemonReady = missingSteps.length === 0;

      const toolchainStatus = await deps.getToolchainStatus();
      const storage = await inspectStorage(toolchainStatus.db_path, deps.getSchemaSummary);
      const workspaceId = args.workspaceId ?? deps.defaultWorkspaceId ?? "default";
      const embeddingStatus = deps.getEmbeddingStatus
        ? await deps.getEmbeddingStatus(workspaceId)
        : null;
      const mcp = deps.getMcpHealth
        ? await deps.getMcpHealth()
        : ({
            transport: daemonReady ? "ready" : "not_ready",
            enrolled_tools: 0
          } as const);
      const garden = deps.getGardenHealth
        ? await deps.getGardenHealth()
        : ({
            status: daemonReady ? "healthy" : "degraded",
            last_pass_at: null
          } as const);

      const checks = {
        runtime: daemonReady ? "pass" : "fail",
        storage:
          storage.exists && storage.writable && storage.schema_ok !== false ? "pass" : "fail",
        provider: embeddingStatus === null || embeddingStatus.provider_configured ? "pass" : "fail",
        mcp: mcp.transport === "ready" ? "pass" : "fail",
        garden: garden.status === "healthy" ? "pass" : "fail"
      } satisfies Record<"runtime" | "storage" | "provider" | "mcp" | "garden", DoctorCheckStatus>;

      const overall = Object.values(checks).every((status) => status === "pass")
        ? "green"
        : "degraded";

      const report: DoctorReport = {
        checked_at: now(),
        overall,
        startup: {
          ready: daemonReady,
          completed_steps: completedSteps,
          missing_steps: missingSteps
        },
        storage,
        provider: {
          workspace_id: workspaceId,
          embedding: embeddingStatus,
          configured: embeddingStatus?.provider_configured ?? true
        },
        mcp,
        garden,
        checks
      };

      if (ctx.jsonRequested !== true) {
        writeHumanSummary(ctx.stdout, report);
      }

      return {
        exitCode: overall === "green" ? ALAYA_SYSEXITS.OK : ALAYA_SYSEXITS.TEMPFAIL,
        json: report
      };
    }
  };
}

function doctorArgsSchema(): AlayaCliArgsSchema<DoctorArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "Expected a string argument list." }] }
        } as const;
      }

      if (input.length === 0) {
        return { success: true, data: { workspaceId: null } } as const;
      }

      if (input.length === 2 && input[0] === "--workspace") {
        const workspaceId = input[1].trim();
        if (workspaceId.length === 0) {
          return {
            success: false,
            error: { issues: [{ path: [1], message: "Workspace id must not be empty." }] }
          } as const;
        }
        return { success: true, data: { workspaceId } } as const;
      }

      return {
        success: false,
        error: {
          issues: [
            {
              path: [],
              message: "Usage: doctor [--workspace <workspace-id>]"
            }
          ]
        }
      } as const;
    }
  };
}

async function inspectStorage(
  dbPath: string,
  getSchemaSummary?: DoctorCommandDependencies["getSchemaSummary"]
): Promise<DoctorReport["storage"]> {
  const normalizedPath = dbPath.trim();
  const emptyStorage = (existsValue: boolean, writableValue: boolean): DoctorReport["storage"] => ({
    db_path: normalizedPath.length === 0 ? dbPath : normalizedPath,
    exists: existsValue,
    writable: writableValue,
    schema_ok: null,
    schema_version_persisted: null,
    schema_version_expected: null
  });

  if (normalizedPath.length === 0) {
    return emptyStorage(false, false);
  }

  try {
    await access(normalizedPath, fsConstants.F_OK);
  } catch {
    return emptyStorage(false, false);
  }

  let writable = true;
  try {
    await access(normalizedPath, fsConstants.W_OK);
  } catch {
    writable = false;
  }

  if (!writable) {
    return emptyStorage(true, false);
  }

  if (getSchemaSummary === undefined) {
    return {
      db_path: normalizedPath,
      exists: true,
      writable: true,
      schema_ok: null,
      schema_version_persisted: null,
      schema_version_expected: null
    };
  }

  try {
    const summary = await getSchemaSummary(normalizedPath);
    return {
      db_path: normalizedPath,
      exists: true,
      writable: true,
      schema_ok: summary.schemaOk,
      schema_version_persisted: summary.persistedMaxVersion,
      schema_version_expected: summary.knownMaxVersion
    };
  } catch {
    return {
      db_path: normalizedPath,
      exists: true,
      writable: true,
      schema_ok: false,
      schema_version_persisted: null,
      schema_version_expected: null
    };
  }
}

function writeHumanSummary(stream: NodeJS.WritableStream, report: DoctorReport): void {
  stream.write(`doctor overall: ${report.overall}\n`);
  stream.write(`runtime ready: ${report.startup.ready ? "yes" : "no"}\n`);
  stream.write(`storage db path: ${report.storage.db_path}\n`);
  stream.write(`storage writable: ${report.storage.writable ? "yes" : "no"}\n`);
  if (report.storage.schema_ok !== null) {
    stream.write(
      `storage schema_ok: ${report.storage.schema_ok ? "yes" : "no"}` +
        ` (persisted=${report.storage.schema_version_persisted ?? "none"}, expected=${
          report.storage.schema_version_expected ?? "?"
        })\n`
    );
  }
  stream.write(`mcp transport: ${report.mcp.transport}\n`);
  stream.write(`garden status: ${report.garden.status}\n`);
  if (report.provider.embedding !== null) {
    stream.write(
      `embedding mode: ${report.provider.embedding.effective_mode} (provider_configured=${report.provider.embedding.provider_configured ? "yes" : "no"})\n`
    );
  }
}
