import {
  GIT_CONFIG_ARGS,
  GitCommandError,
  GitInputError,
  GitTimeoutError,
  type GitCommandDependencies,
  prepareRepoRelativePath,
  recheckRepoRelativePath,
  runGitCommand
} from "./shared.js";

const GIT_DIFF_TIMEOUT_MS = 5_000;
const GIT_DIFF_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export interface WorkspaceGitDiffResult {
  readonly repoPath: string;
  readonly path: string;
  readonly since: string;
  readonly against: string;
  readonly binary: boolean;
  readonly deleted: boolean;
  readonly added: boolean;
  readonly unifiedDiff: string;
  readonly truncated: boolean;
}

export interface GitDiffService {
  getFileDiff(input: {
    readonly repoPath: string;
    readonly path: string;
    readonly since?: string;
    readonly against?: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceGitDiffResult>;
}

export {
  GitCommandError,
  GitInputError,
  GitTimeoutError
} from "./shared.js";

export async function getWorkspaceFileDiff(input: {
  readonly repoPath: string;
  readonly filePath: string;
  readonly since?: string;
  readonly against?: string;
  readonly signal?: AbortSignal;
  readonly hooks?: {
    readonly beforeFinalRealpath?: () => Promise<void>;
  };
}): Promise<{
  readonly path: string;
  readonly since: string;
  readonly against: string;
  readonly binary: boolean;
  readonly deleted: boolean;
  readonly added: boolean;
  readonly unified_diff: string;
  readonly truncated: boolean;
}> {
  const service = createGitDiffService({
    beforeRecheckPath: input.hooks?.beforeFinalRealpath
  });
  const result = await service.getFileDiff({
    repoPath: input.repoPath,
    path: input.filePath,
    since: input.since,
    against: input.against,
    signal: input.signal
  });

  return {
    path: result.path,
    since: result.since,
    against: result.against,
    binary: result.binary,
    deleted: result.deleted,
    added: result.added,
    unified_diff: result.unifiedDiff,
    truncated: result.truncated
  };
}

export function createGitDiffService(
  dependencies: GitCommandDependencies = {}
): GitDiffService {
  return {
    getFileDiff: async (input) => {
      const against = parseAgainst(input.against);
      const since = resolveSince(input.since, against);
      const preparedPath = await prepareRepoRelativePath(input.repoPath, input.path, dependencies);

      await recheckRepoRelativePath(
        preparedPath.repoRealPath,
        preparedPath.absolutePath,
        dependencies
      );

      const result = await runGitCommand(
        {
          repoPath: preparedPath.repoRealPath,
          args: buildGitDiffArgs(preparedPath.safePath, since, against),
          timeoutMs: GIT_DIFF_TIMEOUT_MS,
          maxOutputBytes: GIT_DIFF_OUTPUT_LIMIT_BYTES,
          signal: input.signal
        },
        dependencies
      );
      const binary = isBinaryDiff(result.stdout);

      return {
        repoPath: preparedPath.repoRealPath,
        path: preparedPath.safePath,
        since,
        against: serializeAgainst(against),
        binary,
        deleted: isDeletedDiff(result.stdout),
        added: isAddedDiff(result.stdout),
        unifiedDiff: binary ? "" : finalizeUnifiedDiff(result.stdout, result.truncated),
        truncated: result.truncated
      };
    }
  };
}

type ParsedAgainst =
  | {
      readonly kind: "working_tree";
    }
  | {
      readonly kind: "index";
    }
  | {
      readonly kind: "commit";
      readonly ref: string;
    };

function parseAgainst(value: string | undefined): ParsedAgainst {
  const against = value ?? "working_tree";

  if (against === "working_tree" || against === "index") {
    return { kind: against };
  }

  if (!against.startsWith("commit:")) {
    throw new GitInputError("against must be working_tree, index, or commit:<sha>");
  }

  const ref = against.slice("commit:".length);

  if (ref.length === 0) {
    throw new GitInputError("commit against target must not be empty");
  }

  return {
    kind: "commit",
    ref: validateRef(ref, "against")
  };
}

function resolveSince(value: string | undefined, against: ParsedAgainst): string {
  if (against.kind === "commit") {
    return against.ref;
  }

  return validateRef(value ?? "HEAD", "since");
}

function validateRef(value: string, label: string): string {
  if (value.length === 0) {
    throw new GitInputError(`${label} must not be empty`);
  }

  if (value.startsWith("-") || /[\0\r\n]/.test(value)) {
    throw new GitInputError(`${label} must not contain unsafe characters`);
  }

  return value;
}

function buildGitDiffArgs(
  safePath: string,
  since: string,
  against: ParsedAgainst
): readonly string[] {
  const baseArgs = [
    ...GIT_CONFIG_ARGS,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--unified=3"
  ];

  if (against.kind === "working_tree") {
    return [...baseArgs, since, "--", safePath];
  }

  if (against.kind === "index") {
    return [...baseArgs, "--cached", since, "--", safePath];
  }

  return [...baseArgs, against.ref, "--", safePath];
}

function isBinaryDiff(output: string): boolean {
  return output.includes("GIT binary patch") || /(^|\n)Binary files .* differ(\n|$)/.test(output);
}

function isDeletedDiff(output: string): boolean {
  return output.includes("deleted file mode") || /(^|\n)\+\+\+ \/dev\/null(\n|$)/.test(output);
}

function isAddedDiff(output: string): boolean {
  return output.includes("new file mode") || /(^|\n)--- \/dev\/null(\n|$)/.test(output);
}

function finalizeUnifiedDiff(output: string, truncated: boolean): string {
  if (!truncated) {
    return output;
  }

  const trimmed = output.replace(/\n+$/u, "");
  return trimmed.length === 0 ? "<truncated>" : `${trimmed}\n<truncated>\n`;
}

function serializeAgainst(against: ParsedAgainst): string {
  return against.kind === "commit" ? `commit:${against.ref}` : against.kind;
}
