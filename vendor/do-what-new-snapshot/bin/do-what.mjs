#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDirectory, "..");
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:3000";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export function parseDoWhatArgs(argv, env = process.env) {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    return { kind: "help" };
  }

  if (command === "cli") {
    return parseCliArgs(rest, env);
  }

  if (command === "app") {
    return parseAppArgs(rest);
  }

  return {
    kind: "error",
    message: `Unknown command: ${command}`
  };
}

function parseCliArgs(args, env) {
  let daemonUrl = env.DO_WHAT_DAEMON_URL ?? DEFAULT_DAEMON_URL;
  let autoStartDaemon = true;
  let printCommand = false;
  const passthroughArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      return { kind: "cli-help" };
    }

    if (arg === "--") {
      passthroughArgs.push(...args.slice(index + 1));
      break;
    }

    if (arg === "--url") {
      const value = args[index + 1];
      if (value === undefined) {
        return { kind: "error", message: "`do-what cli --url` requires a URL." };
      }
      daemonUrl = value;
      index += 1;
      continue;
    }

    if (arg === "--no-daemon") {
      autoStartDaemon = false;
      continue;
    }

    if (arg === "--print-command") {
      printCommand = true;
      continue;
    }

    passthroughArgs.push(arg);
  }

  const urlError = validateHttpUrl(daemonUrl);
  if (urlError !== null) {
    return { kind: "error", message: urlError };
  }

  return {
    kind: "cli",
    daemonUrl,
    autoStartDaemon,
    printCommand,
    passthroughArgs
  };
}

function parseAppArgs(args) {
  let printCommand = false;
  const passthroughArgs = [];

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "app-help" };
    }

    if (arg === "--print-command") {
      printCommand = true;
      continue;
    }

    passthroughArgs.push(arg);
  }

  return {
    kind: "app",
    printCommand,
    passthroughArgs
  };
}

function validateHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Daemon URL must use http or https.";
    }
    return null;
  } catch {
    return "Daemon URL must be a valid URL.";
  }
}

export function buildCliCommands(parsed) {
  return {
    daemon: {
      command: pnpmCommand,
      args: ["--dir", "apps/core-daemon", "dev"]
    },
    tui: {
      command: pnpmCommand,
      args: ["--dir", "apps/tui", "dev", "--", "--url", parsed.daemonUrl, ...parsed.passthroughArgs]
    }
  };
}

export function buildAppCommand(parsed) {
  return {
    command: process.execPath,
    args: [resolve(repoRoot, "scripts/dev.mjs"), ...parsed.passthroughArgs]
  };
}

function printMainHelp() {
  console.log(`do-what

Usage:
  do-what cli [--url <daemon-url>] [--no-daemon] [-- <tui-args>]
  do-what app [--desktop]

Commands:
  cli   Open the terminal UI. Reuses a running local daemon or starts one.
  app   Open the web GUI with the core daemon.

Options:
  --print-command   Print the underlying startup command and exit.
  --help            Show help.
`);
}

function printCliHelp() {
  console.log(`do-what cli

Open the terminal UI.

Usage:
  do-what cli [--url <daemon-url>] [--no-daemon] [-- <tui-args>]

Options:
  --url <daemon-url>   Daemon URL. Defaults to ${DEFAULT_DAEMON_URL}.
  --no-daemon          Do not auto-start a local daemon.
  --print-command      Print the underlying startup commands and exit.
`);
}

function printAppHelp() {
  console.log(`do-what app

Open the web GUI with the core daemon.

Usage:
  do-what app [--desktop]

Options:
  --desktop        Launch the desktop wrapper when available.
  --print-command  Print the underlying startup command and exit.
`);
}

function printCommand(command) {
  console.log([command.command, ...command.args].join(" "));
}

function spawnForeground(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options
  });

  return new Promise((resolveExit) => {
    child.on("error", (error) => {
      console.error("[do-what] failed to start.", error);
      resolveExit(1);
    });

    child.on("exit", (code, signal) => {
      if (signal !== null) {
        resolveExit(1);
        return;
      }
      resolveExit(code ?? 0);
    });
  });
}

function spawnDaemon(command) {
  const child = spawn(command.command, command.args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const chunks = [];

  const capture = (chunk) => {
    chunks.push(Buffer.from(chunk));
    while (chunks.reduce((total, item) => total + item.length, 0) > 16_384) {
      chunks.shift();
    }
  };

  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  return {
    child,
    getLogs: () => Buffer.concat(chunks).toString("utf8")
  };
}

function terminateChild(child) {
  if (child.killed) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    return;
  }

  child.kill("SIGTERM");
}

export function isLocalDaemonUrl(value) {
  const parsed = new URL(value);
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
    parsed.port === "3000"
  );
}

async function isDaemonReachable(daemonUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);

  try {
    await fetch(new URL("/session/request-token", daemonUrl), {
      headers: { "X-Do-What-Desktop": "1" },
      signal: controller.signal
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDaemon(daemonUrl, daemon, timeoutMs = 60_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (daemon.child.exitCode !== null) {
      return false;
    }

    if (await isDaemonReachable(daemonUrl)) {
      return true;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }

  return false;
}

async function runCli(parsed) {
  const commands = buildCliCommands(parsed);

  if (parsed.printCommand) {
    console.log("daemon:");
    printCommand(commands.daemon);
    console.log("tui:");
    printCommand(commands.tui);
    return 0;
  }

  let daemon = null;

  if (!(await isDaemonReachable(parsed.daemonUrl))) {
    if (!parsed.autoStartDaemon || !isLocalDaemonUrl(parsed.daemonUrl)) {
      console.error(`[do-what] daemon is not reachable at ${parsed.daemonUrl}.`);
      return 1;
    }

    console.error(`[do-what] starting local daemon at ${parsed.daemonUrl}...`);
    daemon = spawnDaemon(commands.daemon);

    if (!(await waitForDaemon(parsed.daemonUrl, daemon))) {
      console.error("[do-what] local daemon did not become ready.");
      const logs = daemon.getLogs().trim();
      if (logs.length > 0) {
        console.error(logs);
      }
      terminateChild(daemon.child);
      return 1;
    }
  }

  try {
    return await spawnForeground(commands.tui.command, commands.tui.args);
  } finally {
    if (daemon !== null) {
      terminateChild(daemon.child);
    }
  }
}

async function runApp(parsed) {
  const command = buildAppCommand(parsed);

  if (parsed.printCommand) {
    printCommand(command);
    return 0;
  }

  return await spawnForeground(command.command, command.args);
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseDoWhatArgs(argv);

  if (parsed.kind === "help") {
    printMainHelp();
    return 0;
  }

  if (parsed.kind === "cli-help") {
    printCliHelp();
    return 0;
  }

  if (parsed.kind === "app-help") {
    printAppHelp();
    return 0;
  }

  if (parsed.kind === "error") {
    console.error(`[do-what] ${parsed.message}`);
    console.error("Run `do-what --help` for usage.");
    return 1;
  }

  if (parsed.kind === "cli") {
    return await runCli(parsed);
  }

  return await runApp(parsed);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
) {
  const exitCode = await main();
  process.exit(exitCode);
}
