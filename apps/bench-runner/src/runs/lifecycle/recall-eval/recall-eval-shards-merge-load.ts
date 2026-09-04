import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { KpiPayload } from "@do-soul/alaya-eval";
import { LONGMEMEVAL_DIAGNOSTICS_FILENAME } from "../../archive/archive-evidence.js";
import type { LongMemEvalWorkerShardPlan } from "./recall-eval-shards-worker.js";

export interface RankQuestion {
  readonly question_id: string;
  readonly delivered_objects: readonly unknown[];
}

export interface ShardSourceRef {
  readonly shard_index: number;
  readonly offset: number;
  readonly limit: number;
  readonly slug: string;
  readonly kpi_sha256: string;
}

export interface LoadedShardArchive {
  readonly plan: LongMemEvalWorkerShardPlan;
  readonly dir: string;
  readonly slug: string;
  readonly kpiSha256: string;
  readonly payload: KpiPayload;
  readonly diagnostics: readonly Record<string, unknown>[];
  readonly rankQuestions: readonly RankQuestion[] | "unavailable";
}

const RANK_IDENTITY_FILENAME = "recall-eval-rank-identity.json";
const GZIP_DIAGNOSTICS_FILENAME = "recall-eval-diagnostics.json.gz";

export async function loadRecallEvalShardArchive(
  plan: LongMemEvalWorkerShardPlan
): Promise<LoadedShardArchive> {
  const { dir, slug } = await resolveUniqueKpiDir(plan);
  const rawKpi = await readFile(join(dir, "kpi.json"), "utf8");
  const payload = parseKpiPayload(rawKpi, plan.shardIndex);
  const rows = payload.kpi.per_scenario;
  if (!Array.isArray(rows) || rows.length !== plan.limit) {
    throw new Error(
      `recall-eval shard merge shard ${plan.shardIndex} per_scenario length ` +
      `${rows?.length ?? 0} != limit ${plan.limit}`
    );
  }
  return {
    plan,
    dir,
    slug,
    kpiSha256: createHash("sha256").update(rawKpi).digest("hex"),
    payload,
    diagnostics: await readRequiredDiagnostics(dir, plan.shardIndex),
    rankQuestions: await readRankQuestions(dir, plan.shardIndex)
  };
}

export function shardSourceRef(shard: LoadedShardArchive): ShardSourceRef {
  return {
    shard_index: shard.plan.shardIndex,
    offset: shard.plan.offset,
    limit: shard.plan.limit,
    slug: shard.slug,
    kpi_sha256: shard.kpiSha256
  };
}

async function resolveUniqueKpiDir(
  plan: LongMemEvalWorkerShardPlan
): Promise<{ readonly dir: string; readonly slug: string }> {
  const publicRoot = join(plan.historyRoot, "public");
  const entries = await readdir(publicRoot, { withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await fileExists(join(publicRoot, entry.name, "kpi.json"))) matches.push(entry.name);
  }
  if (matches.length !== 1) {
    throw new Error(
      `recall-eval shard merge shard ${plan.shardIndex} must contain exactly one kpi archive, found ${matches.length}`
    );
  }
  const slug = matches[0]!;
  return { slug, dir: join(publicRoot, slug) };
}

function parseKpiPayload(raw: string, shardIndex: number): KpiPayload {
  try {
    return JSON.parse(raw) as KpiPayload;
  } catch (error) {
    throw new Error(
      `recall-eval shard merge corrupt kpi.json on shard ${shardIndex}: ${String(error)}`
    );
  }
}

async function readRequiredDiagnostics(
  dir: string,
  shardIndex: number
): Promise<readonly Record<string, unknown>[]> {
  const gzipPath = join(dir, GZIP_DIAGNOSTICS_FILENAME);
  const jsonPath = join(dir, LONGMEMEVAL_DIAGNOSTICS_FILENAME);
  const gzip = await readExisting(gzipPath);
  if (gzip !== undefined) {
    return parseDiagnosticQuestions(decodeGzip(gzip, gzipPath), gzipPath, shardIndex);
  }
  const json = await readExisting(jsonPath);
  if (json !== undefined) {
    return parseDiagnosticQuestions(json.toString("utf8"), jsonPath, shardIndex);
  }
  throw new Error(
    `recall-eval shard merge missing diagnostics sidecar on shard ${shardIndex} at ${dir}`
  );
}

async function readRankQuestions(
  dir: string,
  shardIndex: number
): Promise<readonly RankQuestion[] | "unavailable"> {
  const path = join(dir, RANK_IDENTITY_FILENAME);
  const raw = await readExisting(path);
  if (raw === undefined) return "unavailable";
  let parsed: { readonly questions?: unknown };
  try {
    parsed = JSON.parse(raw.toString("utf8")) as { readonly questions?: unknown };
  } catch (error) {
    throw new Error(
      `recall-eval shard merge corrupt rank identity on shard ${shardIndex}: ${String(error)}`
    );
  }
  if (!Array.isArray(parsed.questions)) {
    throw new Error(
      `recall-eval shard merge corrupt rank identity on shard ${shardIndex}: questions[] required`
    );
  }
  return parsed.questions as RankQuestion[];
}

function parseDiagnosticQuestions(
  text: string,
  path: string,
  shardIndex: number
): readonly Record<string, unknown>[] {
  let parsed: { readonly questions?: unknown };
  try {
    parsed = JSON.parse(text) as { readonly questions?: unknown };
  } catch (error) {
    throw new Error(
      `recall-eval shard merge corrupt diagnostics on shard ${shardIndex} at ${path}: ${String(error)}`
    );
  }
  if (!Array.isArray(parsed.questions)) {
    throw new Error(
      `recall-eval shard merge corrupt diagnostics on shard ${shardIndex} at ${path}: questions[] required`
    );
  }
  return parsed.questions as Record<string, unknown>[];
}

function decodeGzip(raw: Buffer, path: string): string {
  try {
    return gunzipSync(raw).toString("utf8");
  } catch (error) {
    throw new Error(`recall-eval shard merge corrupt diagnostics at ${path}: ${String(error)}`);
  }
}

async function readExisting(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return (await readExisting(path)) !== undefined;
}

function isEnoent(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
