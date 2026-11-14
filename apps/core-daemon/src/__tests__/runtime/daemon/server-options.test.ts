import { describe, expect, it } from "vitest";
import { applyRemoteBindTokenRotation } from "../../../runtime/request-token-binding.js";
import {
  isLoopbackHost,
  isRemoteDaemonBind,
  isRemoteDaemonOptInEnabled,
  resolveDaemonHostFromEnv,
  resolveDaemonListenPolicy,
  warnIfRemoteDaemonListening
} from "../../../runtime/server-options.js";

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

  it("rejects wildcard 0.0.0.0 bind without ALAYA_ALLOW_WILDCARD_BIND even when remote opt-in is set", () => {
    expect(() =>
      resolveDaemonHostFromEnv({
        DAEMON_HOST: "0.0.0.0",
        ALAYA_ALLOW_REMOTE_DAEMON: "1"
      } as EnvLike)
    ).toThrowError(/ALAYA_ALLOW_WILDCARD_BIND=1/);
    expect(() =>
      resolveDaemonHostFromEnv({
        DAEMON_HOST: "::",
        ALAYA_ALLOW_REMOTE_DAEMON: "1"
      } as EnvLike)
    ).toThrowError(/wildcard bind/);
  });

  it("rejects non-loopback TCP without a unix socket even with remote and wildcard opt-in", () => {
    expect(() =>
      resolveDaemonHostFromEnv({
        DAEMON_HOST: "192.168.1.10",
        ALAYA_ALLOW_REMOTE_DAEMON: "1"
      } as EnvLike)
    ).toThrowError(/Plaintext remote HTTP is unsupported/);
    expect(() =>
      resolveDaemonHostFromEnv({
        DAEMON_HOST: "0.0.0.0",
        ALAYA_ALLOW_REMOTE_DAEMON: "1",
        ALAYA_ALLOW_WILDCARD_BIND: "1"
      } as EnvLike)
    ).toThrowError(/ALAYA_DAEMON_SOCKET/);
  });

  it("accepts a unix socket as the non-loopback alternative and keeps TCP on loopback", () => {
    const policy = resolveDaemonListenPolicy({
      DAEMON_HOST: "0.0.0.0",
      ALAYA_ALLOW_REMOTE_DAEMON: "1",
      ALAYA_ALLOW_WILDCARD_BIND: "1",
      ALAYA_DAEMON_SOCKET: "/tmp/alaya.sock"
    } as EnvLike);

    expect(policy).toEqual({
      kind: "unix",
      path: "/tmp/alaya.sock",
      tcpHost: "127.0.0.1"
    });
    expect(
      resolveDaemonHostFromEnv({
        ALAYA_DAEMON_SOCKET: "/tmp/alaya.sock"
      } as EnvLike)
    ).toBe("127.0.0.1");
  });

  it("rotates the request token for a unix-socket bind and does not reuse the file token", () => {
    const protection = {
      allowedOrigin: "http://localhost:5173",
      requestToken: "long-lived-file-token",
      tokenSource: "env" as const
    };
    const rotated = applyRemoteBindTokenRotation(protection, {
      ALAYA_DAEMON_SOCKET: "/tmp/alaya.sock"
    });

    expect(rotated.tokenSource).toBe("rotated");
    expect(rotated.requestToken).not.toBe("long-lived-file-token");
    expect(rotated.requestToken.length).toBeGreaterThan(16);
    expect(
      applyRemoteBindTokenRotation(protection, {}).requestToken
    ).toBe("long-lived-file-token");
  });

  it("rejects a long-lived env token for remote TCP even when remote opt-in is set", () => {
    const protection = {
      allowedOrigin: "http://localhost:5173",
      requestToken: "long-lived-file-token",
      tokenSource: "env" as const
    };
    expect(() =>
      applyRemoteBindTokenRotation(protection, {
        DAEMON_HOST: "192.168.1.10",
        ALAYA_ALLOW_REMOTE_DAEMON: "1"
      })
    ).toThrow(/Long-lived ALAYA_REQUEST_TOKEN cannot be used for remote binds/);
  });

  it("reports remote-daemon opt-in only when ALAYA_ALLOW_REMOTE_DAEMON=1", () => {
    expect(isRemoteDaemonOptInEnabled({} as EnvLike)).toBe(false);
    expect(isRemoteDaemonOptInEnabled({ ALAYA_ALLOW_REMOTE_DAEMON: "0" } as EnvLike)).toBe(false);
    expect(isRemoteDaemonOptInEnabled({ ALAYA_ALLOW_REMOTE_DAEMON: "1" } as EnvLike)).toBe(true);
  });

  it("warns that plaintext remote HTTP is unsupported on a non-loopback host", () => {
    const messages: string[] = [];
    warnIfRemoteDaemonListening(
      { ALAYA_ALLOW_REMOTE_DAEMON: "1" },
      "0.0.0.0",
      (message) => messages.push(message)
    );

    expect(messages.join("\n")).toContain("plaintext remote HTTP");
    expect(messages.join("\n")).toContain("unsupported");
  });

  it("does not warn for loopback remote opt-in", () => {
    const messages: string[] = [];
    warnIfRemoteDaemonListening(
      { ALAYA_ALLOW_REMOTE_DAEMON: "1" },
      "127.0.0.1",
      (message) => messages.push(message)
    );

    expect(messages).toEqual([]);
  });

  it("treats IPv4-mapped loopback as loopback listen, not a remote fail-closed bind", () => {
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isRemoteDaemonBind({ DAEMON_HOST: "::ffff:127.0.0.1" })).toBe(false);
    expect(resolveDaemonListenPolicy({
      DAEMON_HOST: "::ffff:127.0.0.1"
    })).toEqual({ kind: "loopback", host: "::ffff:127.0.0.1" });
  });

  it("keeps unknown-peer fail-closed on a unix bind whose DAEMON_HOST is non-loopback", () => {
    expect(isRemoteDaemonBind({
      DAEMON_HOST: "0.0.0.0",
      ALAYA_DAEMON_SOCKET: "/tmp/alaya.sock",
      ALAYA_ALLOW_REMOTE_DAEMON: "1",
      ALAYA_ALLOW_WILDCARD_BIND: "1"
    })).toBe(true);
  });

  it("does not treat a unix socket with default loopback TCP as a remote bind", () => {
    expect(isRemoteDaemonBind({ ALAYA_DAEMON_SOCKET: "/tmp/alaya.sock" })).toBe(false);
    expect(isRemoteDaemonBind({})).toBe(false);
  });
});
