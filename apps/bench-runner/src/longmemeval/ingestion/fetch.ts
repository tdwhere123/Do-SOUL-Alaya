import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LongMemEvalQuestionSchema,
  LongMemEvalVariant,
  type LongMemEvalQuestion
} from "./dataset.js";
import {
  createLongMemEvalReleaseEvidenceAuthority,
  type LongMemEvalReleaseEvidenceAuthority
} from "@do-soul/alaya-eval/authority";
import type { LongMemEvalSelectionAssignment } from "@do-soul/alaya-eval";
import { classifyLongMemEvalDatasetCohort } from "../../bench/selection/dataset-cohort.js";
import { streamLongMemEvalDataset } from "./streaming-dataset-reader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR_ROOT = path.resolve(__dirname, "../../../data/longmemeval");
const HUGGINGFACE_BASE =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main";
const MAX_PINNED_DATASET_BYTES = 1024 * 1024 * 1024;
const MAX_PINNED_QUESTION_COUNT = 20_000;

// @anchor upstream-filename-map: variant id is logical (matches our
// dataset.ts enum); upstream filenames in the HuggingFace repo are
// inconsistently suffixed. Keep the variant <-> upstream filename
// translation centralized here so the rest of the code can use clean
// variant ids and pinned meta filenames (`<variant>.meta.json`).
const UPSTREAM_FILENAME: Record<LongMemEvalVariant, string> = {
  longmemeval_oracle: "longmemeval_oracle.json",
  longmemeval_s: "longmemeval_s_cleaned.json",
  longmemeval_m: "longmemeval_m_cleaned.json"
};

// @anchor pinned-meta-root: pinned (committed) dataset checksums live under
// docs/bench-history/datasets/<variant>.meta.json. This is the trusted
// reference for loadDataset; the gitignored data/longmemeval/<variant>.meta.json
// is only a fetch-time scratch record and is NOT load-bearing.
const PINNED_META_ROOT = path.resolve(
  __dirname,
  "../../../../../docs/bench-history/datasets"
);
// @anchor pinned-meta-root-path: 5 segments up from
// apps/bench-runner/dist/longmemeval/ingestion/ -> apps/bench-runner/dist/longmemeval/ ->
// apps/bench-runner/dist/ -> apps/bench-runner/ -> apps/ -> repo-root, then docs/bench-history/datasets.

// Variant ids ("longmemeval_oracle", "longmemeval_s", ...) match the meta
// filename stem directly: docs/bench-history/datasets/<variant>.meta.json.
function pinnedMetaPath(variant: LongMemEvalVariant, root?: string): string {
  return path.join(root ?? PINNED_META_ROOT, `${variant}.meta.json`);
}

export interface FetchResult {
  readonly variant: LongMemEvalVariant;
  readonly localPath: string;
  readonly sha256: string;
  readonly questionCount: number;
}

export interface LoadedLongMemEvalDataset {
  readonly questions: LongMemEvalQuestion[];
  readonly sha256: string;
  readonly checksumSource: string;
  readonly sourcePath: string;
  readonly promotionAuthority: VerifiedLongMemEvalDatasetAuthority | null;
}

export interface LoadedLongMemEvalDatasetWindow extends LoadedLongMemEvalDataset {
  readonly datasetQuestionCount: number;
}

declare const verifiedDatasetAuthorityBrand: unique symbol;

export interface VerifiedLongMemEvalDatasetAuthority {
  readonly [verifiedDatasetAuthorityBrand]: true;
}

interface VerifiedDatasetAuthorityRecord {
  readonly datasetSha256: string;
  readonly assignments: readonly LongMemEvalSelectionAssignment[];
}

export type LongMemEvalAuthoritySelection =
  | {
      readonly kind: "execution_window";
      readonly offset: number;
      readonly limit: number;
    }
  | {
      readonly kind: "dataset_order_subset";
      readonly questionIds: readonly string[];
    };

