import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("resolves the built source-read entry to the existing owners and preserves package imports", () => {
  // Use Node package resolution: Vitest aliases cannot prove the built export map.
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import * as sourceRead from "@do-soul/alaya-soul/source-read";
    import * as root from "@do-soul/alaya-soul";
    import { indexSourceSemanticUnits } from
      "@do-soul/alaya-soul/dist/garden/ingestion/official-api/source-semantic-units.js";
    import { verifyOfficialApiSourceLocatorBinding } from
      "@do-soul/alaya-soul/dist/garden/triage/grounding/source-locator/verified-binding.js";
    import manifest from "@do-soul/alaya-soul/package.json" with { type: "json" };
    assert.deepEqual(Object.keys(sourceRead).sort(), [
      "indexSourceSemanticUnits", "verifyOfficialApiSourceLocatorBinding"
    ]);
    assert.equal(sourceRead.indexSourceSemanticUnits, indexSourceSemanticUnits);
    assert.equal(sourceRead.verifyOfficialApiSourceLocatorBinding, verifyOfficialApiSourceLocatorBinding);
    assert.equal(root.indexSourceSemanticUnits, indexSourceSemanticUnits);
    assert.equal(root.verifyOfficialApiSourceLocatorBinding, verifyOfficialApiSourceLocatorBinding);
    assert.equal(manifest.name, "@do-soul/alaya-soul");
  `], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8" });
  expect(output).toBe("");
});
