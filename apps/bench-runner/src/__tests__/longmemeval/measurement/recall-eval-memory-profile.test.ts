import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRecallEvalMemoryProfile,
  withRecallEvalMemoryProfile
} from "../../../longmemeval/measurement/recall-eval-memory-profile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("RecallEvalMemoryProfile", () => {
  it("stays disabled unless an output path is explicit", async () => {
    const memoryUsage = vi.fn(() => usage(1));
    const readSmapsRollup = vi.fn(async () => smaps(1));
    const monotonicNowMs = vi.fn(() => 1_000);

    await expect(createRecallEvalMemoryProfile({
      outputPath: undefined,
      memoryUsage,
      readSmapsRollup,
      monotonicNowMs
    })).resolves.toBeNull();
    expect(memoryUsage).not.toHaveBeenCalled();
    expect(readSmapsRollup).not.toHaveBeenCalled();
    expect(monotonicNowMs).not.toHaveBeenCalled();
  });
});

describe("RecallEvalMemoryProfile streaming", () => {
  it("streams deterministic JSONL samples and flushes them on close", async () => {
    const root = await temporaryRoot();
    const outputPath = join(root, "nested", "memory-profile.jsonl");
    const now = sequence([1_000, 1_025, 1_090]);
    const profile = await createRecallEvalMemoryProfile({
      outputPath,
      memoryUsage: sequence([usage(10), usage(20)]),
      readSmapsRollup: sequence([smaps(10), null]),
      monotonicNowMs: now
    });
    if (profile === null) throw new Error("explicit memory profile was not enabled");

    await expect(profile.sample({ phase: "seed", questionId: "q-1", questionIndex: 4 }))
      .resolves.toBeUndefined();
    await expect(profile.sample({ phase: "recall" })).resolves.toBeUndefined();
    expect(profile).not.toHaveProperty("samples");
    expect(profile).not.toHaveProperty("records");
    await profile.close();

    expect(parseJsonLines(await readFile(outputPath, "utf8"))).toEqual([
      {
        schema_version: 1,
        sequence: 1,
        phase: "seed",
        question_id: "q-1",
        question_index: 4,
        elapsed_ms: 25,
        process_memory_usage_bytes: expectedUsage(10),
        linux_smaps_rollup_kib: expectedSmaps(10)
      },
      {
        schema_version: 1,
        sequence: 2,
        phase: "recall",
        elapsed_ms: 90,
        process_memory_usage_bytes: expectedUsage(20),
        linux_smaps_rollup_kib: null
      }
    ]);
  });
});

describe("RecallEvalMemoryProfile file ownership", () => {
  it("claims the explicit output path exclusively without overwriting it", async () => {
    const root = await temporaryRoot();
    const outputPath = join(root, "owned.jsonl");
    await writeFile(outputPath, "existing\n", "utf8");

    await expect(createRecallEvalMemoryProfile(options(outputPath)))
      .rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(outputPath, "utf8")).resolves.toBe("existing\n");
  });

  it("rejects writes after close", async () => {
    const root = await temporaryRoot();
    const profile = await createRecallEvalMemoryProfile(
      options(join(root, "closed.jsonl"))
    );
    if (profile === null) throw new Error("explicit memory profile was not enabled");
    await profile.close();

    await expect(profile.sample({ phase: "after-close" }))
      .rejects.toThrow(/memory profile is closed/u);
  });
});

describe("RecallEvalMemoryProfile lifecycle", () => {
  it("closes the profile when the measured operation fails", async () => {
    const root = await temporaryRoot();
    let captured: Awaited<ReturnType<typeof createRecallEvalMemoryProfile>> = null;
    const failure = new Error("synthetic recall failure");

    await expect(withRecallEvalMemoryProfile(
      options(join(root, "failed-run.jsonl")),
      async (profile) => {
        captured = profile;
        await profile?.sample({ phase: "before-failure" });
        throw failure;
      }
    )).rejects.toBe(failure);
    if (captured === null) throw new Error("explicit memory profile was not enabled");

    await expect(captured.sample({ phase: "after-failure" }))
      .rejects.toThrow(/memory profile is closed/u);
  });

  it("returns an explicit incomplete outcome when close fails after success", async () => {
    const root = await temporaryRoot();
    const warnings: string[] = [];
    const closeError = Object.assign(new Error("synthetic close failure"), {
      code: "EIO"
    });

    const completed = await withRecallEvalMemoryProfile({
      ...options(join(root, "close-failure.jsonl")),
      flushAndClose: async (file) => {
        await file.close();
        throw closeError;
      }
    }, async () => "committed", (warning) => warnings.push(warning));

    expect(completed.value).toBe("committed");
    expect(completed.completion).toEqual({
      status: "incomplete",
      failures: [{ phase: "profile_close", name: "Error", code: "EIO" }]
    });
    expect(warnings).toEqual([
      "[recall-eval memory-profile] incomplete phase=profile_close name=Error code=EIO"
    ]);
  });
});

function options(outputPath: string) {
  return {
    outputPath,
    memoryUsage: () => usage(1),
    readSmapsRollup: async () => smaps(1),
    monotonicNowMs: sequence([1_000, 1_001, 1_002])
  };
}

function usage(multiplier: number) {
  return {
    rss: 1_000 * multiplier,
    heapTotal: 2_000 * multiplier,
    heapUsed: 3_000 * multiplier,
    external: 4_000 * multiplier,
    arrayBuffers: 5_000 * multiplier
  };
}

function expectedUsage(multiplier: number) {
  return {
    rss: 1_000 * multiplier,
    heap_total: 2_000 * multiplier,
    heap_used: 3_000 * multiplier,
    external: 4_000 * multiplier,
    array_buffers: 5_000 * multiplier
  };
}

function smaps(multiplier: number): string {
  return [
    `Rss: ${10 * multiplier} kB`,
    `Pss: ${20 * multiplier} kB`,
    `Shared_Clean: ${30 * multiplier} kB`,
    `Shared_Dirty: ${40 * multiplier} kB`,
    `Private_Clean: ${50 * multiplier} kB`,
    `Private_Dirty: ${60 * multiplier} kB`,
    `Swap: ${70 * multiplier} kB`
  ].join("\n");
}

function expectedSmaps(multiplier: number) {
  return {
    rss: 10 * multiplier,
    pss: 20 * multiplier,
    shared_clean: 30 * multiplier,
    shared_dirty: 40 * multiplier,
    private_clean: 50 * multiplier,
    private_dirty: 60 * multiplier,
    swap: 70 * multiplier
  };
}

function sequence<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("deterministic sequence exhausted");
    index += 1;
    return value;
  };
}

function parseJsonLines(contents: string): unknown[] {
  expect(contents.endsWith("\n")).toBe(true);
  return contents.trimEnd().split("\n").map((line) => JSON.parse(line));
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "recall-eval-memory-profile-"));
  roots.push(root);
  return root;
}