const verifiedDatasetAuthorities = new WeakMap<
  object,
  VerifiedDatasetAuthorityRecord
>();

/**
 * Fetch a LongMemEval variant JSON from HuggingFace if not already cached,
 * validate the schema, compute SHA-256, and write to the local data dir.
 * see also: .gitignore — data/longmemeval/ excluded; checksum written to <variant>.meta.json
 */
export async function fetchLongMemEval(
  variant: LongMemEvalVariant,
  options: { dataDir?: string; force?: boolean } = {}
): Promise<FetchResult> {
  const dataDir = options.dataDir ?? DATA_DIR_ROOT;
  await mkdir(dataDir, { recursive: true });

  const localPath = path.join(dataDir, `${variant}.json`);
  const metaPath = path.join(dataDir, `${variant}.meta.json`);

  // Return cached copy unless force-fetch requested
  if (!options.force) {
    try {
      await readFile(localPath, "utf8");
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
        sha256: string;
        questionCount: number;
      };
      return { variant, localPath, sha256: meta.sha256, questionCount: meta.questionCount };
    } catch {
      // Cache miss; proceed with fetch.
    }
  }

  const upstreamFile = UPSTREAM_FILENAME[variant];
  const url = `${HUGGINGFACE_BASE}/${upstreamFile}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${variant} from HuggingFace: HTTP ${response.status} ${response.statusText}`
    );
  }

  const raw = await response.text();
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");

  // Validate schema before writing to disk
  const parsed = JSON.parse(raw) as unknown;
  const validated = validateDataset(parsed);

  await writeFile(localPath, raw, "utf8");
  await writeFile(
    metaPath,
    JSON.stringify({ variant, sha256, questionCount: validated.length }, null, 2) + "\n",
    "utf8"
  );

  return { variant, localPath, sha256, questionCount: validated.length };
}

/**
 * Load a previously fetched LongMemEval variant from the local data dir.
 *
 * @invariant The local JSON file's sha256 MUST match the pinned checksum
 *   under docs/bench-history/datasets/<variant>.meta.json. A loader
 *   that skips this check would let a corrupted or upstream-mutated cache
 *   silently produce different bench numbers across runs and reviewers.
 *
 * see also: apps/bench-runner/src/__tests__/dataset-checksum.test.ts
 */
export async function loadDataset(
  variant: LongMemEvalVariant,
  options: { dataDir?: string; pinnedMetaRoot?: string } = {}
): Promise<LongMemEvalQuestion[]> {
  return (await loadDatasetWithIdentity(variant, options)).questions;
}

/** Return the verified bytes' identity with the parsed dataset. */
export async function loadDatasetWithIdentity(
  variant: LongMemEvalVariant,
  options: { dataDir?: string; pinnedMetaRoot?: string } = {}
): Promise<LoadedLongMemEvalDataset> {
  const loaded = await loadDatasetWindowWithIdentity(variant, {
    ...options,
    offset: 0
  });
  const { datasetQuestionCount: _datasetQuestionCount, ...dataset } = loaded;
  return dataset;
}

export async function loadDatasetWindowWithIdentity(
  variant: LongMemEvalVariant,
  options: {
    readonly dataDir?: string;
    readonly pinnedMetaRoot?: string;
    readonly offset: number;
    readonly limit?: number;
  }
): Promise<LoadedLongMemEvalDatasetWindow> {
  assertDatasetWindow(options.offset, options.limit);
  const dataDir = options.dataDir ?? DATA_DIR_ROOT;
  const localPath = path.join(dataDir, `${variant}.json`);
  const pinnedMetaRoot = path.resolve(options.pinnedMetaRoot ?? PINNED_META_ROOT);
  const pinnedPath = pinnedMetaPath(variant, pinnedMetaRoot);
  const pinned = await readPinnedDatasetIdentity(variant, pinnedPath);
  const questions: LongMemEvalQuestion[] = [];
  const assignments: LongMemEvalSelectionAssignment[] = [];
  const identity = await streamLongMemEvalDataset(localPath, {
    datasetLabel: variant,
    expectedBytes: pinned.sizeBytes,
    maxQuestionCount: pinned.questionCount
  }, (question, index) => {
    assignments.push(datasetAssignment(question));
    if (index >= options.offset &&
        (options.limit === undefined || index < options.offset + options.limit)) {
      questions.push(question);
    }
  });
  assertStreamedDatasetIdentity({
    variant,
    localPath,
    pinned,
    identity,
    dataDir: options.dataDir
  });
  return {
    questions,
    datasetQuestionCount: identity.questionCount,
    sha256: identity.sha256,
    checksumSource: pinnedPath,
    sourcePath: localPath,
    promotionAuthority: pinnedMetaRoot === PINNED_META_ROOT
      ? mintVerifiedDatasetAuthority(identity.sha256, assignments)
      : null
  };
}

