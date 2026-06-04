import os from "node:os";
import { defineConfig } from "vitest/config";
import projects from "./vitest.workspace.mjs";

const hasProjects = projects.length > 0;

// invariant: the global vitest fork pool MUST stay memory-bounded.
// This dev box is 20 vCPU / 7.6 GiB RAM; with no cap vitest 4 defaults the
// forks pool to availableParallelism (~20), and a single heavy fork
// (core embedding + better-sqlite3 + daemon fixtures) peaks well over 1 GiB,
// so an uncapped run OOM-freezes the VM. Cap = workers that fit in RAM,
// never above CPU count. D is GiB-of-headroom per worker; D=3.5 yields 2 on
// 7.6 GiB and ~9 on a 32 GiB/32-vCPU CI box, so CI throughput is preserved.
// cross-file ref: vitest.workspace.mjs (per-project defineProject members).
const GIB_PER_WORKER = 3.5;

function computeMaxWorkers() {
  const override = process.env.VITEST_MAX_WORKERS;
  if (override !== undefined) {
    const parsed = Number(override);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const totalGiB = os.totalmem() / 1024 ** 3;
  const parallelism = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(parallelism, Math.floor(totalGiB / GIB_PER_WORKER)));
}

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  test: {
    ...(hasProjects
      ? { projects }
      : { include: ["__no_tests__/**/*.test.ts"], passWithNoTests: true }),
    // forks are killable and memory-isolated per file — safest for the native
    // better-sqlite3 / onnxruntime modules these suites load (also the v4
    // default; set explicitly to document the OOM guard).
    pool: "forks",
    maxWorkers,
    minWorkers: 1,
    reporters: ["default"],
  },
});
