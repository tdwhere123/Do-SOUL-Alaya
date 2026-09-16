import { describe, expect, it } from "vitest";
import { createApp } from "../../runtime/app.js";
import { createRequestProtection } from "../../runtime/daemon/lifecycle/daemon-runtime-support.js";

describe("X-Alaya-Desktop is not authentication", () => {
  it("rejects originless desktop requests when remote bind disables the bypass", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token",
        allowDesktopOriginlessRequests: false
      }
    });

    const originless = await app.request("/unknown", {
      headers: {
        "x-request-token": "secret-token",
        "x-alaya-desktop": "1"
      }
    });
    expect(originless.status).toBe(403);
    await expect(originless.json()).resolves.toEqual({
      success: false,
      error: "Origin is not allowed"
    });

    const allowedOrigin = await app.request("/unknown", {
      headers: {
        origin: "http://localhost:5173",
        "x-request-token": "secret-token",
        "x-alaya-desktop": "1"
      }
    });
    expect(allowedOrigin.status).toBe(404);
  });

  it("hard-disables originless desktop admission when ALAYA_ALLOW_REMOTE_DAEMON=1", () => {
    const remote = createRequestProtection({
      ALAYA_REQUEST_TOKEN: "secret-token",
      ALAYA_ALLOW_REMOTE_DAEMON: "1"
    });
    const loopback = createRequestProtection({
      ALAYA_REQUEST_TOKEN: "secret-token"
    });
    expect(remote.allowDesktopOriginlessRequests).toBe(false);
    expect(loopback.allowDesktopOriginlessRequests).toBe(true);
  });

  it("rejects originless desktop when createApp is not given the bypass flag", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token"
      }
    });
    const originless = await app.request("/unknown", {
      headers: {
        "x-request-token": "secret-token",
        "x-alaya-desktop": "1"
      }
    });
    expect(originless.status).toBe(403);
    await expect(originless.json()).resolves.toEqual({
      success: false,
      error: "Origin is not allowed"
    });
  });
});
