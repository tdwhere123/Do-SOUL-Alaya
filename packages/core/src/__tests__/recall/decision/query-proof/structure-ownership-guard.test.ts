import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PRODUCTION_RECALL = join(SRC_ROOT, "recall");
const INDEX_TS = join(SRC_ROOT, "index.ts");
const REPO_ROOT = resolve(SRC_ROOT, "../../..");
const REPOSITORY_CODE_ROOTS = ["apps", "packages", "scripts"]
  .map((path) => join(REPO_ROOT, path))
  .filter(existsSync);

const PLANTED_OLD_IMPORT = "../../recall/shadow/walk.js";
const PLANTED_RETIRED_PREFIX_IMPORTS = [
  "../../recall/decision/prefix-capture/envelope.js",
  "../../recall/decision/prefix-capture/compare.js",
  "../prefix-capture/envelope.js",
  "../prefix-capture/compare.js"
] as const;
const PLANTED_SIDE_EFFECT_IMPORT = [
  "import ",
  JSON.stringify(PLANTED_RETIRED_PREFIX_IMPORTS[1]),
  ";"
].join("");
const PLANTED_D1_DIR = "packages/core/src/recall/decision/d1/";
const PLANTED_CARD_DIR = "packages/core/src/recall/card-13r-foo/";
const PLANTED_BAND_DIR = "packages/core/src/recall/decision/band-1/";
const PLANTED_PSI_V2_DIR = "packages/core/src/recall/decision/psi-v2/";
const PLANTED_INTEGRATION_IMPORT = "../../recall/integration/shadow/integrate.js";
const PLANTED_LEXICAL_BOUND_IMPORT = "lexical-bound/index.js";
const PLANTED_SYMBOL = "d1PsiOutcome";

const SKIP_GENERATED_DIRECTORY_NAMES = new Set(["node_modules", "dist"]);
const SKIP_PRODUCTION_DIRECTORY_NAMES = new Set([
  ...SKIP_GENERATED_DIRECTORY_NAMES,
  "__tests__"
]);
const IMPORT_SPEC = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/gu;
const EXPORT_BLOCK = /export(?:\s+type)?\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gu;

const FROZEN_MOVED_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  "./recall/decision/prefix-capture/walk.js": [
    "deterministicTailDecidedThisPick",
    "DeterministicTailPickEvidence"
  ],
  "./recall/runtime/diagnostics/tail-degeneracy.js": [
    "FIRST_PICK_TAIL_DEGENERACY_PROPERTY",
    "FIRST_PICK_TAIL_DECIDED_SHARE_MAX",
    "evaluateFirstPickTailDegeneracy",
    "evaluateFirstPickTailDegeneracyStream",
    "FirstPickTailDegeneracyReport"
  ],
  "./recall/runtime/diagnostics/cheap-rung.js": [
    "CHEAP_RANKING_RUNG_COST",
    "CHEAP_RANKING_RUNG_ID",
    "CHEAP_RANKING_RUNG_K",
    "cheapRungAnyAt5",
    "scoreCheapRankingRung",
    "CheapRankingRungReport",
    "CheapRankingRungRow"
  ],
  "./recall/decision/query-proof/adapters/lexical-bound/index.js": [
    "applicableChannelsOf",
    "compareD1FrozenCandidatePairs",
    "D1_NONBINDING_TOKEN_BUDGET",
    "d1HasLegalEnvelope",
    "d1IdentitiesEqual",
    "d1IntervalVote",
    "d1LaneEnvelopes",
    "d1LexicalChannelVote",
    "d1PsiOutcome",
    "d1PsiPredicate",
    "d1PsiQ",
    "replayD1CaptureWalk",
    "replayD1FrozenCapture",
    "D1CandidateEnvelopeMap",
    "D1EnvelopeIdentity",
    "D1EnvelopeValue",
    "D1FrozenCaptureInput",
    "D1FrozenCandidatePair",
    "D1FrozenCandidatePairBlocking",
    "D1FrozenCandidatePairInput",
    "D1IntervalEnvelope",
    "D1LaneEnvelope",
    "D1MissingnessCoverage",
    "D1PrimaryObservation",
    "D1ReplayInput",
    "D1ReplayMetrics",
    "D1ReplayResult"
  ]
};

