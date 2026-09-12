import { describe, expect, it } from "vitest";
import { createApp } from "../../runtime/app.js";
import { validateDaemonEnv } from "../../runtime/daemon/support/daemon-env.js";
import { createRequestProtection } from "../../runtime/daemon/lifecycle/daemon-runtime-support.js";

describe("daemon request token lifecycle", () => {
  it("keeps an explicit token stable across restarts and rotates it by configuration", async () => {
    const initial = createRequestProtection({ ALAYA_REQUEST_TOKEN: "operator-token-v1" });
    const restarted = createRequestProtection({ ALAYA_REQUEST_TOKEN: "operator-token-v1" });
    const rotated = createRequestProtection({ ALAYA_REQUEST_TOKEN: "operator-token-v2" });

    expect(initial).toMatchObject({ requestToken: "operator-token-v1", tokenSource: "env" });
    expect(restarted.requestToken).toBe(initial.requestToken);
    expect(rotated.requestToken).not.toBe(initial.requestToken);

    const rotatedApp = createApp({ requestProtection: rotated });
    const oldToken = await rotatedApp.request("/unknown", {
      headers: { "x-request-token": initial.requestToken, "x-alaya-desktop": "1" }
    });
    const newToken = await rotatedApp.request("/unknown", {
      headers: { "x-request-token": rotated.requestToken, "x-alaya-desktop": "1" }
    });

    expect(oldToken.status).toBe(403);
    expect(newToken.status).toBe(404);
  });

  it("rotates the shared protection object when unix-socket bind is configured", () => {
    const protection = createRequestProtection({
      ALAYA_REQUEST_TOKEN: "file-token",
      ALAYA_DAEMON_SOCKET: "/tmp/alaya-review-rotate.sock"
    });
    expect(protection.tokenSource).toBe("rotated");
    expect(protection.requestToken).not.toBe("file-token");
  });

  it("rotates through validateDaemonEnv so createApp does not mint a second secret", async () => {
    const env = {
      ALAYA_REQUEST_TOKEN: "file-token",
      ALAYA_DAEMON_SOCKET: "/tmp/alaya-validate-rotate.sock",
      ALAYA_REQUEST_TOKEN_WORKSPACES: "ws-listed"
    };
    const validated = validateDaemonEnv(env);
    expect(validated.ALAYA_DAEMON_SOCKET).toBe("/tmp/alaya-validate-rotate.sock");
    expect(validated.ALAYA_REQUEST_TOKEN_WORKSPACES).toBe("ws-listed");

    const protection = createRequestProtection(validated);
    expect(protection.tokenSource).toBe("rotated");
    expect(protection.requestToken).not.toBe("file-token");
    expect(protection.boundWorkspaceIds).toEqual(["ws-listed"]);

    const previousSocket = process.env.ALAYA_DAEMON_SOCKET;
    process.env.ALAYA_DAEMON_SOCKET = env.ALAYA_DAEMON_SOCKET;
    try {
      const app = createApp({ requestProtection: protection });
      const rotated = await app.request("/unknown", {
        headers: { "x-request-token": protection.requestToken, "x-alaya-desktop": "1" }
      });
      const fileToken = await app.request("/unknown", {
        headers: { "x-request-token": "file-token", "x-alaya-desktop": "1" }
      });
      expect(rotated.status).toBe(404);
      expect(fileToken.status).toBe(403);
    } finally {
      if (previousSocket === undefined) {
        delete process.env.ALAYA_DAEMON_SOCKET;
      } else {
        process.env.ALAYA_DAEMON_SOCKET = previousSocket;
      }
    }
  });
});
