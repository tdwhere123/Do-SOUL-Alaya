import { serve, type ServerType } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { createApp, type RequestProtectionConfig } from "./app.js";
import { createRuntimeNotifier, type AlayaRuntimeNotifier } from "./runtime-notifier.js";

export interface DaemonStartupStepRecord {
  readonly step: "storage" | "core-services" | "garden" | "mcp-transport";
  readonly completedAt: string;
}

export interface AlayaDaemonRuntime {
  readonly app: ReturnType<typeof createApp>;
  readonly requestProtection: RequestProtectionConfig;
  readonly runtimeNotifier: AlayaRuntimeNotifier;
  readonly startupSteps: readonly DaemonStartupStepRecord[];
  startHttpServer(options?: AlayaDaemonListenOptions): Promise<AlayaDaemonServer>;
}

export interface AlayaDaemonListenOptions {
  readonly hostname?: string;
  readonly port?: number;
}

export interface AlayaDaemonServer {
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function createAlayaDaemonRuntime(): Promise<AlayaDaemonRuntime> {
  const startupSteps: DaemonStartupStepRecord[] = [];
  recordStartupStep(startupSteps, "storage");

  const runtimeNotifier = createRuntimeNotifier();
  recordStartupStep(startupSteps, "core-services");

  recordStartupStep(startupSteps, "garden");
  recordStartupStep(startupSteps, "mcp-transport");

  const requestProtection = createRequestProtection();
  const app = createApp({ requestProtection });

  return Object.freeze({
    app,
    requestProtection,
    runtimeNotifier,
    startupSteps,
    startHttpServer: async (options: AlayaDaemonListenOptions = {}) => {
      const hostname = options.hostname ?? resolveDaemonHostFromEnv(process.env);
      const port = options.port ?? parsePort(process.env.PORT, 5173);
      const server = serve({
        fetch: app.fetch,
        hostname,
        port
      });

      return Object.freeze({
        hostname,
        port,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close((error?: Error) => {
              if (error !== undefined) {
                reject(error);
                return;
              }
              resolve();
            });
          })
      });
    }
  });
}

export async function startDaemon(options: AlayaDaemonListenOptions = {}): Promise<AlayaDaemonServer> {
  const runtime = await createAlayaDaemonRuntime();
  return await runtime.startHttpServer(options);
}

function createRequestProtection(): RequestProtectionConfig {
  return Object.freeze({
    allowedOrigin: process.env.ALLOWED_ORIGIN ?? "http://localhost:5173",
    requestToken: process.env.ALAYA_REQUEST_TOKEN ?? randomBytes(32).toString("hex"),
    allowDesktopOriginlessRequests: true
  });
}

function recordStartupStep(
  startupSteps: DaemonStartupStepRecord[],
  step: DaemonStartupStepRecord["step"]
): void {
  startupSteps.push({
    step,
    completedAt: new Date().toISOString()
  });
}

function resolveDaemonHostFromEnv(env: NodeJS.ProcessEnv): string {
  if (env.ALLOW_REMOTE_DAEMON === "true") {
    return env.HOST ?? "0.0.0.0";
  }

  return "127.0.0.1";
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid daemon port: ${value}`);
  }

  return parsed;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file://").href) {
  await startDaemon();
}
