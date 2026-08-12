import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireExtractionCacheWriteLease } from
  "../../../longmemeval/extraction/fill/manifest/fill-root-guard.js";
import {
  cleanupMaterializerFixtures,
  createMaterializerFixture,
  materialize
} from "./materializer-fixture.js";

afterEach(cleanupMaterializerFixtures);

describe("audited materialization filesystem guards", () => {
  it.each(["lease", "prefix-symlink", "extra-entry"] as const)(
    "rejects a target containing a concurrent %s",
    (conflict) => {
      const fixture = createMaterializerFixture();
      if (conflict === "lease") mkdirSync(join(fixture.targetRoot, ".extraction-fill.lock"));
      if (conflict === "prefix-symlink") {
        const outside = join(fixture.root, "outside-prefix");
        mkdirSync(outside);
        symlinkSync(outside, join(fixture.targetRoot, fixture.hitKeys[0]!.slice(0, 2)));
      }
      if (conflict === "extra-entry") {
        writeFileSync(join(fixture.targetRoot, "operator-owned.txt"), "keep\n", "utf8");
      }

      expect(() => materialize(fixture)).toThrow(/target.*(?:lease|symlink|entry|marker|clean)/iu);
    }
  );

  it.each([
    { label: "default", paddingBytes: 129 * 1024, maxShardBytes: undefined },
    { label: "explicit", paddingBytes: 1025, maxShardBytes: 1024 }
  ])("rejects an audited shard larger than the $label limit", ({ paddingBytes, maxShardBytes }) => {
    const fixture = createMaterializerFixture({
      hitCount: 1,
      totalCount: 1,
      rawJsonPaddingBytes: paddingBytes
    });

    expect(() => materialize(fixture, {
      ...(maxShardBytes === undefined ? {} : { maxShardBytes })
    })).toThrow(/shard.*(?:size|large|limit)|(?:size|limit).*shard/iu);
  });

  it("rejects an override above the persisted 128 KiB ceiling", () => {
    const fixture = createMaterializerFixture();

    expect(() => materialize(fixture, { maxShardBytes: 128 * 1024 + 1 }))
      .toThrow(/maxShardBytes.*128 KiB/iu);
  });

  it("rejects non-canonical UTF-8 in an otherwise parseable source shard", () => {
    const fixture = createMaterializerFixture({ hitCount: 1, totalCount: 1 });
    const path = join(
      fixture.sourceRoot, fixture.hitKeys[0]!.slice(0, 2), `${fixture.hitKeys[0]!}.json`
    );
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const bytes = Buffer.from(JSON.stringify({ ...parsed, ignored: "XX" }), "utf8");
    const offset = bytes.indexOf("XX");
    bytes[offset] = 0xc3;
    bytes[offset + 1] = 0x28;
    writeFileSync(path, bytes);

    expect(() => materialize(fixture)).toThrow(/UTF-8|inventory changed/iu);
  });

  it("rejects materialization while the audited source lease is held", () => {
    const fixture = createMaterializerFixture();
    const sourceLease = acquireExtractionCacheWriteLease(fixture.sourceRoot);
    try {
      expect(() => materialize(fixture)).toThrow(/lease.*failed|writer lock/iu);
    } finally {
      sourceLease.release();
    }
  });
});