const STALE_FROM_PATHS = [
  "./recall/shadow/walk.js",
  "./recall/shadow/ranking/tail-degeneracy.js",
  "./recall/shadow/ranking/cheap-rung.js",
  "./recall/shadow/d1/index.js"
] as const;

describe("recall structure ownership", () => {
  it("rejects planted retired semantic import", () => {
    const imports = [PLANTED_OLD_IMPORT, ...PLANTED_RETIRED_PREFIX_IMPORTS];
    expect(detectStructureOwnershipViolations({
      importSpecifiers: imports
    })).toEqual(imports.map((value) => ({ kind: "import", value })));
  });

  it("detects a planted side-effect import", () => {
    expect(importSpecifiersFromSource(PLANTED_SIDE_EFFECT_IMPORT)).toEqual([
      "../../recall/decision/prefix-capture/compare.js"
    ]);
  });

  it("rejects planted forbidden directories", () => {
    const directories = [
      PLANTED_D1_DIR,
      PLANTED_CARD_DIR,
      PLANTED_BAND_DIR,
      PLANTED_PSI_V2_DIR
    ];
    expect(detectStructureOwnershipViolations({
      directories
    })).toEqual(directories.map((value) => ({ kind: "directory", value })));
  });

  it("accepts integration shadow, lexical-bound, and D1 symbols", () => {
    expect(detectStructureOwnershipViolations({
      importSpecifiers: [
        PLANTED_INTEGRATION_IMPORT,
        PLANTED_LEXICAL_BOUND_IMPORT,
        "../../recall/decision/query-proof/adapters/lexical-bound/index.js"
      ],
      symbols: [PLANTED_SYMBOL]
    })).toEqual([]);
  });

  it("keeps the retired semantic root absent on disk", () => {
    const shadowRoot = join(PRODUCTION_RECALL, "shadow");
    expect(existsSync(shadowRoot) && statSync(shadowRoot).isDirectory()).toBe(false);
    expect(existsSync(join(
      PRODUCTION_RECALL,
      "decision/prefix-capture/envelope.ts"
    ))).toBe(false);
    expect(existsSync(join(
      PRODUCTION_RECALL,
      "decision/prefix-capture/compare.ts"
    ))).toBe(false);
  });

  it("finds no forbidden directories or imports in live repository code", () => {
    const production = walkTypeScriptTree(
      PRODUCTION_RECALL,
      SKIP_PRODUCTION_DIRECTORY_NAMES
    );
    const repositoryFiles = REPOSITORY_CODE_ROOTS.flatMap(
      (root) => walkTypeScriptTree(root).files
    );
    expect(detectStructureOwnershipViolations({
      directories: production.directories,
      importSpecifiers: importSpecifiersIn(repositoryFiles)
    })).toEqual([]);
  });

  it("keeps prefix-capture from importing query-proof", () => {
    const prefix = join(PRODUCTION_RECALL, "decision/prefix-capture");
    const hits = importSpecifiersIn(walkTypeScriptTree(
      prefix,
      SKIP_PRODUCTION_DIRECTORY_NAMES
    ).files).filter((spec) => spec.includes("query-proof"));
    expect(hits).toEqual([]);
  });

  it("keeps moved package-root export names on the new from-paths", () => {
    const named = namedExportsByFromPath(readFileSync(INDEX_TS, "utf8"));
    for (const stale of STALE_FROM_PATHS) {
      expect(named.has(stale)).toBe(false);
    }
    for (const [fromPath, frozen] of Object.entries(FROZEN_MOVED_EXPORTS)) {
      expect(fromPath.includes("recall/shadow/")).toBe(false);
      expect(asNameSet(named.get(fromPath))).toEqual(asNameSet(frozen));
    }
  });
});

function walkTypeScriptTree(
  root: string,
  skipDirectoryNames: ReadonlySet<string> = SKIP_GENERATED_DIRECTORY_NAMES
): {
  directories: string[];
  files: string[];
} {
  const directories: string[] = [];
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skipDirectoryNames.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        stack.push(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.push(path);
      }
    }
  }
  return { directories, files };
}

function importSpecifiersIn(files: readonly string[]): string[] {
  const specifiers: string[] = [];
  for (const file of files) {
    specifiers.push(...importSpecifiersFromSource(readFileSync(file, "utf8")));
  }
  return specifiers;
}

