import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { measureGitState } from "../../../runs/provenance/contract/frozen-code-contract.js";
import {
  SPEC_PLANTED_DIRTY_V3_HEX,
  SPEC_STATE_FRAME_TAG,
  SPEC_STATE_FRAME_TAG_HEX,
  independentDirtyWorktreeHash,
  specGitIdentityBytes,
  specHashDirtyState,
  specLabeled,
  specTrackedDiffBytes
} from "./worktree-identity-independent-spec.js";
import {
  createFrozenCodeFixtureHarness,
  git,
  KNOWN_EMPTY_FILE_N_FRAME_HEX
} from "./frozen-code-contract-fixture.js";

const { identityRepository } = createFrozenCodeFixtureHarness();
const SPEC_PATH = new URL("./worktree-identity-independent-spec.ts", import.meta.url);
const PRODUCTION_PATH = new URL(
  "../../../runs/provenance/contract/worktree-git-bytes.ts",
  import.meta.url
);
const REQUIRED_IDENTITY_PINS = [
  "--full-index",
  "--unified=3",
  "--diff-algorithm=myers",
  "--abbrev=40",
  "--no-ext-diff",
  "--no-textconv",
  "--binary",
  "--no-color",
  "--no-renames",
  "core.quotepath=false",
  "core.abbrev=40",
  "core.excludesFile=",
  "core.attributesFile=",
  "diff.mnemonicPrefix=false",
  "diff.noprefix=false",
  "diff.indentHeuristic=false",
  "diff.renames=false",
  "diff.external=",
  "diff.textconv=",
  "diff.algorithm=myers",
  "diff.context=3",
  "status.showUntrackedFiles=normal",
  "status.renames=false",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_TERMINAL_PROMPT",
  "GIT_OPTIONAL_LOCKS",
  "encoding: \"buffer\"",
  "devNull"
] as const;

