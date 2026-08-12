import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupMaterializerFixtures,
  createMaterializerFixture,
  materialize,
  targetShardPath
} from "./materializer-fixture.js";

afterEach(cleanupMaterializerFixtures);

describe("committed materialization integrity", () => {
  it("rejects a same-path target shard mutation instead of replaying its receipt", () => {
    const fixture = createMaterializerFixture();
    materialize(fixture);
    writeFileSync(targetShardPath(fixture, fixture.hitKeys[0]!), "tampered\n", "utf8");

    expect(() => materialize(fixture)).toThrow(/committed|materialized.*shard|shard.*(?:changed|differs)/iu);
  });

  it("rejects a committed target manifest mutation", () => {
    const fixture = createMaterializerFixture();
    materialize(fixture);
    writeFileSync(join(fixture.targetRoot, "manifest.json"), "{}\n", "utf8");

    expect(() => materialize(fixture)).toThrow(/manifest/iu);
  });
});
