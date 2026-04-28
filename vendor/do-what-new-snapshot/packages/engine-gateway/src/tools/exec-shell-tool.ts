import { execFile } from "node:child_process";
import type { ExecShellToolInput, ExecShellToolResult, ToolSpec } from "@do-what/protocol";
import { createAccessDenied, createToolError } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 131_072;
const MAX_BUFFER_BYTES = MAX_OUTPUT_BYTES * 10;
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_ENV",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT"
] as const;

export const EXEC_SHELL_TOOL_SPEC: ToolSpec = {
  tool_id: "tools.exec_shell",
  category: "exec",
  description:
    "Execute a shell command within the project boundary. Always requires explicit user approval before execution. Destructive operations are subject to circuit-breaker posture escalation.",
  scope_guard: "project",
  read_only: false,
  destructive: true,
  concurrency_safe: false,
  interrupt_behavior: "abort",
  requires_confirmation: true,
  requires_evidence_reopen: false,
  rollback_support: "none",
  fast_path_eligible: false
};

export type ExecShellInput = ExecShellToolInput;
export type ExecShellResult = ExecShellToolResult;

export async function execShell(
  input: ExecShellInput,
  writableRoots: readonly string[]
): Promise<ExecShellResult> {
  if (writableRoots.length === 0) {
    return createAccessDenied("No writable roots are available for exec containment.");
  }

  const cwd = writableRoots[0]!;
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const args = input.args !== undefined ? [...input.args] : [];

  return await new Promise<ExecShellResult>((resolve) => {
    execFile(
      input.command,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        env: createChildProcessEnv(),
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          if (error.killed === true) {
            resolve(createToolError("TIMEOUT", `Command timed out after ${timeoutMs}ms.`));
            return;
          }

          if (typeof error.code === "number") {
            resolve({
              ok: true,
              exitCode: error.code,
              stdout: truncateOutput(stdout),
              stderr: truncateOutput(stderr)
            });
            return;
          }

          resolve(createToolError("EXEC_ERROR", error.message));
          return;
        }

        resolve({
          ok: true,
          exitCode: 0,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr)
        });
      }
    );
  });
}

export function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(value, MAX_TIMEOUT_MS);
}

function truncateOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= MAX_OUTPUT_BYTES) {
    return output;
  }

  let collectedBytes = 0;
  const truncatedChars: string[] = [];

  for (const char of output) {
    const nextCharBytes = Buffer.byteLength(char, "utf8");

    if (collectedBytes + nextCharBytes > MAX_OUTPUT_BYTES) {
      break;
    }

    truncatedChars.push(char);
    collectedBytes += nextCharBytes;
  }

  return truncatedChars.join("") + "\n[truncated]";
}

function createChildProcessEnv(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};

  for (const variableName of CHILD_ENV_ALLOWLIST) {
    const value = process.env[variableName];

    if (typeof value === "string" && value.length > 0) {
      childEnv[variableName] = value;
    }
  }

  return childEnv;
}
