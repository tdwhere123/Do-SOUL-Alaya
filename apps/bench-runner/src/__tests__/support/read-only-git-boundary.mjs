import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { devNull } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

const credentialKey = key => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key);
const injectedRuntimeKey = key => /^(?:GIT_|LD_|DYLD_|NODE_|BASH_ENV$|ENV$|SHELLOPTS$|CDPATH$)/iu.test(key);

/** Shared test-only execution containment, independent of either caller's command
 * admission or model allocation. Only the caller owns its permitted Git queries. */
export function createReadOnlyGitExecutionPolicy() {
  const cwd = realpathSync(process.cwd());
  const offeredPath = process.env.PATH ?? "";
  const executable = resolveGitExecutable(offeredPath);
  const identity = statSync(executable);
  const environment = Object.freeze({
    PATH: dirname(executable), LANG: "C", LC_ALL: "C",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull,
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0"
  });
  return Object.freeze({
    prepare(command, options = {}, { rejectEnvironmentInjection = false } = {}) {
      if (command !== "git" || options.shell || realpathSync(process.cwd()) !== cwd ||
          options.cwd !== undefined && realpathSync(options.cwd) !== cwd) {
        throw new Error("read-only Git execution requires its pinned command and cwd without a shell");
      }
      if (rejectEnvironmentInjection && Object.keys(options.env ?? {}).some(key =>
        credentialKey(key) || injectedRuntimeKey(key) || key === "PATH" && options.env[key] !== offeredPath)) {
        throw new Error("read-only Git environment injection refused");
      }
      const current = statSync(executable);
      if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino ||
          current.size !== identity.size || current.mtimeMs !== identity.mtimeMs) {
        throw new Error("read-only Git executable changed");
      }
      // Never inherit caller Git config, credentials, loader/preload variables or
      // executable search overrides. The fixed command routes cannot run hooks;
      // authority diff/hash routes additionally supply their existing no-filter flags.
      const env = { ...environment };
      return {
        executable,
        options: { ...options, cwd, shell: false, env },
        receipt: { command: "git", executable, cwd,
          credential_environment_count: Object.keys(env).filter(credentialKey).length,
          inherited_git_config: false, inherited_loader_environment: false }
      };
    }
  });
}

function resolveGitExecutable(pathValue) {
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, process.platform === "win32" ? "git.exe" : "git");
    try {
      accessSync(path, constants.X_OK);
      const resolved = realpathSync(path);
      if (statSync(resolved).isFile()) return resolved;
    } catch { /* Continue through the install-time executable search path. */ }
  }
  throw new Error("cannot pin a native Git executable for the read-only test boundary");
}
