import { spawn as spawnChildProcess } from "node:child_process";
import { platform, release } from "node:os";
import type { BrowserOpenerSpawn } from "./inspect-types.js";
import { describeInspectError } from "./inspect-errors.js";

export async function defaultOpenUrl(url: string): Promise<void> {
  await openUrlWithSpawn(url, {
    spawnBrowser: (command, args) =>
      spawnChildProcess(command, [...args], {
        detached: true,
        stdio: "ignore"
      })
  });
}

export async function openUrlWithSpawn(
  url: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly os?: NodeJS.Platform;
    readonly osRelease?: string;
    readonly spawnBrowser?: BrowserOpenerSpawn;
  } = {}
): Promise<void> {
  const candidates = openCommandCandidates(url, options);
  const spawnBrowser = options.spawnBrowser ?? ((command, args) => spawnChildProcess(command, [...args], {
    detached: true,
    stdio: "ignore"
  }));
  const errors: string[] = [];

  for (const [command, args] of candidates) {
    try {
      await spawnBrowserCandidate(spawnBrowser, command, args);
      return;
    } catch (error) {
      errors.push(`${command}: ${describeInspectError(error)}`);
    }
  }

  throw new Error(`no browser opener worked (${errors.join("; ")})`);
}

export function openCommandCandidates(
  url: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly os?: NodeJS.Platform;
    readonly osRelease?: string;
  } = {}
): readonly (readonly [string, readonly string[]])[] {
  const os = options.os ?? platform();
  if (os === "darwin") return [["open", [url]]];
  if (os === "win32") return [["cmd", ["/c", "start", "", url]]];
  if (os === "linux" && isWslEnvironment(options.env ?? process.env, options.osRelease ?? release())) {
    return [
      ["wslview", [url]],
      ["cmd.exe", ["/c", "start", "", url]],
      ["xdg-open", [url]]
    ];
  }
  return [["xdg-open", [url]]];
}

async function spawnBrowserCandidate(
  spawnBrowser: BrowserOpenerSpawn,
  command: string,
  args: readonly string[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnBrowser(command, args);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

function isWslEnvironment(env: NodeJS.ProcessEnv, osRelease: string): boolean {
  return (
    env.WSL_DISTRO_NAME !== undefined ||
    env.WSL_INTEROP !== undefined ||
    osRelease.toLowerCase().includes("microsoft")
  );
}
