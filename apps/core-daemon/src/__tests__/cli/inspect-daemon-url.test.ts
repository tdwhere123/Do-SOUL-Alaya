import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  assertInspectDaemonUrl,
  ensureDaemonForInspector
} from "../../cli/inspect/inspect-daemon-client.js";
import type { AlayaCliContext } from "../../cli/bridge.js";
import type { InspectCommandDependencies } from "../../cli/inspect/inspect-types.js";

function createContext(env: NodeJS.ProcessEnv): AlayaCliContext {
  return {
    cwd: "/tmp",
    env,
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] }
  };
}

describe("inspect daemon URL loopback guard", () => {
  it("rejects a non-loopback ALAYA_DAEMON_URL without remote opt-in", () => {
    expect(() => assertInspectDaemonUrl("http://evil.example:5173", {})).toThrow(/loopback/u);
    expect(() => assertInspectDaemonUrl("http://10.0.0.8:5173", {})).toThrow(/loopback/u);
  });

  it("allows 127.0.0.1, ::1, and localhost", () => {
    expect(() => assertInspectDaemonUrl("http://127.0.0.1:5173", {})).not.toThrow();
    expect(() => assertInspectDaemonUrl("http://[::1]:5173", {})).not.toThrow();
    expect(() => assertInspectDaemonUrl("http://localhost:5173", {})).not.toThrow();
  });

  it("allows a remote daemon URL only with ALAYA_ALLOW_REMOTE_DAEMON=1", () => {
    expect(() =>
      assertInspectDaemonUrl("http://evil.example:5173", { ALAYA_ALLOW_REMOTE_DAEMON: "1" })
    ).not.toThrow();
  });

  it("refuses to attach inspect to a non-loopback configured daemon", async () => {
    const deps: InspectCommandDependencies = {
      startDaemonServer: async () => {
        throw new Error("should not start a daemon");
      }
    };
    await expect(
      ensureDaemonForInspector(
        createContext({ ALAYA_DAEMON_URL: "http://external-daemon.local" }),
        deps,
        async () => true,
        undefined
      )
    ).rejects.toThrow(/loopback/u);
  });
});
