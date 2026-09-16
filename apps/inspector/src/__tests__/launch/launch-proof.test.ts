import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { INSPECTOR_LAUNCH_PROOF_FD, readInspectorLaunchProof } from "../../launch/launch-proof.js";

describe("inspector launch proof", () => {
  it("reads the inherited fd", () => {
    expect(
      readInspectorLaunchProof((fd) => {
        expect(fd).toBe(INSPECTOR_LAUNCH_PROOF_FD);
        return "from-fd\n";
      })
    ).toBe("from-fd");
  });

  it("does not fall back to the environment when the inherited fd is unavailable", () => {
    expect(
      readInspectorLaunchProof(() => {
        throw new Error("EBADF");
      })
    ).toBeUndefined();
  });

  it("does not consume an IPC-connected worker fd as launch proof", () => {
    expect(process.connected).toBe(true);
    expect(readInspectorLaunchProof()).toBeUndefined();
  });

  it("reads launch proof from an extra stdio pipe when the process has no IPC", async () => {
    const moduleUrl = new URL("../../launch/launch-proof.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `import { readInspectorLaunchProof } from ${JSON.stringify(moduleUrl)};
process.stdout.write(readInspectorLaunchProof() ?? "");`
      ],
      { stdio: ["ignore", "pipe", "pipe", "pipe"] }
    );
    const stdout = child.stdout;
    const proof = child.stdio[INSPECTOR_LAUNCH_PROOF_FD];
    if (stdout === null || proof === null || proof === undefined || !("end" in proof)) {
      throw new Error("inspector launch proof fd is unavailable");
    }
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    proof.on("error", () => undefined);
    proof.end("from-pipe\n");
    const [status] = await once(child, "close");
    expect(status).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe("from-pipe");
  });
});
