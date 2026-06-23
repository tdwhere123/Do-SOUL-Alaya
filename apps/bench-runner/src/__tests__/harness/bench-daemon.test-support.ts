import { startBenchDaemon, type BenchDaemonHandle, type BenchDaemonOptions } from "../../harness/daemon.js";

// Always shuts down (releasing the single-daemon slot) even if the body throws,
// so a failing assertion can't leak the slot into later tests in the file.
export async function withBenchDaemon<T>(
  opts: BenchDaemonOptions,
  body: (daemon: BenchDaemonHandle) => Promise<T>
): Promise<T> {
  const daemon = await startBenchDaemon(opts);
  try {
    return await body(daemon);
  } finally {
    await daemon.shutdown().catch(() => undefined);
  }
}
