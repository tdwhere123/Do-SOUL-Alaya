import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execFileWithFileCapture } from "./script-capture.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const scriptPath = path.join(repoRoot, "scripts/ci/check-repository-structure.mjs");
const fixtureRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
  fixtureRoots.clear();
});

describe("repository structure guard", () => {
  it("keeps 499 below review, advises at 500 and 799, and permits classified 800", async () => {
    const root = await createFixtureRoot();
    await writeSource(root, "packages/base/src/size-499.ts", sourceWithLines(499));
    await writeSource(
      root,
      "packages/base/src/size-499-terminal-newline.ts",
      `${sourceWithLines(499)}\n`
    );
    await writeSource(root, "packages/base/src/size-500.ts", sourceWithLines(500));
    await writeSource(root, "packages/base/src/size-799.ts", sourceWithLines(799));
    await writeSource(root, "packages/base/src/declarative.ts", sourceWithLines(800));
    await writeSource(root, "packages/base/src/generated.ts", sourceWithLines(800));
    await writeSource(root, "packages/base/src/test-support.ts", sourceWithLines(800));
    await writeSource(root, "packages/base/src/comment-only.ts", "// docs/bench-history is not a runtime path");
    await writeSource(root, "packages/base/src/function-80.ts", functionWithLines("reviewMe", 80));
    await writeSource(root, "packages/base/src/function-120.ts", functionWithLines("splitReviewMe", 120));
    for (let index = 0; index < 7; index += 1) {
      await writeSource(root, `packages/base/src/member-${index}.ts`, "export const value = 1;");
    }
    const policyPath = await writePolicy(root, policy({
      file_size: {
        review_at: 500,
        fail_at: 800,
        classifications: {
          "packages/base/src/declarative.ts": {
            kind: "declarative",
            reason: "planted declarative-table fixture"
          },
          "packages/base/src/generated.ts": {
            kind: "generated",
            reason: "planted generated-source fixture"
          },
          "packages/base/src/test-support.ts": {
            kind: "test_support",
            reason: "planted test-support fixture"
          }
        }
      }
    }));

    const result = await runGuard(root, policyPath);

    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("size-499.ts");
    expect(result.stdout).not.toContain("size-499-terminal-newline.ts");
    expect(result.stdout).toContain("path=packages/base/src/size-500.ts");
    expect(result.stdout).toContain("path=packages/base/src/size-799.ts");
    expect(result.stdout).toContain("path=packages/base/src/declarative.ts");
    expect(result.stdout).toContain("path=packages/base/src/generated.ts");
    expect(result.stdout).toContain("path=packages/base/src/test-support.ts");
    expect(result.stdout).toContain("directory-sibling-navigation-review");
    expect(result.stdout).toContain("function-size-cohesion-review");
    expect(result.stdout).toContain("function-size-split-review");
    expect(result.stdout).toContain("errors=0");
  });

  it("fails a handwritten 800-line source with an actionable diagnostic", async () => {
    const root = await createFixtureRoot();
    await writeSource(root, "packages/base/src/too-large.ts", sourceWithLines(800));
    const policyPath = await writePolicy(root, policy());

    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("source-file-size-hard-limit")
    });
    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      stderr: expect.stringContaining("next=Split at a domain")
    });
  });

  it("rejects a planted workspace dependency inversion", async () => {
    const root = await createFixtureRoot();
    await writeSource(root, "packages/upper/src/index.ts", "export const upper = 1;");
    await writeSource(
      root,
      "packages/base/src/inversion.ts",
      'import { upper } from "../../upper/src/index.js";\nexport const value = upper;'
    );
    const policyPath = await writePolicy(root, policy({
      workspaces: [
        { root: "packages/base", package: "@fixture/base", allowed_workspace_packages: [] },
        { root: "packages/upper", package: "@fixture/upper", allowed_workspace_packages: ["@fixture/base"] }
      ]
    }));

    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("workspace-dependency-direction")
    });
  });

  it("rejects new generic ownership, runtime evidence, and retired imports", async () => {
    const root = await createFixtureRoot();
    await writeSource(root, "packages/base/src/utils/new-rule.ts", "export const value = 1;");
    await writeSource(root, "packages/base/src/card-13/new-rule.ts", "export const value = 1;");
    await writeSource(root, "packages/base/src/experiments/new-rule.ts", "export const value = 1;");
    await writeSource(root, "packages/base/src/retired/path.ts", "export const value = 1;");
    await writeSource(root, "packages/base/src/index.ts", "");
    await writeSource(
      root,
      "packages/base/src/__tests__/retired-path.test.ts",
      'import "@fixture/base/retired/path";'
    );
    await writeSource(
      root,
      "packages/base/src/runtime-evidence.ts",
      'export const cacheRoot = "docs/bench-" + "history/private-cache";'
    );
    await writeSource(
      root,
      "apps/inspector/src/runtime/scratch-evidence.ts",
      'export const cacheRoot = ".do-it/bench-runs/inspector";'
    );
    await writeSource(
      root,
      "packages/base/src/consumer.ts",
      "export const value = 1;"
    );
    const policyPath = await writePolicy(root, policy({
      runtime_artifact_roots: ["packages/base/src", "apps/inspector/src"],
      retired_import_paths: ["packages/base/src/retired/path"],
      file_size: {
        review_at: 500,
        fail_at: 800,
        classifications: {
          "packages/base/src/utils/new-rule.ts": {
            kind: "declarative",
            reason: "classified files still obey ownership rules"
          }
        }
      },
      existing_ownership_directory_exceptions: {
        "packages/base/src/utils": ["packages/base/src/utils/removed.ts"]
      },
      entry_exports: [{
        specifier: "@fixture/base",
        path: "packages/base/src/index.ts",
        expected_count: 0,
        expected_sha256: "01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b"
      }]
    }));

    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(
        /forbidden-generic-ownership-directory[\s\S]+production-artifact-reference[\s\S]+retired-import-path/u
      )
    });
    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      stderr: expect.stringContaining("forbidden-rollout-ownership-directory")
    });
    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      stderr: expect.stringContaining("path=apps/inspector/src/runtime/scratch-evidence.ts")
    });
    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /retired-import-path[\s\S]+retired-source-path-restored[\s\S]+stale-generic-ownership-exception/u
      )
    });
    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      stderr: expect.stringContaining("path=packages/base/src/__tests__/retired-path.test.ts")
    });
  });

  it("does not treat ordinary band and wave words as rollout ownership", async () => {
    const root = await createFixtureRoot();
    await writeSource(root, "packages/base/src/bandwidth/value.ts", "export const value = 1;");
    await writeSource(root, "packages/base/src/bandit/value.ts", "export const value = 1;");
    await writeSource(root, "packages/base/src/waveform/value.ts", "export const value = 1;");
    const policyPath = await writePolicy(root, policy());

    const result = await runGuard(root, policyPath);

    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("forbidden-rollout-ownership-directory");
    expect(result.stdout).toContain("errors=0");
  });

  it("rejects numbered and delimited band and wave rollout ownership", async () => {
    const root = await createFixtureRoot();
    const rolloutDirectories = [
      "band",
      "band1",
      "band-1",
      "band_alpha",
      "wave",
      "wave2",
      "wave-2",
      "wave_beta"
    ];
    for (const directory of rolloutDirectories) {
      await writeSource(
        root,
        `packages/base/src/${directory}/value.ts`,
        "export const value = 1;"
      );
    }
    const policyPath = await writePolicy(root, policy());
    let failure: (Error & { code: number; stderr: string }) | undefined;

    try {
      await runGuard(root, policyPath);
    } catch (error) {
      failure = error as Error & { code: number; stderr: string };
    }

    expect(failure).toMatchObject({ code: 1 });
    for (const directory of rolloutDirectories) {
      expect(failure?.stderr).toContain(`path=packages/base/src/${directory}`);
    }
  });

  it("rejects package-root type/value export drift", async () => {
    const root = await createFixtureRoot();
    await writeSource(root, "packages/base/src/index.ts", "export type current = string;");
    const policyPath = await writePolicy(root, policy({
      entry_exports: [{
        specifier: "@fixture/base",
        path: "packages/base/src/index.ts",
        expected_count: 1,
        expected_sha256: digestLines(["value:current"])
      }]
    }));

    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("workspace-entry-export-drift")
    });
  });

  it("rejects new index-to-index chains and barrel cycles", async () => {
    const root = await createFixtureRoot();
    await writeSource(root, "packages/base/src/index.ts", 'export * from "./domain/index.js";');
    await writeSource(
      root,
      "packages/base/src/domain/index.ts",
      'export * from "../index.js";\nexport * from "./owner-a.js";\nexport * from "./owner-b.js";'
    );
    await writeSource(root, "packages/base/src/domain/owner-a.ts", "export const duplicate = 1;");
    await writeSource(root, "packages/base/src/domain/owner-b.ts", "export const duplicate = 2;");
    const policyPath = await writePolicy(root, policy({
      existing_index_to_index_edges: [
        "packages/base/src/removed/index.ts -> packages/base/src/also-removed/index.ts"
      ]
    }));

    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/barrel-cycle[\s\S]+new-private-barrel-chain/u)
    });
    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      stderr: expect.stringMatching(/private-barrel-snapshot-drift[\s\S]+stale-private-barrel-edge-exception/u)
    });
    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      stderr: expect.stringContaining("duplicate-export-authority")
    });
  });

  it("rejects stale artifact exceptions", async () => {
    const root = await createFixtureRoot();
    await writeSource(root, "packages/base/src/clean.ts", "export const value = 1;");
    const policyPath = await writePolicy(root, policy({
      existing_artifact_reference_exceptions: {
        "packages/base/src/clean.ts": {
          max_occurrences_by_fragment: {
            ".do-it/bench-runs": 0,
            "docs/bench-history": 1
          },
          reason: "planted stale exception"
        }
      }
    }));

    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("stale-production-artifact-exception")
    });
  });

  it("tracks default and unresolved star exports", async () => {
    const root = await createFixtureRoot();
    await writeSource(
      root,
      "packages/base/src/index.ts",
      'export default class Current {}\nexport * from "external-package";'
    );
    const policyPath = await writePolicy(root, policy());

    await expect(runGuard(root, policyPath)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("workspace-entry-export-drift")
    });
  });

  it("treats an explicit export as authority regardless of statement order", async () => {
    const orders = [
      'export * from "./owner-a.js";\nexport { foo } from "./owner-b.js";',
      'export { foo } from "./owner-b.js";\nexport * from "./owner-a.js";'
    ];
    for (const source of orders) {
      const root = await createFixtureRoot();
      await writeSource(root, "packages/base/src/index.ts", source);
      await writeSource(root, "packages/base/src/owner-a.ts", "export const foo = 1;");
      await writeSource(root, "packages/base/src/owner-b.ts", "export const foo = 2;");
      const policyPath = await writePolicy(root, policy({
        entry_exports: [{
          specifier: "@fixture/base",
          path: "packages/base/src/index.ts",
          expected_count: 1,
          expected_sha256: digestLines(["value:foo"])
        }]
      }));

      await expect(runGuard(root, policyPath)).resolves.toMatchObject({
        stdout: expect.stringContaining("errors=0")
      });
    }
  });

  it("inherits binding kind through import-then-local-export", async () => {
    const typeRoot = await createFixtureRoot();
    await writeSource(typeRoot, "packages/base/src/owner.ts", "export interface Foo {}");
    await writeSource(
      typeRoot,
      "packages/base/src/index.ts",
      'import { Foo } from "./owner.js";\nexport { Foo };'
    );
    const expectedTypePolicy = policy({
      entry_exports: [{
        specifier: "@fixture/base",
        path: "packages/base/src/index.ts",
        expected_count: 1,
        expected_sha256: digestLines(["type:Foo"])
      }]
    });
    await expect(runGuard(typeRoot, await writePolicy(typeRoot, expectedTypePolicy))).resolves.toMatchObject({
      stdout: expect.stringContaining("errors=0")
    });

    const valueRoot = await createFixtureRoot();
    await writeSource(valueRoot, "packages/base/src/owner.ts", "export const Foo = 1;");
    await writeSource(
      valueRoot,
      "packages/base/src/index.ts",
      'import { Foo } from "./owner.js";\nexport { Foo };'
    );
    await expect(runGuard(valueRoot, await writePolicy(valueRoot, expectedTypePolicy))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("workspace-entry-export-drift")
    });
  });

  it("fails closed on invalid thresholds and missing entry paths", async () => {
    const root = await createFixtureRoot();
    const thresholdPolicy = await writePolicy(root, policy({
      function_size: { review_at: 120, split_review_at: 80 }
    }));
    await expect(runGuard(root, thresholdPolicy)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("function review_at")
    });

    const missingEntryPolicy = await writePolicy(root, policy({
      entry_exports: [{
        specifier: "@fixture/base",
        path: "packages/base/src/missing.ts",
        expected_count: 0,
        expected_sha256: digestLines([])
      }]
    }));
    await expect(runGuard(root, missingEntryPolicy)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("entry export path is not in the guarded source set")
    });
  });
});

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "alaya-repository-structure-"));
  fixtureRoots.add(root);
  await writeSource(root, "packages/base/src/index.ts", "");
  return root;
}

