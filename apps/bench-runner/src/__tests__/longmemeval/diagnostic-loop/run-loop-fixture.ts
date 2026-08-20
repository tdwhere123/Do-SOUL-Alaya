import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiagnosticLoop } from "../../../bench/diagnostic-loop/run.js";
import { loopRequest, trackingAdapters } from "./fixture.js";

export function createLoopTemp(prefix = "diagnostic-loop-") {
  const roots: string[] = [];
  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
  async function cleanupLoopTemps(): Promise<void> {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
  async function resume(workRoot: string) {
    return await runDiagnosticLoop({
      workRoot,
      request: loopRequest(),
      mode: "run",
      adapters: trackingAdapters().adapters,
      argv: []
    });
  }
  async function completedRun(): Promise<string> {
    const workRoot = await tempRoot();
    await resume(workRoot);
    return workRoot;
  }
  return { tempRoot, cleanupLoopTemps, resume, completedRun };
}