describe("independent v3 worktree identity spec", () => {
  it("keeps the spec recipe off the production pin module", async () => {
    const specSource = await readFile(SPEC_PATH, "utf8");
    const productionSource = await readFile(PRODUCTION_PATH, "utf8");
    expect(specSource).not.toMatch(/worktree-git-bytes/u);
    expect(specSource).not.toMatch(/from ["'].*gitIdentityBytes/u);
    expect(productionSource).not.toContain("GIT_TEXTCONVERSION");
    expect(productionSource).not.toMatch(/\.\.\.process\.env/u);
    expect(productionSource).toContain("encoding: \"buffer\"");
    const envBlock = productionSource.slice(productionSource.indexOf("function gitIdentityEnv"));
    expect(envBlock).not.toContain("GIT_DIFF_OPTS");
    expect(envBlock).not.toContain("GIT_EXTERNAL_DIFF");
    expect(envBlock).not.toContain("GIT_INDEX_FILE");
    for (const pin of REQUIRED_IDENTITY_PINS) {
      expect(specSource, pin).toContain(pin);
      expect(productionSource, pin).toContain(pin);
    }
    expect(collectNamedPinArray(specSource, "SPEC_GIT_CONFIG"))
      .toEqual(collectNamedPinArray(productionSource, "GIT_IDENTITY_CONFIG"));
    expect(collectNamedPinArray(specSource, "SPEC_DIFF_ARGV"))
      .toEqual(collectNamedPinArray(productionSource, "GIT_DIFF_ARGV"));
    for (const pin of REQUIRED_IDENTITY_PINS) {
      const planted = productionSource.replaceAll(pin, "REMOVED");
      expect(
        REQUIRED_IDENTITY_PINS.every((required) => planted.includes(required)),
        pin
      ).toBe(false);
    }
  });

  it("matches the hardcoded v3 tag and planted dirty frame digest", () => {
    expect(SPEC_STATE_FRAME_TAG.toString("hex")).toBe(SPEC_STATE_FRAME_TAG_HEX);
    expect(specHashDirtyState({
      head: Buffer.from("abc\n"),
      porcelain: Buffer.from("?? a\n"),
      trackedDiff: Buffer.alloc(0),
      untrackedFrame: Buffer.from(KNOWN_EMPTY_FILE_N_FRAME_HEX, "hex")
    })).toBe(SPEC_PLANTED_DIRTY_V3_HEX);
    expect(specLabeled("head", Buffer.from("abc\n")).length).toBeGreaterThan(4);
  });

  it("recomputes production dirty identity from independently pinned git bytes", async () => {
    const fixture = await identityRepository();
    await writeFile(join(fixture.root, "tracked.txt"), "one\n", "utf8");
    await git(fixture.root, "add", "tracked.txt");
    await git(fixture.root, "commit", "--quiet", "-m", "text");
    await writeFile(join(fixture.root, "tracked.txt"), "two\n", "utf8");
    const measured = await measureGitState(fixture.root, { allowDirty: true });
    expect(measured.worktreeStateAlgorithm).toBe("sha256-worktree-state-v3");
    expect(measured.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
    const trackedDiff = await specTrackedDiffBytes(fixture.root);
    expect(trackedDiff.toString("utf8")).toMatch(/index [a-f0-9]{40}\.\.[a-f0-9]{40}/u);
    expect(trackedDiff.toString("utf8")).not.toMatch(/^index [a-f0-9]{4}\.\.[a-f0-9]{4} /mu);
  });

  it("ignores hostile git config and env when hashing v3 identity", async () => {
    const fixture = await identityRepository();
    await writeFile(join(fixture.root, "tracked.txt"), "one\n", "utf8");
    await writeFile(join(fixture.root, ".gitattributes"), "* diff=hostile\n", "utf8");
    await git(fixture.root, "add", "tracked.txt", ".gitattributes");
    await git(fixture.root, "commit", "--quiet", "-m", "text");
    await writeFile(join(fixture.root, "tracked.txt"), "two\n", "utf8");
    await writeFile(join(fixture.root, "kept.ts"), "export const kept = 1;\n", "utf8");
    const baseline = await measureGitState(fixture.root, { allowDirty: true });

    const hostileHome = await mkdtemp(join(tmpdir(), "alaya-git-hostile-"));
    const globalConfig = join(hostileHome, "gitconfig");
    const globalExclude = join(hostileHome, "ignore");
    const globalAttr = join(hostileHome, "attributes");
    const extDiff = join(hostileHome, "ext-diff.sh");
    const textconv = join(hostileHome, "textconv.sh");
    const altIndex = join(hostileHome, "alt-index");
    await writeFile(globalExclude, "*.ts\n", "utf8");
    await writeFile(globalAttr, "* diff=hostile\n", "utf8");
    await writeFile(extDiff, "#!/bin/sh\nprintf 'MUTATED-EXTERNAL-DIFF\\n'\n", "utf8");
    await writeFile(textconv, "#!/bin/sh\nprintf 'MUTATED-TEXTCONV\\n'\n", "utf8");
    await chmod(extDiff, 0o755);
    await chmod(textconv, 0o755);
    await writeFile(globalConfig, [
      "[core]",
      `  excludesFile = ${globalExclude}`,
      `  attributesFile = ${globalAttr}`,
      `  abbrev = 4`,
      "[diff]",
      "  context = 7",
      "  algorithm = patience",
      `  external = ${extDiff}`,
      "  textconv = true",
      "[diff \"hostile\"]",
      `  textconv = ${textconv}`
    ].join("\n") + "\n", "utf8");
    await git(fixture.root, "config", "core.abbrev", "4");
    await git(fixture.root, "config", "diff.context", "7");
    await git(fixture.root, "config", "diff.algorithm", "patience");
    await git(fixture.root, "config", "diff.external", extDiff);
    await git(fixture.root, "config", "diff.hostile.textconv", textconv);
    await writeFile(altIndex, "", "utf8");

    const previous = {
      GIT_DIFF_OPTS: process.env.GIT_DIFF_OPTS,
      GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      HOME: process.env.HOME
    };
    process.env.GIT_DIFF_OPTS = "-U7";
    process.env.GIT_EXTERNAL_DIFF = extDiff;
    process.env.GIT_INDEX_FILE = altIndex;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_SYSTEM = globalConfig;
    process.env.HOME = hostileHome;
    try {
      const hostile = await measureGitState(fixture.root, { allowDirty: true });
      expect(hostile.worktreeStateSha256).toBe(baseline.worktreeStateSha256);
      expect(hostile.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
      const trackedDiff = await specTrackedDiffBytes(fixture.root);
      expect(trackedDiff.toString("utf8")).toMatch(/index [a-f0-9]{40}\.\.[a-f0-9]{40}/u);
    } finally {
      restoreEnv(previous);
      await rm(hostileHome, { recursive: true, force: true });
    }
  });

  it("changes the v3 digest when tracked binary bytes change", async () => {
    const fixture = await identityRepository();
    const binary = join(fixture.root, "blob.bin");
    await writeFile(binary, Buffer.from([0, 1, 2, 3, 0, 255]));
    await git(fixture.root, "add", "blob.bin");
    await git(fixture.root, "commit", "--quiet", "-m", "binary");
    await writeFile(binary, Buffer.from([0, 1, 2, 4, 0, 255]));
    const first = await measureGitState(fixture.root, { allowDirty: true });
    expect(first.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
    await writeFile(binary, Buffer.from([0, 1, 2, 5, 0, 255]));
    const second = await measureGitState(fixture.root, { allowDirty: true });
    expect(second.worktreeStateSha256).not.toBe(first.worktreeStateSha256);
    expect(second.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
    expect((await specGitIdentityBytes(fixture.root, ["rev-parse", "HEAD"])).length).toBeGreaterThan(0);
  });
});

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function collectNamedPinArray(source: string, name: string): readonly string[] {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`, "u"));
  if (match === null) throw new Error(`missing pin array ${name}`);
  const pins: string[] = [];
  for (const item of match[1]!.matchAll(/"(--[^"]+|[^"]+)"|`([^`]+)`/gu)) {
    pins.push((item[1] ?? item[2]!).replace(/\$\{[^}]+\}/gu, ""));
  }
  return pins;
}
