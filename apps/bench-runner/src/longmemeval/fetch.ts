import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LongMemEvalQuestionSchema,
  LongMemEvalVariant,
  type LongMemEvalQuestion
} from "./dataset.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR_ROOT = path.resolve(__dirname, "../../data/longmemeval");
const HUGGINGFACE_BASE =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main";

// @anchor upstream-filename-map — variant id is logical (matches our
// dataset.ts enum); upstream filenames in the HuggingFace repo are
// inconsistently suffixed. Keep the variant <-> upstream filename
// translation centralized here so the rest of the code can use clean
// variant ids and pinned meta filenames (`<variant>.meta.json`).
const UPSTREAM_FILENAME: Record<LongMemEvalVariant, string> = {
  longmemeval_oracle: "longmemeval_oracle.json",
  longmemeval_s: "longmemeval_s_cleaned.json",
  longmemeval_m: "longmemeval_m_cleaned.json"
};

// @anchor pinned-meta-root — pinned (committed) dataset checksums live under
// docs/v0.3/bench-history/datasets/<variant>.meta.json. This is the trusted
// reference for loadDataset; the gitignored data/longmemeval/<variant>.meta.json
// is only a fetch-time scratch record and is NOT load-bearing.
const PINNED_META_ROOT = path.resolve(
  __dirname,
  "../../../../docs/v0.3/bench-history/datasets"
);

// Variant ids ("longmemeval_oracle", "longmemeval_s", ...) match the meta
// filename stem directly: docs/v0.3/bench-history/datasets/<variant>.meta.json.
function pinnedMetaPath(variant: LongMemEvalVariant, root?: string): string {
  return path.join(root ?? PINNED_META_ROOT, `${variant}.meta.json`);
}

export interface FetchResult {
  readonly variant: LongMemEvalVariant;
  readonly localPath: string;
  readonly sha256: string;
  readonly questionCount: number;
}

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
      // Cache miss — proceed with fetch
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
 *   under docs/v0.3/bench-history/datasets/<variant>.meta.json. A loader
 *   that skips this check would let a corrupted or upstream-mutated cache
 *   silently produce different bench numbers across runs and reviewers.
 *
 * see also: apps/bench-runner/src/__tests__/dataset-checksum.test.ts
 */
export async function loadDataset(
  variant: LongMemEvalVariant,
  options: { dataDir?: string; pinnedMetaRoot?: string } = {}
): Promise<LongMemEvalQuestion[]> {
  const dataDir = options.dataDir ?? DATA_DIR_ROOT;
  const localPath = path.join(dataDir, `${variant}.json`);
  const pinnedPath = pinnedMetaPath(variant, options.pinnedMetaRoot);

  let pinnedRaw: string;
  try {
    pinnedRaw = await readFile(pinnedPath, "utf8");
  } catch {
    throw new Error(
      `dataset not pinned: ${variant}; commit a checksum to docs/v0.3/bench-history/datasets/${variant}.meta.json first`
    );
  }

  let pinnedSha: string;
  try {
    const pinned = JSON.parse(pinnedRaw) as { sha256?: unknown };
    if (typeof pinned.sha256 !== "string" || pinned.sha256.length === 0) {
      throw new Error("missing sha256");
    }
    pinnedSha = pinned.sha256;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `dataset pinned meta unreadable: ${variant}; pinnedPath=${pinnedPath}; detail=${detail}`
    );
  }

  const raw = await readFile(localPath, "utf8");
  const actualSha = createHash("sha256").update(raw, "utf8").digest("hex");
  if (actualSha !== pinnedSha) {
    throw new Error(
      `dataset checksum mismatch: ${variant}; pinned=${pinnedSha}; actual=${actualSha}; re-fetch with 'alaya-bench-runner fetch-longmemeval --variant ${variant}'`
    );
  }

  const parsed = JSON.parse(raw) as unknown;
  return validateDataset(parsed);
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