function assertStreamedDatasetIdentity(input: {
  readonly variant: LongMemEvalVariant;
  readonly localPath: string;
  readonly pinned: PinnedDatasetIdentity;
  readonly identity: Awaited<ReturnType<typeof streamLongMemEvalDataset>>;
  readonly dataDir?: string;
}): void {
  assertDatasetSha({
    variant: input.variant,
    localPath: input.localPath,
    pinnedSha: input.pinned.sha256,
    actualSha: input.identity.sha256,
    dataDir: input.dataDir
  });
  if (input.identity.bytesRead !== input.pinned.sizeBytes) {
    throw new Error(
      `dataset checksum mismatch: ${input.variant}; ` +
      `pinned_size=${input.pinned.sizeBytes}; actual_size=${input.identity.bytesRead}`
    );
  }
  if (input.identity.parseError !== undefined) throw input.identity.parseError;
  if (input.identity.questionCount !== input.pinned.questionCount) {
    throw new Error("LongMemEval dataset does not match pinned question count");
  }
}

interface PinnedDatasetIdentity {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly questionCount: number;
}

async function readPinnedDatasetIdentity(
  variant: LongMemEvalVariant,
  pinnedPath: string
): Promise<PinnedDatasetIdentity> {
  let pinnedRaw: string;
  try {
    pinnedRaw = await readFile(pinnedPath, "utf8");
  } catch {
    throw new Error(
      `dataset not pinned: ${variant}; commit a checksum to docs/bench-history/datasets/${variant}.meta.json first`
    );
  }

  try {
    const pinned = JSON.parse(pinnedRaw) as Record<string, unknown>;
    if (typeof pinned.sha256 !== "string" || pinned.sha256.length === 0) {
      throw new Error("missing sha256");
    }
    if (!isBoundedPositiveInteger(pinned.size_bytes, MAX_PINNED_DATASET_BYTES)) {
      throw new Error("invalid size_bytes");
    }
    if (!isBoundedPositiveInteger(pinned.question_count, MAX_PINNED_QUESTION_COUNT)) {
      throw new Error("invalid question_count");
    }
    return {
      sha256: pinned.sha256,
      sizeBytes: pinned.size_bytes,
      questionCount: pinned.question_count
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `dataset pinned meta unreadable: ${variant}; pinnedPath=${pinnedPath}; detail=${detail}`
    );
  }
}

function isBoundedPositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum;
}

function assertDatasetSha(input: {
  readonly variant: LongMemEvalVariant;
  readonly localPath: string;
  readonly pinnedSha: string;
  readonly actualSha: string;
  readonly dataDir?: string;
}): void {
  if (input.actualSha === input.pinnedSha) return;
  const dataDirArg = input.dataDir === undefined
    ? ""
    : ` --data-dir ${shellQuote(input.dataDir)}`;
  throw new Error(
    `dataset checksum mismatch: ${input.variant}; pinned=${input.pinnedSha}; actual=${input.actualSha}; refresh with 'alaya-bench-runner fetch-longmemeval --variant ${input.variant}${dataDirArg} --force'`
  );
}

