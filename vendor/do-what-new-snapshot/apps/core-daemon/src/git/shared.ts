import { execFile, type ExecFileException } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

export const GIT_CONFIG_ARGS = [
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
  "-c",
  "diff.textconv="
] as const;

export class GitInputError extends Error {
  public readonly code = "invalid_ref_arg";

  public constructor(message: string) {
    super(message);
    this.name = "GitInputError";
  }
}

export class GitTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitTimeoutError";
  }
}

export class GitCommandError extends Error {
  public constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export interface GitCommandDependencies {
  readonly execFileImpl?: typeof execFile;
  readonly realpathImpl?: typeof realpath;
  readonly pathEnv?: string;
  readonly beforeRecheckPath?: () => Promise<void>;
}

export interface RunGitCommandInput {
  readonly repoPath: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface RunGitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface PreparedRepoPath {
  readonly repoRealPath: string;
  readonly safePath: string;
  readonly absolutePath: string;
}

export function assertSafeGitRefArg(value: string, label: string): string {
  if (value.length === 0) {
    throw new GitInputError(`${label} must not be empty`);
  }

  if (value.startsWith("-")) {
    throw new GitInputError(`${label} must not start with '-'`);
  }

  if (/[\0\r\n]/.test(value)) {
    throw new GitInputError(`${label} must not contain control characters`);
  }

  return value;
}

export function assertSafeWorkspaceRelativePath(value: string): string {
  const safeValue = assertSafeGitRefArg(value, "path");

  if (path.posix.isAbsolute(safeValue)) {
    throw new GitInputError("path must be workspace-relative");
  }

  if (safeValue.startsWith(":")) {
    throw new GitInputError("path must be a literal workspace-relative path");
  }

  if (safeValue.includes("\\")) {
    throw new GitInputError("path must use POSIX separators");
  }

  const segments = safeValue.split("/");

  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new GitInputError("path must stay within the workspace repo");
  }

  return safeValue;
}

export async function prepareRepoRelativePath(
  repoPath: string,
  relativePath: string,
  dependencies: GitCommandDependencies = {}
): Promise<PreparedRepoPath> {
  const repoRealPath = await resolveRepoRealPath(repoPath, dependencies);
  const safePath = assertSafeWorkspaceRelativePath(relativePath);
  const absolutePath = path.resolve(repoRealPath, safePath);

  if (!isWithinRoot(repoRealPath, absolutePath)) {
    throw new GitInputError("path resolves outside the repo");
  }

  await ensureResolvedPathWithinRoot(repoRealPath, absolutePath, dependencies);

  return {
    repoRealPath,
    safePath,
    absolutePath
  };
}

export async function recheckRepoRelativePath(
  repoRealPath: string,
  absolutePath: string,
  dependencies: GitCommandDependencies = {}
): Promise<void> {
  await dependencies.beforeRecheckPath?.();
  await ensureResolvedPathWithinRoot(repoRealPath, absolutePath, dependencies);
}

export async function resolveRepoRealPath(
  repoPath: string,
  dependencies: GitCommandDependencies = {}
): Promise<string> {
  const realpathImpl = dependencies.realpathImpl ?? realpath;
  return await realpathImpl(repoPath);
}

export async function runGitCommand(
  input: RunGitCommandInput,
  dependencies: GitCommandDependencies = {}
): Promise<RunGitCommandResult> {
  const execFileImpl = dependencies.execFileImpl ?? execFile;

  try {
    const { stdout, stderr } = await execFileBuffered(execFileImpl, "git", input.args, {
      cwd: input.repoPath,
      env: {
        PATH: dependencies.pathEnv ?? DEFAULT_PATH,
        GIT_PAGER: "cat",
        GIT_LITERAL_PATHSPECS: "1"
      },
      timeout: input.timeoutMs,
      maxBuffer: input.maxOutputBytes + 1,
      windowsHide: true,
      signal: input.signal
    });

    return {
      stdout: normalizeExecOutput(stdout),
      stderr: normalizeExecOutput(stderr),
      truncated: false
    };
  } catch (error) {
    if (isExecTimeout(error)) {
      throw new GitTimeoutError("git command timed out");
    }

    if (isExecMaxBuffer(error)) {
      const execError = error as ExecFileException & {
        stdout?: string | Buffer | null;
        stderr?: string | Buffer | null;
      };

      return {
        stdout: normalizeExecOutput(execError.stdout, input.maxOutputBytes),
        stderr: normalizeExecOutput(execError.stderr, input.maxOutputBytes),
        truncated: true
      };
    }

    const execError = error as ExecFileException & {
      stdout?: string | Buffer | null;
      stderr?: string | Buffer | null;
    };

    throw new GitCommandError(
      "git command failed",
      normalizeExecOutput(execError.stdout),
      normalizeExecOutput(execError.stderr)
    );
  }
}

async function ensureResolvedPathWithinRoot(
  repoRealPath: string,
  absolutePath: string,
  dependencies: GitCommandDependencies
): Promise<void> {
  const realpathImpl = dependencies.realpathImpl ?? realpath;
  const resolvedExistingPath = await resolveExistingAncestorRealPath(absolutePath, realpathImpl);

  if (!isWithinRoot(repoRealPath, resolvedExistingPath)) {
    throw new GitInputError("path resolves outside the repo");
  }
}

async function resolveExistingAncestorRealPath(
  absolutePath: string,
  realpathImpl: typeof realpath
): Promise<string> {
  let currentPath = absolutePath;

  while (true) {
    try {
      return await realpathImpl(currentPath);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }

      const parentPath = path.dirname(currentPath);

      if (parentPath === currentPath) {
        throw error;
      }

      currentPath = parentPath;
    }
  }
}

function execFileBuffered(
  execFileImpl: typeof execFile,
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeout: number;
    readonly maxBuffer: number;
    readonly windowsHide: boolean;
    readonly signal?: AbortSignal;
  }
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    (execFileImpl as any)(
      command,
      [...args],
      {
        ...options,
        encoding: "buffer"
      },
      (error: ExecFileException | null, stdout: Buffer | string, stderr: Buffer | string) => {
        const normalizedStdout = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "", "utf8");
        const normalizedStderr = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "", "utf8");

        if (error !== null) {
          const enrichedError = error as ExecFileException & {
            stdout?: string;
            stderr?: string;
          };
          enrichedError.stdout = normalizedStdout.toString("utf8");
          enrichedError.stderr = normalizedStderr.toString("utf8");
          reject(enrichedError);
          return;
        }

        resolve({
          stdout: normalizedStdout,
          stderr: normalizedStderr
        });
      }
    );
  });
}

function normalizeExecOutput(
  output: string | Buffer | null | undefined,
  maxBytes?: number
): string {
  if (typeof output === "string") {
    return maxBytes === undefined ? output : output.slice(0, maxBytes);
  }

  if (output == null) {
    return "";
  }

  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
  return buffer.slice(0, maxBytes ?? buffer.length).toString("utf8");
}

function isExecTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    (error as NodeJS.ErrnoException).code === "ABORT_ERR" ||
    error.name === "AbortError" ||
    (typeof (error as ExecFileException).signal === "string" &&
      (error as ExecFileException).killed === true) ||
    (error as NodeJS.ErrnoException).code === "ETIMEDOUT"
  );
}

function isExecMaxBuffer(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    (error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    error.message.includes("maxBuffer")
  );
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR";
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
