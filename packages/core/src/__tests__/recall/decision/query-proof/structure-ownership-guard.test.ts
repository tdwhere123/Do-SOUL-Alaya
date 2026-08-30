import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PRODUCTION_RECALL = join(SRC_ROOT, "recall");
const TEST_RECALL = fileURLToPath(new URL("../..", import.meta.url));
const INDEX_TS = join(SRC_ROOT, "index.ts");

const PLANTED_OLD_IMPORT = "../../recall/shadow/walk.js";
const PLANTED_D1_DIR = "packages/core/src/recall/decision/d1/";
const PLANTED_CARD_DIR = "packages/core/src/recall/card-13r-foo/";
const PLANTED_INTEGRATION_IMPORT = "../../recall/integration/shadow/integrate.js";
const PLANTED_LEXICAL_BOUND_IMPORT = "lexical-bound/index.js";
const PLANTED_SYMBOL = "d1PsiOutcome";

const SKIP_DIRECTORY_NAMES = new Set(["__tests__", "node_modules", "dist"]);
const IMPORT_SPEC = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu;
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
    expect(detectStructureOwnershipViolations({
      importSpecifiers: [PLANTED_OLD_IMPORT]
    })).toEqual([{ kind: "import", value: PLANTED_OLD_IMPORT }]);
  });

  it("rejects planted forbidden directories", () => {
    expect(detectStructureOwnershipViolations({
      directories: [PLANTED_D1_DIR, PLANTED_CARD_DIR]
    })).toEqual([
      { kind: "directory", value: PLANTED_D1_DIR },
      { kind: "directory", value: PLANTED_CARD_DIR }
    ]);
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
  });

  it("finds no forbidden directories or imports in the live recall tree", () => {
    const production = walkRecallTree(PRODUCTION_RECALL);
    const tests = walkRecallTree(TEST_RECALL);
    expect(detectStructureOwnershipViolations({
      directories: production.directories,
      importSpecifiers: [
        ...importSpecifiersIn(production.files),
        ...importSpecifiersIn(tests.files)
      ]
    })).toEqual([]);
  });

  it("keeps prefix-capture from importing query-proof", () => {
    const prefix = join(PRODUCTION_RECALL, "decision/prefix-capture");
    const hits = importSpecifiersIn(walkRecallTree(prefix).files).filter((spec) =>
      spec.includes("query-proof")
    );
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

function walkRecallTree(root: string): {
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
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
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
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_SPEC)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
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

function hasForbiddenImportDirectory(specifier: string): boolean {
  return /(?:^|\/)d1(?:\/|$)/u.test(specifier) ||
    /(?:^|\/)psi-v2(?:\/|$)/u.test(specifier);
}
