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
      const raw = await readFile(localPath, "utf8");
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
        sha256: string;
        questionCount: number;
      };
      return { variant, localPath, sha256: meta.sha256, questionCount: meta.questionCount };
    } catch {
      // Cache miss — proceed with fetch
    }
  }

  const url = `${HUGGINGFACE_BASE}/${variant}.json`;
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
 * Throws if not fetched yet.
 */
export async function loadDataset(
  variant: LongMemEvalVariant,
  options: { dataDir?: string } = {}
): Promise<LongMemEvalQuestion[]> {
  const dataDir = options.dataDir ?? DATA_DIR_ROOT;
  const localPath = path.join(dataDir, `${variant}.json`);
  const raw = await readFile(localPath, "utf8");
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
