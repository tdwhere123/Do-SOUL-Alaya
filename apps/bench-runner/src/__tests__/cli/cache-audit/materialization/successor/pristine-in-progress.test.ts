import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../../../cli/cli.js";
import { cacheFilePath } from
  "../../../../../longmemeval/compile-seed/compile-seed-cache.js";
import {
  createPristineCatalogRefillSuccessorFixture,
  commandArgs, type CatalogRefillSuccessorFixture
} from "../catalog-refill-successor-fixture.js";

let fixture: CatalogRefillSuccessorFixture | undefined;

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("materialized successor pristine in-progress adoption", () => {
  it("reuses the public materialization receipt entry without provider access", async () => {
    fixture = await createPristineCatalogRefillSuccessorFixture();
    const fetch = vi.spyOn(globalThis, "fetch");
    const stderr: string[] = [];
    vi.mocked(process.stderr.write).mockImplementation((text) => {
      stderr.push(String(text));
      return true;
    });

    expect(await runCli(commandArgs(fixture)), stderr.join("\n")).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  }, 15_000);

  it.each([
    ["nonzero attempt", addAttempt],
    ["extra shard", addExtraShard],
    ["unknown control", addUnknownControl]
  ] as const)("rejects %s", async (_label, mutate) => {
    fixture = await createPristineCatalogRefillSuccessorFixture();
    mutate(fixture);
    rmSync(fixture.receiptPath);

    expect(await runCli(commandArgs(fixture))).toBe(2);
  }, 15_000);
});

function addAttempt(value: CatalogRefillSuccessorFixture): void {
  const path = join(value.targetRoot,
    `extraction-attempt-ledger.${value.authorityReceipt.lineage_digest}.json`);
  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  record.attempts = 1;
  writeFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function addExtraShard(value: CatalogRefillSuccessorFixture): void {
  const key = "f".repeat(64);
  const path = cacheFilePath(value.targetRoot, key);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    model: "gpt-5.4-mini", request_profile: "provider-default-v1",
    cache_key: key, raw_json: "{\"signals\":[]}"
  }), "utf8");
}

function addUnknownControl(value: CatalogRefillSuccessorFixture): void {
  writeFileSync(join(value.targetRoot, ".unknown-control.json"), "{}\n", "utf8");
}
