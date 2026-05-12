import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaSubcommandSpec
} from "./bridge.js";

type UpdateArgs = Record<string, never>;

function getCurrentVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function createUpdateCommand(): AlayaSubcommandSpec<UpdateArgs> {
  return {
    name: "update",
    description: "Show GitHub Release / source-build upgrade instructions.",
    argsSchema: updateArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx) => {
      const current = getCurrentVersion();
      ctx.stdout.write(`Current version: ${current}\n`);
      ctx.stdout.write(
        "Alaya is distributed through GitHub Release source tarballs and source builds; npm/global install is not a supported update channel.\n" +
          "To upgrade an installer-based setup, rerun scripts/install.sh with ALAYA_VERSION set to the target tag, or omit it for the latest release.\n" +
          "To upgrade a source checkout, pull the repository, run pnpm install, then run pnpm build.\n"
      );
      return { exitCode: ALAYA_SYSEXITS.OK };
    }
  };
}

function updateArgsSchema(): AlayaCliArgsSchema<UpdateArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((t) => typeof t !== "string")) {
        return { success: false, error: { issues: [{ path: [], message: "Expected a string argument list." }] } };
      }
      for (const token of input) {
        return { success: false, error: { issues: [{ path: [], message: `Unknown update option: ${token}` }] } };
      }
      return { success: true, data: {} };
    }
  };
}
