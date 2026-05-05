import { readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliContext,
  type AlayaSubcommandSpec
} from "./bridge.js";

const PACKAGE_NAME = "@do-soul/alaya";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;

interface UpdateArgs {
  readonly checkOnly: boolean;
  readonly yes: boolean;
}

function getCurrentVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isGlobalNpmInstall(): boolean {
  // The published npm install lives under <prefix>/lib/node_modules/@do-soul/alaya/.
  // pnpm link --global / source builds resolve via a worktree path that
  // does not contain "node_modules/@do-soul/alaya". Refuse to clobber a
  // dev/source install with `npm install -g`.
  try {
    const realPath = realpathSync(fileURLToPath(import.meta.url));
    return realPath.includes(`node_modules/@do-soul/alaya/`) ||
      realPath.includes(`node_modules\\@do-soul\\alaya\\`);
  } catch {
    return false;
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

function parseSemver(input: string): readonly [number, number, number] {
  const trimmed = input.replace(/^v/, "").split(/[-+]/u, 1)[0] ?? "";
  const [maj, min, pat] = trimmed.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  });
  return [maj ?? 0, min ?? 0, pat ?? 0];
}

function isNewer(latest: string, current: string): boolean {
  const [lMaj, lMin, lPat] = parseSemver(latest);
  const [cMaj, cMin, cPat] = parseSemver(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

async function runNpmInstall(ctx: AlayaCliContext, version: string): Promise<number> {
  return new Promise((resolveExit) => {
    // Pin the exact version that we showed to the user — using @latest
    // would race with a publish that lands between check and install.
    const child = spawn("npm", ["install", "-g", `${PACKAGE_NAME}@${version}`], {
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.on("exit", (code) => resolveExit(code ?? 1));
    child.on("error", (err) => {
      ctx.stderr.write(`npm install failed: ${err.message}\n`);
      resolveExit(1);
    });
  });
}

export function createUpdateCommand(): AlayaSubcommandSpec<UpdateArgs> {
  return {
    name: "update",
    description: "Check for and install the latest version of Alaya from npm.",
    argsSchema: updateArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => {
      const current = getCurrentVersion();
      ctx.stdout.write(`Current version: ${current}\n`);
      ctx.stdout.write("Checking npm for latest version...\n");

      const latest = await fetchLatestVersion();
      if (latest === null) {
        ctx.stderr.write("Could not reach npm registry. Check your network connection.\n");
        return { exitCode: ALAYA_SYSEXITS.TEMPFAIL };
      }

      if (!isNewer(latest, current)) {
        ctx.stdout.write(`Already up to date (${current}).\n`);
        return { exitCode: ALAYA_SYSEXITS.OK };
      }

      ctx.stdout.write(`New version available: ${latest}\n`);

      if (args.checkOnly) {
        ctx.stdout.write(`Run \`alaya update\` to install.\n`);
        return { exitCode: ALAYA_SYSEXITS.OK };
      }

      if (!isGlobalNpmInstall()) {
        ctx.stderr.write(
          `Refusing to update: this Alaya install is not from \`npm install -g @do-soul/alaya\`.\n` +
            `If you built from source (git clone + pnpm link), run \`git pull && pnpm build\` instead.\n`
        );
        return { exitCode: ALAYA_SYSEXITS.USAGE };
      }

      // In a non-TTY environment, refuse silent global install unless --yes.
      // This protects scripts/CI from a surprise mutation of the global npm tree.
      if (!args.yes && !ctx.isTTY) {
        ctx.stderr.write(
          `Refusing to install in non-TTY environment without --yes.\n` +
            `Run \`alaya update --yes\` to confirm.\n`
        );
        return { exitCode: ALAYA_SYSEXITS.USAGE };
      }

      if (!args.yes && ctx.isTTY) {
        ctx.stdout.write(`Install ${latest}? [y/N] `);
        const confirmed = await readConfirmation(ctx);
        if (!confirmed) {
          ctx.stdout.write("Cancelled.\n");
          return { exitCode: ALAYA_SYSEXITS.OK };
        }
      }

      ctx.stdout.write(`Installing ${PACKAGE_NAME}@${latest}...\n`);
      const code = await runNpmInstall(ctx, latest);
      if (code !== 0) {
        ctx.stderr.write(`Installation failed. Try: npm install -g ${PACKAGE_NAME}@${latest}\n`);
        return { exitCode: ALAYA_SYSEXITS.SOFTWARE };
      }

      ctx.stdout.write(
        `Updated to ${latest}. Restart your agent session, then run \`alaya doctor\` to verify schema migration.\n`
      );
      return { exitCode: ALAYA_SYSEXITS.OK };
    }
  };
}

async function readConfirmation(ctx: AlayaCliContext): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    let input = "";
    const onData = (chunk: Buffer | string) => {
      input += chunk.toString();
      if (input.includes("\n")) {
        ctx.stdin.removeListener("data", onData);
        resolveAnswer(input.trim().toLowerCase() === "y");
      }
    };
    ctx.stdin.on("data", onData);
    setTimeout(() => {
      ctx.stdin.removeListener("data", onData);
      resolveAnswer(false);
    }, 30_000);
  });
}

function updateArgsSchema(): AlayaCliArgsSchema<UpdateArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((t) => typeof t !== "string")) {
        return { success: false, error: { issues: [{ path: [], message: "Expected a string argument list." }] } };
      }
      let checkOnly = false;
      let yes = false;
      for (const token of input) {
        if (token === "--check") { checkOnly = true; continue; }
        if (token === "--yes") { yes = true; continue; }
        return { success: false, error: { issues: [{ path: [], message: `Unknown update option: ${token}` }] } };
      }
      return { success: true, data: { checkOnly, yes } };
    }
  };
}
