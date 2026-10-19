import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";

it("does not publish an interrupted download and downloads it again on restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alaya-download-"));
  let interrupt = true;
  let requests = 0;
  let started!: () => void;
  const firstRequest = new Promise<void>(resolve => { started = resolve; });
  // Tiny local fixtures, never model weights or an external provider.
  const server = createServer((_request, response) => {
    requests++;
    if (interrupt) {
      response.write("partial", started);
    } else {
      response.end("complete fixture");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No loopback address");
  const env = { HOME: root, HF_ENDPOINT: `http://127.0.0.1:${address.port}` };
  const script = path.resolve(import.meta.dirname, "../../../../../scripts/fetch-local-embedding-model.mjs");
  const args = [script, "--cache-dir", root, "--model", "fixture/model"];
  const modelRoot = path.join(root, "fixture/model");
  const finalPath = path.join(modelRoot, "config.json");
  const child = spawn(process.execPath, args, { env, stdio: "ignore" });
  const exited = once(child, "exit");
  try {
    await firstRequest;
    // Observe actual bytes on disk before simulating process death.
    const hasBytes = () => readdirSync(modelRoot).some(name => statSync(path.join(modelRoot, name)).size > 0);
    for (let attempt = 0; !hasBytes() && attempt < 400; attempt++) await delay(5);
    expect(hasBytes()).toBe(true);
    child.kill("SIGKILL");
    await exited;
    expect(existsSync(finalPath)).toBe(false);
    interrupt = false;
    await promisify(execFile)(process.execPath, args, { env });
    expect(await readFile(finalPath, "utf8")).toBe("complete fixture");
    expect(requests).toBe(6);
    await promisify(execFile)(process.execPath, args, { env });
    expect(requests).toBe(6);
  } finally {
    child.kill("SIGKILL");
    await exited;
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
