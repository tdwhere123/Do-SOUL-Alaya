import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeRecallEvalPoolDump } from
  "../../../bench/provenance/recall-eval/recall-eval-pool-dump.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("recall-eval pool dump evidence identity", () => {
  it("marks gold by kind and raw ID", () => {
    const root = mkdtempSync(join(tmpdir(), "recall-eval-pool-dump-"));
    roots.push(root);
    const dumpPath = join(root, "pool.jsonl");
    vi.stubEnv("ALAYA_RECALL_EVAL_POOL_DUMP", dumpPath);

    writeRecallEvalPoolDump("q-evidence", [{
      objectId: "shared",
      objectKind: "evidence_capsule"
    }], [
      { object_id: "shared", object_kind: "memory_entry" },
      { object_id: "shared", object_kind: "evidence_capsule" },
      { object_id: "shared", object_kind: "synthesis_capsule" }
    ]);

    const row = JSON.parse(readFileSync(dumpPath, "utf8")) as {
      goldObjects: unknown;
      pool: Array<{ objectKind: string; isGold: boolean }>;
    };
    expect(row.goldObjects).toEqual([{
      objectId: "shared",
      objectKind: "evidence_capsule"
    }]);
    expect(row.pool).toEqual([
      expect.objectContaining({ objectKind: "memory_entry", isGold: false }),
      expect.objectContaining({ objectKind: "evidence_capsule", isGold: true }),
      expect.objectContaining({ objectKind: "synthesis_capsule", isGold: false })
    ]);
  });
});
