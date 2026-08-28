import { PassThrough } from "node:stream";
import type { AlayaDaemonRuntime } from "@do-soul/alaya";
import { describe, expect, it, vi } from "vitest";

const { createAlayaCliBridge, registerAlayaCliCommands, dispatch } = vi.hoisted(() => {
  const dispatch = vi.fn(async (argv: readonly string[]) => ({
    exitCode: 0,
    json: { argv }
  }));
  return {
    dispatch,
    createAlayaCliBridge: vi.fn(() => ({
      dispatch,
      registerSubcommand: vi.fn(),
      list: () => []
    })),
    registerAlayaCliCommands: vi.fn()
  };
});

vi.mock("@do-soul/alaya/cli/bridge", () => ({
  createAlayaCliBridge
}));

vi.mock("@do-soul/alaya/cli/register", () => ({
  registerAlayaCliCommands
}));

import { makeDispatchCli } from "../../../harness/daemon/runtime/daemon-mcp-support.js";

describe("bench daemon CLI dispatch", () => {
  it("constructs the CLI bridge once per daemon, not per dispatch", async () => {
    const firstRuntime = {} as AlayaDaemonRuntime;
    const firstDispatch = makeDispatchCli(firstRuntime);
    await firstDispatch(["review", "accept", "proposal-1", "--json"]);
    await firstDispatch(["review", "accept", "proposal-2", "--json"]);

    expect(createAlayaCliBridge).toHaveBeenCalledTimes(1);
    expect(registerAlayaCliCommands).toHaveBeenCalledTimes(1);
    expect(createAlayaCliBridge).toHaveBeenCalledWith(
      firstRuntime,
      expect.objectContaining({ isTTY: false })
    );
    expect(registerAlayaCliCommands).toHaveBeenCalledWith(expect.anything(), firstRuntime);
    expect(dispatch).toHaveBeenNthCalledWith(1, ["review", "accept", "proposal-1", "--json"]);
    expect(dispatch).toHaveBeenNthCalledWith(2, ["review", "accept", "proposal-2", "--json"]);

    const secondRuntime = {} as AlayaDaemonRuntime;
    const secondDispatch = makeDispatchCli(secondRuntime);
    await secondDispatch(["install", "--json"]);

    expect(createAlayaCliBridge).toHaveBeenCalledTimes(2);
    expect(registerAlayaCliCommands).toHaveBeenCalledTimes(2);
    expect(registerAlayaCliCommands).toHaveBeenLastCalledWith(expect.anything(), secondRuntime);
    expect(dispatch).toHaveBeenNthCalledWith(3, ["install", "--json"]);
  });

  it("drains unread stdout and stderr so a later dispatch cannot stall", () => {
    const resume = vi.spyOn(PassThrough.prototype, "resume");
    try {
      makeDispatchCli({} as AlayaDaemonRuntime);
      expect(resume).toHaveBeenCalledTimes(2);
    } finally {
      resume.mockRestore();
    }
  });
});
