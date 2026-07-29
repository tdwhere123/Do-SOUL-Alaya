import path, { dirname } from "node:path";
import { ALAYA_MCP_ARGS, ALAYA_MCP_COMMAND, ALAYA_SLASH_ARGS } from "./profile-mutation-constants.js";

type AlayaLauncherRootInput =
  | string
  | {
      readonly importMetaDirname?: string;
      readonly packageRoot?: string;
    };

export function resolveAlayaMcpLauncher(
  env: NodeJS.ProcessEnv = process.env,
  rootInput?: AlayaLauncherRootInput
): { readonly command: string; readonly args: readonly string[] } {
  const override = env.ALAYA_MCP_LAUNCHER?.trim();
  if (override !== undefined && override.length > 0) {
    const tokens = override.split(/\s+/u);
    const cmd = assertAllowedLauncherCommand(tokens[0] ?? ALAYA_MCP_COMMAND, "ALAYA_MCP_LAUNCHER");
    assertNoShellControlChars(override, "ALAYA_MCP_LAUNCHER");
    const extraArgs = tokens.slice(1);
    return { command: cmd, args: [...extraArgs, ...ALAYA_MCP_ARGS] };
  }
  const binPath = resolveAlayaBinPath(rootInput);
  return { command: "node", args: [binPath, ...ALAYA_MCP_ARGS] };
}

export function resolveAlayaSlashCommand(
  env: NodeJS.ProcessEnv = process.env,
  rootInput?: AlayaLauncherRootInput
): string {
  const override = env.ALAYA_SLASH_LAUNCHER?.trim();
  if (override !== undefined && override.length > 0) {
    assertAllowedLauncherCommand(override.split(/\s+/u)[0] ?? "", "ALAYA_SLASH_LAUNCHER");
    assertNoShellControlChars(override, "ALAYA_SLASH_LAUNCHER");
    return [override, ...ALAYA_SLASH_ARGS].join(" ");
  }

  const binPath = resolveAlayaBinPath(rootInput);
  return ["node", alwaysSingleQuote(binPath), ...ALAYA_SLASH_ARGS].join(" ");
}

const ALLOWED_LAUNCHER_BASENAMES = new Set(["node", "npx", "pnpm"]);

// Launcher overrides are written verbatim into agent profiles; restrict the
// command to known runtimes or an absolute path so a hostile env cannot persist
// an arbitrary command.
function assertAllowedLauncherCommand(command: string, envName: string): string {
  if (path.isAbsolute(command) || ALLOWED_LAUNCHER_BASENAMES.has(command)) {
    return command;
  }
  throw new Error(
    `${envName} command "${command}" is not allowed; use node, npx, pnpm, or an absolute path.`
  );
}

// The slash override is joined into a shell-interpreted profile field, so a
// passing first-token allowlist must not let later tokens smuggle a second command.
function assertNoShellControlChars(override: string, envName: string): void {
  if (/[;|&$`<>(){}\n\r]/u.test(override)) {
    throw new Error(`${envName} must not contain shell control characters.`);
  }
}

function alwaysSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function resolveAlayaBinPath(rootInput: AlayaLauncherRootInput | undefined): string {
  return path.resolve(resolveAlayaPackageRoot(rootInput), "bin", "alaya.mjs");
}

function resolveAlayaPackageRoot(rootInput: AlayaLauncherRootInput | undefined): string {
  if (typeof rootInput === "string") {
    return path.resolve(rootInput);
  }

  if (rootInput?.packageRoot !== undefined) {
    return path.resolve(rootInput.packageRoot);
  }

  const moduleDir = path.resolve(rootInput?.importMetaDirname ?? import.meta.dirname);

  let buildRoot = moduleDir;
  while (
    path.basename(buildRoot) !== "dist" &&
    path.basename(buildRoot) !== "src" &&
    dirname(buildRoot) !== buildRoot
  ) {
    buildRoot = dirname(buildRoot);
  }

  const buildParent = dirname(buildRoot);
  const buildGrandparent = dirname(buildParent);
  const isRepoCoreDaemonModule =
    (path.basename(buildRoot) === "src" || path.basename(buildRoot) === "dist") &&
    path.basename(buildParent) === "core-daemon" &&
    path.basename(buildGrandparent) === "apps";

  if (isRepoCoreDaemonModule) {
    return path.resolve(buildRoot, "..", "..", "..");
  }

  if (path.basename(buildRoot) === "dist") {
    return buildParent;
  }

  return path.resolve(moduleDir, "..", "..", "..");
}
