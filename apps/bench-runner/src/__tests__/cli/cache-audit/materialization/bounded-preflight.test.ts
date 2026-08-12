import { truncateSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import {
  cleanupMaterializerFixtures,
  createMaterializerFixture,
  materialize,
  sourceShardPath
} from "../materializer-fixture.js";

afterEach(cleanupMaterializerFixtures);

it("bounds an oversized sparse audited hit before legacy inventory parsing", () => {
  const fixture = createMaterializerFixture({ hitCount: 1, totalCount: 2 });
  truncateSync(sourceShardPath(fixture, fixture.hitKeys[0]!), 8 * 1024 * 1024);

  expect(() => materialize(fixture, { maxShardBytes: 1024 }))
    .toThrow(/cache shard exceeds.*size limit/iu);
});
