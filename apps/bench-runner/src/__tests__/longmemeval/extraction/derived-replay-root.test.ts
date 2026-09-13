import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCurrentOrReplayDerived } from
  "../../../runs/extraction/cache/semantic-artifact/derived-replay.js";
import { SEMANTIC_ARTIFACT_KIND } from
  "../../../runs/extraction/cache/semantic-artifact/contract.js";
import { semanticTask } from "./semantic-artifact-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("derived replay root inspection", () => {
  it("returns invalid for a foreign ROOT_KIND instead of missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "derived-replay-"));
    roots.push(root);
    writeFileSync(join(root, "ROOT_KIND"), "foreign-root-kind\n", "utf8");
    const inspected = inspectCurrentOrReplayDerived(root, semanticTask());
    expect(inspected.status).toBe("invalid");
    expect(inspected.status).not.toBe("missing");
  });

  it("keeps minted artifacts on the semantic kind constant", () => {
    expect(SEMANTIC_ARTIFACT_KIND).toBe("assertion_semantic_artifact_v1");
  });
});
