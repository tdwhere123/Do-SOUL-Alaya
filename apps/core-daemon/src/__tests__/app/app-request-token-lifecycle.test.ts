import { describe, expect, it } from "vitest";
import { createApp } from "../../runtime/app.js";
import { createRequestProtection } from "../../runtime/daemon-runtime-support.js";

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
});
