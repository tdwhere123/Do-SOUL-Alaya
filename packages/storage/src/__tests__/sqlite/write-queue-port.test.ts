import { describe, expect, it } from "vitest";
import {
  createInMemorySqliteWriteQueuePort,
  type SqliteWriteQueuePort
} from "../../sqlite/write-queue-port.js";

describe("SqliteWriteQueuePort contract", () => {
  it("serializes enqueue and blocks cache eviction until work completes", async () => {
    const queue: SqliteWriteQueuePort = createInMemorySqliteWriteQueuePort();
    const filename = "/tmp/alaya/test.db";
    const executionOrder: string[] = [];
    let overlap = false;
    let running = 0;

    let releaseSlowJob: (() => void) | undefined;
    const slowJobGate = new Promise<void>((resolve) => {
      releaseSlowJob = resolve;
    });

    const first = queue.enqueue({
      jobId: "job-1",
      kind: "event_log_transaction",
      filename,
      execute: async () => {
        running += 1;
        if (running > 1) {
          overlap = true;
        }
        await slowJobGate;
        running -= 1;
        executionOrder.push("job-1");
      }
    });

    expect(queue.blocksEviction(filename)).toBe(true);

    const second = queue.enqueue({
      jobId: "job-2",
      kind: "ontology_write",
      filename,
      execute: async () => {
        running += 1;
        if (running > 1) {
          overlap = true;
        }
        executionOrder.push("job-2");
        running -= 1;
      }
    });

    await Promise.resolve();
    expect(executionOrder).toEqual([]);
    expect(queue.blocksEviction(filename)).toBe(true);

    releaseSlowJob?.();
    await first;
    await second;

    expect(overlap).toBe(false);
    expect(executionOrder).toEqual(["job-1", "job-2"]);
    expect(queue.pendingCount()).toBe(0);
    expect(queue.blocksEviction(filename)).toBe(false);
  });

  it("supports structuredClone serialization on its payload structure", () => {
    const job = {
      jobId: "job-serial-1",
      kind: "ontology_write" as const,
      filename: "/tmp/alaya/test.db",
      payload: {
        statements: [
          {
            sql: "INSERT INTO test_table (id, val) VALUES (?, ?)",
            params: [1, "test-value"]
          }
        ]
      }
    };

    const cloned = structuredClone(job);
    expect(cloned.jobId).toBe("job-serial-1");
    expect(cloned.payload.statements[0].sql).toBe("INSERT INTO test_table (id, val) VALUES (?, ?)");
    expect(cloned.payload.statements[0].params).toEqual([1, "test-value"]);
  });
});