function importSpecifiersFromSource(source: string): string[] {
  return [...source.matchAll(IMPORT_SPEC)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}

function namedExportsByFromPath(source: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const match of source.matchAll(EXPORT_BLOCK)) {
    const body = match[1];
    const fromPath = match[2];
    if (body === undefined || fromPath === undefined) continue;
    const names = body.split(",").map(parseExportedBinding).filter((name) => name.length > 0);
    found.set(fromPath, names);
  }
  return found;
}

function parseExportedBinding(part: string): string {
  const trimmed = part.trim();
  if (trimmed.length === 0) return "";
  const withoutType = trimmed.replace(/^type\s+/u, "").trim();
  const aliased = withoutType.split(/\s+as\s+/u);
  return (aliased[aliased.length - 1] ?? "").trim();
}

function asNameSet(names: readonly string[] | undefined): string[] {
  return [...new Set(names ?? [])].sort();
}

const DUMP_DIRECTORY_NAMES = new Set(["utils", "helpers", "misc", "common"]);

type StructureViolationKind = "directory" | "import";

type StructureViolation = Readonly<{
  kind: StructureViolationKind;
  value: string;
}>;

type StructureScanInput = Readonly<{
  directories?: readonly string[];
  importSpecifiers?: readonly string[];
  symbols?: readonly string[];
}>;

function detectStructureOwnershipViolations(
  input: StructureScanInput
): readonly StructureViolation[] {
  const hits: StructureViolation[] = [];
  for (const directory of input.directories ?? []) {
    if (isForbiddenDirectoryPath(directory)) {
      hits.push({ kind: "directory", value: directory });
    }
  }
  for (const specifier of input.importSpecifiers ?? []) {
    if (isForbiddenImportSpecifier(specifier)) {
      hits.push({ kind: "import", value: specifier });
    }
  }
  for (const symbol of input.symbols ?? []) {
    if (isForbiddenDirectoryPath(symbol) || isForbiddenImportSpecifier(symbol)) {
      hits.push({ kind: "import", value: symbol });
    }
  }
  return hits;
}

function isForbiddenDirectoryPath(path: string): boolean {
  const segments = posixSegments(path);
  if (isRetiredShadowRoot(segments)) return true;
  return segments.some(isForbiddenDirectorySegment);
}

function isForbiddenImportSpecifier(specifier: string): boolean {
  const spec = posixPath(specifier);
  if (isRetiredShadowImport(spec)) return true;
  if (isRelativeRetiredShadowImport(spec)) return true;
  if (isRetiredPrefixCaptureImport(spec)) return true;
  return hasForbiddenImportDirectory(spec);
}

function posixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function posixSegments(path: string): readonly string[] {
  return posixPath(path).replace(/\/+$/u, "").split("/").filter((part) => part.length > 0);
}

function isRetiredShadowRoot(segments: readonly string[]): boolean {
  const recall = segments.lastIndexOf("recall");
  if (recall < 0) return false;
  // integration/shadow is observation wiring, not the retired semantic root
  return segments[recall + 1] === "shadow";
}

function isForbiddenDirectorySegment(segment: string): boolean {
  if (segment === "d1" || segment === "psi-v2") return true;
  if (segment.startsWith("card-") || segment.startsWith("band-")) return true;
  return DUMP_DIRECTORY_NAMES.has(segment);
}

function isRetiredShadowImport(specifier: string): boolean {
  return /(?:^|\/)recall\/shadow\//u.test(specifier);
}

function isRelativeRetiredShadowImport(specifier: string): boolean {
  if (specifier.includes("integration/shadow/")) return false;
  return /(?:^|\/)\.\.\/shadow\//u.test(specifier) ||
    /(?:^|\/)\.\/shadow\//u.test(specifier);
}

function isRetiredPrefixCaptureImport(specifier: string): boolean {
  return /(?:^|\/)(?:decision\/)?prefix-capture\/(?:envelope|compare)\.js$/u
    .test(specifier);
}

function hasForbiddenImportDirectory(specifier: string): boolean {
  return /(?:^|\/)d1(?:\/|$)/u.test(specifier) ||
    /(?:^|\/)psi-v2(?:\/|$)/u.test(specifier);
}
