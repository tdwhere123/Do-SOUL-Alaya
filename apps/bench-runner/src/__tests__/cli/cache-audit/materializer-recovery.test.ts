import {
  existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MATERIALIZATION_STAGE_NAME } from
  "../../../longmemeval/extraction/cache-audit/materialization/contract.js";
import {
  cleanupMaterializerFixtures,
  copySourceShardToTarget,
  createMaterializerFixture,
  materialize,
  sourceShardPath,
  targetShardPath,
  writeOpenMaterializationJournal
} from "./materializer-fixture.js";

afterEach(cleanupMaterializerFixtures);

describe("audited materialization recovery", () => {
  it("re-copies a truncated regular stage file under a valid open journal", () => {
    const fixture = createMaterializerFixture();
    writeOpenMaterializationJournal(fixture);
    const stageRoot = join(fixture.targetRoot, MATERIALIZATION_STAGE_NAME);
    mkdirSync(stageRoot);
    writeFileSync(join(stageRoot, `${fixture.hitKeys[0]!}.json`), "{\"partial\":", "utf8");

    const receipt = materialize(fixture);

    expect(receipt.materialized_key_count).toBe(3);
    for (const key of fixture.hitKeys) expect(existsSync(targetShardPath(fixture, key))).toBe(true);
    expect(existsSync(stageRoot)).toBe(false);
  });

  it("returns the committed receipt on retry before external receipt export", () => {
    const fixture = createMaterializerFixture();

    const committed = materialize(fixture);
    const retried = materialize(fixture);

    expect(retried).toEqual(committed);
  });

  it("rejects legacy partial materialization without a journal", () => {
    const fixture = createMaterializerFixture();
    copySourceShardToTarget(fixture, fixture.hitKeys[0]!);

    expect(() => materialize(fixture)).toThrow(/journal|partial|only.*marker/iu);
  });

  it.each(["symlink", "unknown"] as const)(
    "rejects a %s entry in an open materialization stage",
    (kind) => {
      const fixture = createMaterializerFixture();
      writeOpenMaterializationJournal(fixture);
      const stageRoot = join(fixture.targetRoot, MATERIALIZATION_STAGE_NAME);
      mkdirSync(stageRoot);
      const path = join(stageRoot, kind === "symlink"
        ? `${fixture.hitKeys[0]!}.json`
        : "unknown.json");
      if (kind === "symlink") symlinkSync(sourceShardPath(fixture, fixture.hitKeys[0]!), path);
      else writeFileSync(path, "{}\n", "utf8");

      expect(() => materialize(fixture)).toThrow(/stage.*unknown|unknown.*stage/iu);
      expect(findTemporaryEntries(fixture.targetRoot)).toEqual([]);
    }
  );

  it("ignores a publisher temporary outside the selected target root", () => {
    const fixture = createMaterializerFixture();
    writeFileSync(join(fixture.root, "interrupted-publisher.tmp"), "partial\n", "utf8");

    expect(materialize(fixture).materialized_key_count).toBe(3);
    expect(findTemporaryEntries(fixture.targetRoot)).toEqual([]);
  });
});

function findTemporaryEntries(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name.endsWith(".tmp")) found.push(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
    }
  };
  visit(root);
  return found;
}
