import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface CapturedCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CapturedCommandError extends Error {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export async function execFileWithFileCapture(
  file: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {}
): Promise<CapturedCommandResult> {
  const captureDir = await mkdtemp(path.join(tmpdir(), "alaya-script-capture-"));
  const stdoutPath = path.join(captureDir, "stdout");
  const stderrPath = path.join(captureDir, "stderr");
  const stdoutHandle = await open(stdoutPath, "w");
  const stderrHandle = await open(stderrPath, "w");

  try {
    let result: { readonly code: number | null; readonly signal: string | null };
    try {
      result = await new Promise((resolve, reject) => {
        const child = spawn(file, [...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd]
        });
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
    } finally {
      await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
    }

    const [stdout, stderr] = await Promise.all([
      readFile(stdoutPath, "utf8"),
      readFile(stderrPath, "utf8")
    ]);
    if (result.code !== 0) {
      const error = new Error(`Command failed: ${file} ${args.join(" ")}`) as CapturedCommandError;
      Object.defineProperties(error, {
        code: { value: result.code, enumerable: true },
        signal: { value: result.signal, enumerable: true },
        stdout: { value: stdout, enumerable: true },
        stderr: { value: stderr, enumerable: true }
      });
      throw error;
    }
    return { stdout, stderr };
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
}
