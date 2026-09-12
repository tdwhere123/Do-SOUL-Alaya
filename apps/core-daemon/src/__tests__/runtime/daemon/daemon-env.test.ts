import { describe, expect, it } from "vitest";
import { validateDaemonEnv } from "../../../runtime/daemon/support/daemon-env.js";

describe("validateDaemonEnv", () => {
  it("accepts the bounded daemon startup env surface", () => {
    expect(
      validateDaemonEnv({
        PORT: "3000",
        DAEMON_HOST: "127.0.0.1",
        ALLOWED_ORIGIN: "http://localhost:5173",
        ALAYA_ALLOW_REMOTE_DAEMON: "0",
        ALAYA_LOG_LEVEL: "info",
        ALAYA_REQUEST_TOKEN: "daemon-token",
        ALAYA_REVIEWER_TOKEN: "review-token",
        ALAYA_REVIEWER_IDENTITY: "user:reviewer"
      })
    ).toMatchObject({
      PORT: "3000",
      DAEMON_HOST: "127.0.0.1",
      ALLOWED_ORIGIN: "http://localhost:5173",
      ALAYA_REQUEST_TOKEN: "daemon-token"
    });
  });

  it("preserves unix-socket and token-binding keys used by createRequestProtection", () => {
    expect(
      validateDaemonEnv({
        ALAYA_REQUEST_TOKEN: "daemon-token",
        ALAYA_DAEMON_SOCKET: "/tmp/alaya.sock",
        ALAYA_ALLOW_WILDCARD_BIND: "0",
        ALAYA_REQUEST_TOKEN_WORKSPACES: "ws-a,ws-b"
      })
    ).toMatchObject({
      ALAYA_REQUEST_TOKEN: "daemon-token",
      ALAYA_DAEMON_SOCKET: "/tmp/alaya.sock",
      ALAYA_ALLOW_WILDCARD_BIND: "0",
      ALAYA_REQUEST_TOKEN_WORKSPACES: "ws-a,ws-b"
    });
  });

  it("rejects invalid daemon ports", () => {
    expect(() => validateDaemonEnv({ PORT: "70000" })).toThrowError(/PORT/);
  });

  it("rejects invalid log levels", () => {
    expect(() => validateDaemonEnv({ ALAYA_LOG_LEVEL: "verbose" })).toThrowError(/ALAYA_LOG_LEVEL/);
  });

  it("rejects malformed allowed origins", () => {
    expect(() => validateDaemonEnv({ ALLOWED_ORIGIN: "http://localhost:5173/path" })).toThrowError(
      /ALLOWED_ORIGIN/
    );
  });

  it("requires reviewer token and identity to be configured together", () => {
    expect(() => validateDaemonEnv({ ALAYA_REVIEWER_TOKEN: "review-token" })).toThrowError(
      /ALAYA_REVIEWER_TOKEN and ALAYA_REVIEWER_IDENTITY/
    );
  });
});
