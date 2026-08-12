import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupMaterializerFixtures,
  createMaterializerFixture,
  materialize
} from "./materializer-fixture.js";

afterEach(cleanupMaterializerFixtures);

describe("audited materialization authority", () => {
  it.each([
    { label: "count", options: { selectionExpectedTurns: 4 } },
    { label: "key digest", options: { selectionKeyDigest: "9".repeat(64) } }
  ])("rejects an audit inventory that is not the selection's complete $label", ({ options }) => {
    const fixture = createMaterializerFixture(options);

    expect(() => materialize(fixture)).toThrow(/selection.*(?:key|turn|inventory)|inventory.*selection/iu);
  });

  it.each(["missing", "mutated", "symlink"] as const)(
    "fails closed when the live source manifest is %s",
    (change) => {
      const fixture = createMaterializerFixture();
      if (change === "missing") rmSync(fixture.sourceManifestPath);
      if (change === "mutated") writeFileSync(fixture.sourceManifestPath, "{}\n", "utf8");
      if (change === "symlink") {
        rmSync(fixture.sourceManifestPath);
        symlinkSync(joinExternalManifest(fixture.root), fixture.sourceManifestPath);
      }

      expect(() => materialize(fixture)).toThrow(
        /source.*manifest|manifest.*(?:missing|changed|symlink)|symlink.*manifest/iu
      );
    }
  );
});

function joinExternalManifest(root: string): string {
  const path = join(root, "external-manifest.json");
  writeFileSync(path, "{}\n", "utf8");
  return path;
}
