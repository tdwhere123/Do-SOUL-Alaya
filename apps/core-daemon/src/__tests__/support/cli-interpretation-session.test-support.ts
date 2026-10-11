import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

/** Actual launcher and stdio boundary, with a transport guard installed before CLI imports. */
export async function withCliInterpretationSession<T>(root: string, workspace: string, run: string,
  body: (call: (request: unknown) => Promise<{ exitCode: number; output: unknown }>) => Promise<T>): Promise<T> {
  const binary = fileURLToPath(new URL("../../../../../bin/alaya.mjs", import.meta.url));
  // Node loads --import as an ESM URL; a Windows drive path is parsed as a scheme.
  const guard = new URL("./provider-free-cli.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", guard, binary, "tools", "session",
    "--workspace", workspace, "--run", run, "--agent", "codex"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, DATA_DIR: root },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let pending = "", stderr = "";
  const rows: { exitCode: number; output: unknown }[] = [];
  let receive: ((row: { exitCode: number; output: unknown }) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const timeout = setTimeout(() => { reject?.(new Error(`CLI session timed out: ${stderr}`)); child.kill(); }, 30_000);
  child.stderr.on("data", bytes => { stderr += bytes.toString(); });
  child.stdout.on("data", bytes => {
    pending += bytes.toString();
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n"), line = pending.slice(0, end); pending = pending.slice(end + 1);
      const row = JSON.parse(line) as { exitCode: number; output: unknown };
      if (receive !== undefined) { const resolve = receive; receive = undefined; reject = undefined; resolve(row); }
      else rows.push(row);
    }
  });
  child.on("exit", code => { reject?.(new Error(`CLI session exited ${code}: ${stderr}`)); });
  const call = async (request: unknown) => {
    const response = new Promise<{ exitCode: number; output: unknown }>((resolve, fail) => {
      const queued = rows.shift();
      if (queued !== undefined) resolve(queued);
      else { receive = resolve; reject = fail; }
    });
    child.stdin.write(`${JSON.stringify({ tool: "soul.interpretation", arguments: request })}\n`);
    return await response;
  };
  try { return await body(call); }
  finally {
    clearTimeout(timeout);
    const exited = once(child, "exit");
    child.stdin.end();
    const cleanup = setTimeout(() => child.kill(), 2000);
    if (child.exitCode === null && child.signalCode === null) await exited;
    clearTimeout(cleanup);
  }
}