export function deriveLongMemEvalReleaseEvidenceAuthority(
  datasetAuthority: VerifiedLongMemEvalDatasetAuthority | null,
  selection: LongMemEvalAuthoritySelection
): LongMemEvalReleaseEvidenceAuthority | null {
  if (datasetAuthority === null) return null;
  const dataset = verifiedDatasetAuthorities.get(datasetAuthority);
  if (dataset === undefined) {
    throw new Error("LongMemEval dataset promotion authority is not verified");
  }
  const assignments = selection.kind === "execution_window"
    ? selectExecutionWindow(dataset.assignments, selection)
    : selectDatasetOrderSubset(dataset.assignments, selection.questionIds);
  return createLongMemEvalReleaseEvidenceAuthority({
    datasetSha256: dataset.datasetSha256,
    assignments
  });
}

export function createTestLongMemEvalDatasetAuthority(input: {
  readonly datasetSha256: string;
  readonly assignments: readonly LongMemEvalSelectionAssignment[];
}): VerifiedLongMemEvalDatasetAuthority {
  if (process.env.VITEST !== "true") {
    throw new Error("test-only LongMemEval authority seam is unavailable");
  }
  return mintVerifiedDatasetAuthority(input.datasetSha256, input.assignments);
}

function mintVerifiedDatasetAuthority(
  datasetSha256: string,
  assignments: readonly LongMemEvalSelectionAssignment[]
): VerifiedLongMemEvalDatasetAuthority {
  const authority = Object.freeze({}) as VerifiedLongMemEvalDatasetAuthority;
  verifiedDatasetAuthorities.set(authority, {
    datasetSha256,
    assignments: Object.freeze(assignments.map((row) => Object.freeze({ ...row })))
  });
  return authority;
}

function datasetAssignment(
  question: LongMemEvalQuestion
): LongMemEvalSelectionAssignment {
  return {
    question_id: question.question_id,
    dataset_cohort: classifyLongMemEvalDatasetCohort(question)
  };
}

function assertDatasetWindow(offset: number, limit: number | undefined): void {
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))) {
    throw new Error("LongMemEval dataset window is invalid");
  }
}

function selectExecutionWindow(
  assignments: readonly LongMemEvalSelectionAssignment[],
  selection: Extract<LongMemEvalAuthoritySelection, { readonly kind: "execution_window" }>
): readonly LongMemEvalSelectionAssignment[] {
  if (!Number.isSafeInteger(selection.offset) || selection.offset < 0 ||
      !Number.isSafeInteger(selection.limit) || selection.limit < 0) {
    throw new Error("LongMemEval authority execution window is invalid");
  }
  const selected = assignments.slice(selection.offset, selection.offset + selection.limit);
  if (selected.length !== selection.limit) {
    throw new Error("LongMemEval authority execution window exceeds the dataset");
  }
  return selected;
}

function selectDatasetOrderSubset(
  assignments: readonly LongMemEvalSelectionAssignment[],
  questionIds: readonly string[]
): readonly LongMemEvalSelectionAssignment[] {
  const requested = new Set(questionIds);
  if (requested.size !== questionIds.length) {
    throw new Error("LongMemEval authority selection contains duplicate question ids");
  }
  const selected = assignments.filter((row) => requested.has(row.question_id));
  if (selected.length !== questionIds.length || selected.some(
    (row, index) => row.question_id !== questionIds[index]
  )) {
    throw new Error("LongMemEval authority selection does not preserve dataset order");
  }
  return selected;
}

function validateDataset(raw: unknown): LongMemEvalQuestion[] {
  if (!Array.isArray(raw)) {
    throw new Error("LongMemEval dataset must be a JSON array");
  }
  return raw.map((item, index) => {
    const result = LongMemEvalQuestionSchema.safeParse(item);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(`LongMemEval item[${index}] schema validation failed: ${issues}`);
    }
    return result.data;
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
