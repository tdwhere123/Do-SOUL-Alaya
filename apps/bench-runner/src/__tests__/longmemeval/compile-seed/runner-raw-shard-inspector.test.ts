import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createRunnerRawShardInspector
} from "../../../longmemeval/compile-seed/cache/runner-raw-shard-inspector.js";

const CACHE_KEY = "a".repeat(64);
const MODEL = "test-model";
const REQUEST_PROFILE = "provider-default-v1" as const;

describe("runner raw shard inspector", () => {
  it("shares one verified inspection across primary and supplement phases", async () => {
    const cacheRoot = await cacheFixture('{"signals":[]}');
    const inspector = createRunnerRawShardInspector();

    const primary = inspector.inspect({
      phase: "primary",
      cacheRoot,
      cacheKey: CACHE_KEY,
      model: MODEL,
      requestProfile: REQUEST_PROFILE
    });
    const supplement = inspector.inspect({
      phase: "supplement",
      cacheRoot: join(cacheRoot, "."),
      cacheKey: CACHE_KEY,
      model: MODEL,
      requestProfile: REQUEST_PROFILE
    });

    expect(primary).toBe(supplement);
    expect(Object.isFrozen(primary)).toBe(true);
    expect(inspector.diagnostics).toEqual({
      primary: {
        physicalReads: 1,
        parseMisses: 1,
        memoHits: 0,
        inspectionMs: expect.any(Number)
      },
      supplement: {
        physicalReads: 0,
        parseMisses: 0,
        memoHits: 1,
        inspectionMs: 0
      }
    });
    const nextRunner = createRunnerRawShardInspector();
    expect(nextRunner.inspect({
      phase: "primary",
      cacheRoot,
      cacheKey: CACHE_KEY,
      model: MODEL,
      requestProfile: REQUEST_PROFILE
    })).not.toBe(primary);
    expect(nextRunner.diagnostics.primary.physicalReads).toBe(1);
  });

  it("validates every first access and separates all identity fields", async () => {
    const cacheRoot = await cacheFixture('{"signals":[]}');
    const otherRoot = await cacheFixture('{"signals":[]}');
    const inspector = createRunnerRawShardInspector();
    const input = {
      phase: "primary" as const,
      cacheRoot,
      cacheKey: CACHE_KEY,
      model: MODEL,
      requestProfile: REQUEST_PROFILE
    };

    const first = inspector.inspect(input);
    expect(first.status).toBe("hit");
    expect(inspector.inspect(input)).toBe(first);
    const otherRootResult = inspector.inspect({ ...input, cacheRoot: otherRoot });
    expect(otherRootResult.status).toBe("hit");
    expect(otherRootResult).not.toBe(first);

    const missingKey = "b".repeat(64);
    expect(inspector.inspect({ ...input, cacheKey: missingKey }).status).toBe("missing");
    writeShard(cacheRoot, missingKey, '{"signals":[]}');
    const otherKeyResult = inspector.inspect({ ...input, cacheKey: missingKey });
    expect(otherKeyResult.status).toBe("hit");
    expect(otherKeyResult).not.toBe(first);
    expect(inspector.inspect({ ...input, cacheKey: missingKey })).toBe(otherKeyResult);

    const otherModelResult = inspector.inspect({ ...input, model: "different-model" });
    expect(otherModelResult.status).toBe("invalid");
    expect(otherModelResult).not.toBe(first);
    const otherProfileResult = inspector.inspect({
      ...input,
      requestProfile: "deepseek-v4-nonthinking-v1"
    });
    expect(otherProfileResult.status).toBe("invalid");
    expect(otherProfileResult).not.toBe(first);
    expect(inspector.diagnostics.primary).toMatchObject({
      physicalReads: 5,
      parseMisses: 5,
      memoHits: 2
    });
  });
});

async function cacheFixture(rawJson: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runner-raw-inspector-"));
  writeShard(root, CACHE_KEY, rawJson);
  return root;
}

function writeShard(root: string, cacheKey: string, rawJson: string): void {
  const shardDir = join(root, cacheKey.slice(0, 2));
  mkdirSync(shardDir, { recursive: true });
  writeFileSync(join(shardDir, `${cacheKey}.json`), JSON.stringify({
    model: MODEL,
    request_profile: REQUEST_PROFILE,
    cache_key: cacheKey,
    raw_json: rawJson,
    extracted_at: "2026-08-11T00:00:00.000Z"
  }));
}
