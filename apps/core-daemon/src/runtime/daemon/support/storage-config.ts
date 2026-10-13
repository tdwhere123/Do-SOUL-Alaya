import {
  resolveConfiguredDatabasePath as resolvePath
} from "../../../../../../scripts/configured-paths.mjs";
import type { AlayaConfigPaths } from "../../../cli/support/config-files.js";

export { parseStorageDbPathFromToml } from "../../../../../../scripts/configured-paths.mjs";

export interface ResolveConfiguredDatabasePathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fallbackPath: string;
  readonly launchCwd?: string;
}

export async function resolveConfiguredDatabasePath(
  configPaths: AlayaConfigPaths,
  options: ResolveConfiguredDatabasePathOptions
): Promise<string> {
  return resolvePath(configPaths.tomlPath, options.env ?? {}, options.fallbackPath, options.launchCwd);
}
