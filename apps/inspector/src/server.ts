import { serve, type ServerType } from "@hono/node-server";
import { createInspectorApp } from "./app.js";

export interface InspectorServerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export function parseInspectorPort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    return 5174;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`invalid inspector port: ${value}`);
  }
  return parsed;
}

export async function startInspectorServer(options: InspectorServerOptions = {}): Promise<ServerType> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  const token = env.ALAYA_INSPECTOR_TOKEN?.trim();
  if (!token) {
    stderr.write("inspector_token_missing\n");
    process.exitCode = 2;
    throw new Error("inspector_token_missing");
  }
  const daemonUrl = env.ALAYA_DAEMON_URL?.trim();
  if (!daemonUrl) {
    stderr.write("inspector_daemon_url_missing\n");
    process.exitCode = 2;
    throw new Error("inspector_daemon_url_missing");
  }
  const workspaceId = env.ALAYA_INSPECTOR_WORKSPACE_ID?.trim();
  if (!workspaceId) {
    stderr.write("inspector_workspace_id_missing\n");
    process.exitCode = 2;
    throw new Error("inspector_workspace_id_missing");
  }

  const app = createInspectorApp({
    token,
    workspaceId,
    daemonUrl,
    env
  });
  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: parseInspectorPort(env.ALAYA_INSPECTOR_PORT)
  });
  stdout.write("inspector_ready\n");
  return server;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("/server.js")) {
  await startInspectorServer().catch((error) => {
    const isStartupConfigError =
      error instanceof Error &&
      (error.message === "inspector_token_missing" ||
        error.message === "inspector_daemon_url_missing" ||
        error.message === "inspector_workspace_id_missing");
    if (!isStartupConfigError) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });
}
