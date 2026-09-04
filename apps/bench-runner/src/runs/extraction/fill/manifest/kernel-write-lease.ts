import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const STARTING = 0;
const ACTIVE = 1;
const OCCUPIED = 2;
const FAILED = 3;
const RELEASED = 4;
const HANDSHAKE_TIMEOUT_MS = 5_000;

const WORKER_SOURCE = `
const net = require("node:net");
const { parentPort, workerData } = require("node:worker_threads");
const state = new Int32Array(workerData.state);
const publish = (value) => {
  Atomics.store(state, 0, value);
  Atomics.notify(state, 0);
};
const server = net.createServer();
server.once("error", (error) => {
  publish(error && error.code === "EADDRINUSE" ? 2 : 3);
});
server.listen(workerData.address, () => publish(1));
parentPort.once("message", () => {
  server.close(() => publish(4));
});
`;

export interface KernelWriteLease {
  assertOwned(): void;
  release(): void;
}

export interface KernelWriteLeaseTarget {
  readonly device: string;
  readonly inode: string;
  readonly displayPath: string;
}

export function acquireKernelWriteLease(target: KernelWriteLeaseTarget): KernelWriteLease {
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const address = abstractSocketAddress(target);
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { address, state: state.buffer }
  });
  Atomics.wait(state, 0, STARTING, HANDSHAKE_TIMEOUT_MS);
  const acquisition = Atomics.load(state, 0);
  if (acquisition !== ACTIVE) {
    void worker.terminate();
    if (acquisition === OCCUPIED) {
      throw new Error(
        `extraction cache root ${target.displayPath} already has an active writer lock`
      );
    }
    throw new Error("extraction cache kernel writer lease could not be acquired");
  }
  worker.unref();
  let released = false;
  return Object.freeze({
    assertOwned(): void {
      if (released || Atomics.load(state, 0) !== ACTIVE) {
        throw new Error("extraction cache kernel writer lease is not active");
      }
    },
    release(): void {
      if (released) throw new Error("extraction cache kernel writer lease was already released");
      released = true;
      worker.ref();
      worker.postMessage("release");
      Atomics.wait(state, 0, ACTIVE, HANDSHAKE_TIMEOUT_MS);
      const releaseState = Atomics.load(state, 0);
      void worker.terminate();
      if (process.platform !== "win32" && !address.startsWith("\0")) {
        try { unlinkSync(address); } catch { /* leftover socket after close */ }
      }
      if (releaseState !== RELEASED) {
        throw new Error("extraction cache kernel writer lease did not release cleanly");
      }
    }
  });
}

export function isKernelWriteLeaseActive(target: KernelWriteLeaseTarget): boolean {
  try {
    const lease = acquireKernelWriteLease(target);
    lease.release();
    return false;
  } catch (cause) {
    if (cause instanceof Error && /already has an active writer lock/u.test(cause.message)) {
      return true;
    }
    throw cause;
  }
}

function abstractSocketAddress(target: KernelWriteLeaseTarget): string {
  const digest = createHash("sha256")
    .update(`${target.device}:${target.inode}`, "utf8")
    .digest("hex");
  if (process.platform === "linux") {
    return `\0alaya-extraction-cache-write-${digest}`;
  }
  if (process.platform === "win32") {
    const sep = String.fromCharCode(92);
    return [sep + sep + "." + sep + "pipe", `alaya-w-${digest.slice(0, 16)}`].join(sep);
  }
  const dir = process.platform === "darwin" ? "/tmp" : tmpdir();
  return join(dir, `alaya-w-${digest.slice(0, 16)}.sock`);
}
