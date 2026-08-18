import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/recall-any5-mimo-loop.sh"
);

describe("recall-any5-mimo-loop", () => {
  it("refuses a window larger than 3 without an explicit confirm", async () => {
    await chmod(script, 0o755);
    await expect(execFileAsync("bash", [script, "diagnostic", "--limit", "100"], {
      timeout: 10_000
    })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("refusing limit=100")
    });
  });
});
