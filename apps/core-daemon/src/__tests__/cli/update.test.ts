import { PassThrough } from "node:stream";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createAlayaCliBridge } from "../../cli/bridge.js";
import { createUpdateCommand } from "../../cli/update.js";

describe("alaya update", () => {
  it("prints VACUUM INTO backup path and restore steps", async () => {
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on("data", (chunk) => chunks.push(String(chunk)));
    const configDir = path.resolve("/tmp/alaya-update-guidance-test");
    const bridge = createAlayaCliBridge(
      { startupSteps: [] },
      {
        stdin: new PassThrough(),
        stdout,
        stderr: new PassThrough(),
        isTTY: false,
        env: {
          ...process.env,
          ALAYA_CONFIG_DIR: configDir
        }
      }
    );
    bridge.registerSubcommand(createUpdateCommand());

    const result = await bridge.dispatch(["update"]);
    const text = chunks.join("");

    expect(result.exitCode).toBe(0);
    expect(text).toContain("VACUUM INTO");
    expect(text).toContain(path.join(configDir, "backups"));
    expect(text).toContain(path.join(configDir, "alaya.db"));
    expect(text).toContain("stop the daemon");
    expect(text).toContain("ALAYA_HOME.bak");
  });
});
