import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAEMON_URL,
  buildAppCommand,
  buildCliCommands,
  isLocalDaemonUrl,
  parseDoWhatArgs
} from "../do-what.mjs";

describe("do-what root CLI", () => {
  it("maps `do-what cli` to the TUI entry and local daemon startup", () => {
    const parsed = parseDoWhatArgs(["cli"], {});

    expect(parsed).toMatchObject({
      kind: "cli",
      daemonUrl: DEFAULT_DAEMON_URL,
      autoStartDaemon: true,
      passthroughArgs: []
    });

    const commands = buildCliCommands(parsed);

    expect(commands.daemon).toEqual({
      command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      args: ["--dir", "apps/core-daemon", "dev"]
    });
    expect(commands.tui.args).toEqual([
      "--dir",
      "apps/tui",
      "dev",
      "--",
      "--url",
      DEFAULT_DAEMON_URL
    ]);
  });

  it("passes custom TUI args while keeping daemon URL ownership in the root CLI", () => {
    const parsed = parseDoWhatArgs([
      "cli",
      "--url",
      "http://localhost:3000",
      "--no-daemon",
      "--",
      "--theme",
      "compact"
    ], {});

    expect(parsed).toMatchObject({
      kind: "cli",
      daemonUrl: "http://localhost:3000",
      autoStartDaemon: false,
      passthroughArgs: ["--theme", "compact"]
    });
    expect(buildCliCommands(parsed).tui.args).toContain("http://localhost:3000");
  });

  it("maps `do-what app` to the GUI startup script", () => {
    const parsed = parseDoWhatArgs(["app", "--desktop"], {});

    expect(parsed).toMatchObject({
      kind: "app",
      passthroughArgs: ["--desktop"]
    });
    expect(buildAppCommand(parsed).args.at(-1)).toBe("--desktop");
  });

  it("accepts only local port 3000 for daemon auto-start", () => {
    expect(isLocalDaemonUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalDaemonUrl("http://localhost:3000")).toBe(true);
    expect(isLocalDaemonUrl("http://localhost:3001")).toBe(false);
    expect(isLocalDaemonUrl("https://localhost:3000")).toBe(false);
  });
});
