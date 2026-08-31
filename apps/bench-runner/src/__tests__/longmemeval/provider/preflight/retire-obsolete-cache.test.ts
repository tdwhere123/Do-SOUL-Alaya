import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retireObsoleteCache } from "../../../../runs/provider/retire-obsolete-cache.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("obsolete cache retirement preflight", () => {
  it("fails closed without confirm, path match, or an active lock", async () => {
    const root = await tempRoot();
    expect(() => retireObsoleteCache({
      cacheRoot: root,
      expectedPath: root,
      profile: "deepseek-v4-nonthinking-v1",
      confirm: false
    })).toThrow(/confirm/u);

    expect(() => retireObsoleteCache({
      cacheRoot: root,
      expectedPath: join(root, "other"),
      profile: "deepseek-v4-nonthinking-v1",
      confirm: true
    })).toThrow(/does not match/u);

    mkdirSync(join(root, ".extraction-fill.lock"));
    expect(() => retireObsoleteCache({
      cacheRoot: root,
      expectedPath: root,
      profile: "deepseek-v4-nonthinking-v1",
      confirm: true
    })).toThrow(/in-progress/u);
  });

  it("does not delete after a clean preflight", async () => {
    const root = await tempRoot();
    writeFileSync(join(root, "keep.txt"), "stay");
    const result = retireObsoleteCache({
      cacheRoot: root,
      expectedPath: root,
      profile: "deepseek-v4-nonthinking-v1",
      confirm: true
    });
    expect(result.retired).toBe(false);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "provider-preflight-"));
  roots.push(root);
  return root;
}
