import { describe, expect, it } from "vitest";
import { isRemoteDaemonOptInEnabled, resolveDaemonHostFromEnv } from "../server-options.js";

type EnvLike = Record<string, string | undefined>;

describe("core daemon server listen options", () => {
  it("defaults to loopback host when DAEMON_HOST is absent", () => {
    const host = resolveDaemonHostFromEnv({} as EnvLike);

    expect(host).toBe("127.0.0.1");
  });

  it.each(["", " ", "\t", "\n\t  "])(
    "treats whitespace-only DAEMON_HOST as absent and falls back to loopback: %s",
    (value) => {
      const host = resolveDaemonHostFromEnv({
        DAEMON_HOST: value,
      } as EnvLike);

      expect(host).toBe("127.0.0.1");
    },
  );

  it("rejects non-loopback DAEMON_HOST when opt-in is not enabled", () => {
    expect(() =>
      resolveDaemonHostFromEnv({
        DAEMON_HOST: "0.0.0.0",
      } as EnvLike),
    ).toThrowError(/DAEMON_HOST/);
  });

  it("allows non-loopback DAEMON_HOST when DO_WHAT_ALLOW_REMOTE_DAEMON is set", () => {
    const host = resolveDaemonHostFromEnv({
      DAEMON_HOST: "0.0.0.0",
      DO_WHAT_ALLOW_REMOTE_DAEMON: "1",
    } as EnvLike);

    expect(host).toBe("0.0.0.0");
  });

  it("reports remote-daemon opt-in only when DO_WHAT_ALLOW_REMOTE_DAEMON=1", () => {
    expect(isRemoteDaemonOptInEnabled({} as EnvLike)).toBe(false);
    expect(isRemoteDaemonOptInEnabled({ DO_WHAT_ALLOW_REMOTE_DAEMON: "0" } as EnvLike)).toBe(false);
    expect(isRemoteDaemonOptInEnabled({ DO_WHAT_ALLOW_REMOTE_DAEMON: "1" } as EnvLike)).toBe(true);
  });
});
