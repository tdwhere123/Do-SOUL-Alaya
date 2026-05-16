import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocomoSampleSchema, type LocomoSample, type LocomoVariant } from "./dataset.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR_ROOT = path.resolve(__dirname, "../../data/locomo");
const UPSTREAM_BASE = "https://raw.githubusercontent.com/snap-research/locomo/main/data";

const UPSTREAM_FILENAME: Record<LocomoVariant, string> = {
  locomo10: "locomo10.json"
};

// see also: docs/bench-history/datasets/<variant>.meta.json — pinned sha256
const PINNED_META_ROOT = path.resolve(__dirname, "../../../../docs/bench-history/datasets");

function pinnedMetaPath(variant: LocomoVariant, root?: string): string {
  return path.join(root ?? PINNED_META_ROOT, `${variant}.meta.json`);
}

export interface LocomoFetchResult {
  readonly variant: LocomoVariant;
  readonly localPath: string;
  readonly sha256: string;
  readonly conversationCount: number;
}

export async function fetchLocomo(
  variant: LocomoVariant,
  options: { dataDir?: string; force?: boolean } = {}
): Promise<LocomoFetchResult> {
  const dataDir = options.dataDir ?? DATA_DIR_ROOT;
  await mkdir(dataDir, { recursive: true });
  const localPath = path.join(dataDir, `${variant}.json`);
  const metaPath = path.join(dataDir, `${variant}.meta.json`);

  if (!options.force) {
    try {
      await readFile(localPath, "utf8");
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
        sha256: string;
        conversationCount: number;
      };
      return { variant, localPath, sha256: meta.sha256, conversationCount: meta.conversationCount };
    } catch {
      // cache miss
    }
  }

  const url = `${UPSTREAM_BASE}/${UPSTREAM_FILENAME[variant]}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${variant} from upstream: HTTP ${response.status} ${response.statusText}`
    );
  }
  const raw = await response.text();
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  const parsed = JSON.parse(raw) as unknown;
  const validated = validateDataset(parsed);
  await writeFile(localPath, raw, "utf8");
  await writeFile(
    metaPath,
    JSON.stringify({ variant, sha256, conversationCount: validated.length }, null, 2) + "\n",
    "utf8"
  );
  return { variant, localPath, sha256, conversationCount: validated.length };
}

export async function loadLocomo(
  variant: LocomoVariant,
  options: { dataDir?: string; pinnedMetaRoot?: string } = {}
): Promise<readonly LocomoSample[]> {
  const dataDir = options.dataDir ?? DATA_DIR_ROOT;
  const localPath = path.join(dataDir, `${variant}.json`);
  const pinnedPath = pinnedMetaPath(variant, options.pinnedMetaRoot);

  let pinnedRaw: string;
  try {
    pinnedRaw = await readFile(pinnedPath, "utf8");
  } catch {
    throw new Error(
      `locomo dataset not pinned: ${variant}; commit a checksum to docs/bench-history/datasets/${variant}.meta.json first`
    );
  }
  const pinned = JSON.parse(pinnedRaw) as { sha256?: unknown };
  if (typeof pinned.sha256 !== "string" || pinned.sha256.length === 0) {
    throw new Error(`locomo pinned meta missing sha256: ${pinnedPath}`);
  }

  let raw: string;
  try {
    raw = await readFile(localPath, "utf8");
  } catch {
    throw new Error(
      `locomo dataset not fetched: ${variant}; run 'alaya-bench-runner fetch-locomo --variant ${variant}'`
    );
  }
  const actualSha = createHash("sha256").update(raw, "utf8").digest("hex");
  if (actualSha !== pinned.sha256) {
    throw new Error(
      `locomo dataset checksum mismatch: ${variant}; pinned=${pinned.sha256}; actual=${actualSha}; re-fetch with 'alaya-bench-runner fetch-locomo --variant ${variant}'`
    );
  }
  return validateDataset(JSON.parse(raw) as unknown);
}

function validateDataset(raw: unknown): readonly LocomoSample[] {
  if (!Array.isArray(raw)) {
    throw new Error("locomo dataset must be a JSON array");
  }
  return raw.map((item, index) => {
    const result = LocomoSampleSchema.safeParse(item);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(`locomo item[${index}] schema validation failed: ${issues}`);
    }
    return result.data;
  });
}
