import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startBenchDaemon, type BenchDaemonHandle } from "../../harness/daemon.js";

let abandoned: { handle: BenchDaemonHandle; dataDir: string } | undefined;

it.fails("times out while a bench daemon is still running", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "daemon-cancel-"));
  const handle = await startBenchDaemon({ dataDirRoot: dataDir, embeddingMode: "disabled" });
  abandoned = { handle, dataDir };
  await new Promise<void>(() => {});
}, 12_000);

it("starts the next daemon only after cancelled work has exited", async () => {
  expect(abandoned).toBeDefined();
  const closed = await Promise.race([
    abandoned!.handle.mcpClient.listTools().then(() => "open" as const, () => "closed" as const),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000))
  ]);
  expect(closed).toBe("closed");
  const dataDir = mkdtempSync(join(tmpdir(), "daemon-cancel-next-"));
  const handle = await startBenchDaemon({ dataDirRoot: dataDir, embeddingMode: "disabled" });
  await handle.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(abandoned!.dataDir, { recursive: true, force: true });
  abandoned = undefined;
});