async function writeSource(root: string, relativePath: string, source: string): Promise<void> {
  const filename = path.join(root, relativePath);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, source, "utf8");
}

async function writePolicy(root: string, value: object): Promise<string> {
  const filename = path.join(root, "policy.json");
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filename;
}

async function runGuard(root: string, policyPath: string) {
  return await execFileWithFileCapture(
    process.execPath,
    [scriptPath, "--root", root, "--policy", policyPath],
    { env: cliScriptEnv() }
  );
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    file_size: { review_at: 500, fail_at: 800, classifications: {} },
    function_size: { review_at: 80, split_review_at: 120 },
    directory_size: { advisory_at: 10 },
    forbidden_ownership_directories: ["utils", "helpers", "misc", "common"],
    existing_ownership_directory_exceptions: {},
    forbidden_rollout_directory_patterns: [
      "^card(?:[-_]?[0-9].*)?$",
      "^band(?:[0-9]+|[-_][a-z0-9].*)?$",
      "^wave(?:[0-9]+|[-_][a-z0-9].*)?$",
      "^experiment(?:s|[-_][a-z0-9].*)?$"
    ],
    workspaces: [
      { root: "packages/base", package: "@fixture/base", allowed_workspace_packages: [] }
    ],
    runtime_artifact_roots: ["packages/base/src"],
    artifact_reference_fragments: [".do-it/bench-runs", "docs/bench-history"],
    existing_artifact_reference_exceptions: {},
    retired_import_paths: ["packages/base/src/retired-never"],
    entry_exports: [{
      specifier: "@fixture/base",
      path: "packages/base/src/index.ts",
      expected_count: 0,
      expected_sha256: digestLines([])
    }],
    private_barrel_snapshot: {
      expected_count: 0,
      expected_sha256: digestLines([])
    },
    existing_duplicate_export_authorities: [],
    existing_index_to_index_edges: [],
    ...overrides
  };
}

function digestLines(lines: readonly string[]): string {
  return createHash("sha256").update(`${lines.join("\n")}\n`, "utf8").digest("hex");
}

function sourceWithLines(lines: number): string {
  return ["export const value = 1;", ...Array.from({ length: lines - 1 }, () => "// fixture")]
    .join("\n");
}

function functionWithLines(name: string, lines: number): string {
  return [
    `export function ${name}() {`,
    ...Array.from({ length: lines - 2 }, () => "  // fixture"),
    "}"
  ].join("\n");
}

function cliScriptEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key.startsWith("VITEST")) delete env[key];
  }
  delete env.NODE_OPTIONS;
  return env;
}
