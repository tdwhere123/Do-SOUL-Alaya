import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { startInspectorServer } from "../server.js";

describe("inspector server startup", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("refuses to start without a daemon URL", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));

    await expect(
      startInspectorServer({
        env: { ALAYA_INSPECTOR_TOKEN: "token" },
        stderr,
        stdout: new PassThrough()
      })
    ).rejects.toThrow("inspector_daemon_url_missing");

    expect(stderrChunks.join("")).toBe("inspector_daemon_url_missing\n");
    expect(process.exitCode).toBe(2);
  });
});
