import {
  DEFAULT_WORKSPACE_GIT_LOG_LIMIT,
  MAX_WORKSPACE_GIT_LOG_LIMIT,
  parseWorkspaceGitLogLimit
} from "@do-what/protocol";
import {
  GIT_CONFIG_ARGS,
  GitCommandError,
  GitInputError,
  GitTimeoutError,
  type GitCommandDependencies,
  prepareRepoRelativePath,
  recheckRepoRelativePath,
  resolveRepoRealPath,
  runGitCommand
} from "./shared.js";

const GIT_LOG_TIMEOUT_MS = 5_000;
const GIT_LOG_OUTPUT_LIMIT_BYTES = 256 * 1024;
const FIELD_SEPARATOR = "\0";
const GIT_LOG_FIELDS_PER_RECORD = 6;
const GIT_LOG_FORMAT_ARG = "--format=format:%H%x00%h%x00%an%x00%ae%x00%cI%x00%s%x00";
export const DEFAULT_GIT_LOG_LIMIT = DEFAULT_WORKSPACE_GIT_LOG_LIMIT;
export const MAX_GIT_LOG_LIMIT = MAX_WORKSPACE_GIT_LOG_LIMIT;

export interface WorkspaceGitLogCommit {
  readonly sha: string;
  readonly short_sha: string;
  readonly author_name: string;
  readonly author_email: string;
  readonly committed_at: string;
  readonly subject: string;
}

export interface WorkspaceGitLogResult {
  readonly repoPath: string;
  readonly path: string | null;
  readonly commits: readonly WorkspaceGitLogCommit[];
  readonly truncated: boolean;
}

export interface GitLogService {
  listGitLog(input: {
    readonly repoPath: string;
    readonly limit: number;
    readonly path?: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceGitLogResult>;
}

export {
  GitCommandError,
  GitInputError,
  GitTimeoutError
} from "./shared.js";

export function createGitLogService(
  dependencies: GitCommandDependencies = {}
): GitLogService {
  return {
    listGitLog: async (input) => {
      const repoRealPath = await resolveRepoRealPath(input.repoPath, dependencies);
      const safeLimit = validateLogLimit(input.limit);
      let safePath: string | null = null;
      let absolutePath: string | null = null;

      if (input.path !== undefined) {
        const preparedPath = await prepareRepoRelativePath(repoRealPath, input.path, dependencies);
        safePath = preparedPath.safePath;
        absolutePath = preparedPath.absolutePath;
      }

      if (safePath !== null && absolutePath !== null) {
        await recheckRepoRelativePath(repoRealPath, absolutePath, dependencies);
      }

      const result = await runGitCommand(
        {
          repoPath: repoRealPath,
          args: buildGitLogArgs(safeLimit, safePath),
          timeoutMs: GIT_LOG_TIMEOUT_MS,
          maxOutputBytes: GIT_LOG_OUTPUT_LIMIT_BYTES,
          signal: input.signal
        },
        dependencies
      );

      return {
        repoPath: repoRealPath,
        path: safePath,
        commits: parseGitLogOutput(result.stdout, result.truncated),
        truncated: result.truncated
      };
    }
  };
}

function buildGitLogArgs(limit: number, safePath: string | null): readonly string[] {
  const args = [
    ...GIT_CONFIG_ARGS,
    "log",
    "--no-color",
    GIT_LOG_FORMAT_ARG,
    `-${limit}`
  ];

  if (safePath === null) {
    return args;
  }

  return [...args, "--", safePath];
}

function parseGitLogOutput(
  output: string,
  truncated: boolean
): readonly WorkspaceGitLogCommit[] {
  const hasTrailingSeparator = output.endsWith(FIELD_SEPARATOR);
  let fields = output.split(FIELD_SEPARATOR);

  if (hasTrailingSeparator) {
    fields = fields.slice(0, -1);
  }

  if (truncated) {
    fields = fields.slice(0, fields.length - (fields.length % GIT_LOG_FIELDS_PER_RECORD));
  }

  if (fields.length % GIT_LOG_FIELDS_PER_RECORD !== 0) {
    throw new GitInputError("git log output was not parseable");
  }

  const commits: WorkspaceGitLogCommit[] = [];
  for (let index = 0; index < fields.length; index += GIT_LOG_FIELDS_PER_RECORD) {
    const [sha, shortSha, authorName, authorEmail, committedAt, subject] = fields.slice(
      index,
      index + GIT_LOG_FIELDS_PER_RECORD
    );

    commits.push({
      sha: sha ?? "",
      short_sha: shortSha ?? "",
      author_name: authorName ?? "",
      author_email: authorEmail ?? "",
      committed_at: committedAt ?? "",
      subject: subject ?? ""
    });
  }

  return commits;
}

function validateLogLimit(limit: number): number {
  try {
    return parseWorkspaceGitLogLimit(limit);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new GitInputError(error.message);
    }

    throw error;
  }
}
