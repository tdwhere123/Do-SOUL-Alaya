import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { KpiPayload } from "@do-soul/alaya-eval";
import type { LongMemEvalSnapshotManifest } from "../../snapshot/materialize.js";
import type { RecallEvalResult } from "./recall-eval-contract.js";
import type { LongMemEvalWorkerShardPlan } from "./recall-eval-shards-worker.js";

interface LoadedShardArchive {
  readonly payload: KpiPayload;
  readonly diagnostics: readonly Record<string, unknown>[];
  readonly rankQuestions: readonly RankQuestion[];
}

interface RankQuestion {
  readonly question_id: string;
  readonly delivered_objects: readonly unknown[];
}

export async function mergeRecallEvalShardArchives(input: {
  readonly plans: readonly LongMemEvalWorkerShardPlan[];
  readonly historyRoot: string;
  readonly snapshotManifest: LongMemEvalSnapshotManifest;
  readonly concurrency: number;
}): Promise<RecallEvalResult> {
  const shards: LoadedShardArchive[] = [];
  for (const plan of input.plans) {
    shards.push(await loadRecallEvalShardArchive(plan));
  }
  const perScenario = shards.flatMap((shard) => shard.payload.kpi.per_scenario);
  if (perScenario.length === 0) {
    throw new Error("recall-eval shard merge found no per_scenario rows");
  }
  const first = shards[0];
  if (first === undefined) {
    throw new Error("recall-eval shard merge has no shards");
  }
  const payload = mergeShardPayloads(first.payload, shards, perScenario);
  const diagnostics = shards.flatMap((shard) => shard.diagnostics);
  const rankQuestions = shards.flatMap((shard) => shard.rankQuestions);
  const slug = mergedArchiveSlug(first.payload, input.concurrency);
  const entryRoot = join(input.historyRoot, "public", slug);
  await mkdir(entryRoot, { recursive: true });
  const kpiPath = join(entryRoot, "kpi.json");
  const reportPath = join(entryRoot, "report.md");
  const findingsPath = join(entryRoot, "findings.md");
  await writeFile(kpiPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(reportPath, mergedReport(input.concurrency, perScenario.length), "utf8");
  await writeFile(findingsPath, "", "utf8");
  if (rankQuestions.length > 0) {
    await writeFile(
      join(entryRoot, "recall-eval-rank-identity.json"),
      `${JSON.stringify({ schema_version: 2, questions: rankQuestions }, null, 2)}\n`,
      "utf8"
    );
  }
  await writeFile(
    join(input.historyRoot, "public", "latest-run.json"),
    `${JSON.stringify({ slug, kpi_path: `${slug}/kpi.json` }, null, 2)}\n`,
    "utf8"
  );
  return {
    slug,
    kpiPath,
    reportPath,
    findingsPath,
    payload,
    snapshotManifest: input.snapshotManifest,
    perQuestionDelivered: buildMergedDeliveredMap(
      diagnostics, rankQuestions, payload.kpi.per_scenario
    ),
    completion: { status: "complete", failures: [] },
    memoryProfile: { status: "disabled", failures: [] }
  };
}

async function loadRecallEvalShardArchive(
  plan: LongMemEvalWorkerShardPlan
): Promise<LoadedShardArchive> {
  const publicRoot = join(plan.historyRoot, "public");
  const entries = await readdir(publicRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const matches: string[] = [];
  for (const name of dirs) {
    try {
      await readFile(join(publicRoot, name, "kpi.json"));
      matches.push(name);
    } catch {
      // Skip directories without kpi.json.
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `recall-eval shard ${plan.shardIndex} must contain exactly one kpi archive, found ${matches.length}`
    );
  }
  const dir = join(publicRoot, matches[0] ?? "");
  const payload = JSON.parse(await readFile(join(dir, "kpi.json"), "utf8")) as KpiPayload;
  const rows = payload.kpi.per_scenario;
  if (!Array.isArray(rows) || rows.length !== plan.limit) {
    throw new Error(
      `recall-eval shard ${plan.shardIndex} per_scenario length ${rows?.length ?? 0} != limit ${plan.limit}`
    );
  }
  return {
    payload,
    diagnostics: await readShardDiagnostics(dir),
    rankQuestions: await readRankQuestions(dir)
  };
}

function mergeShardPayloads(
  first: KpiPayload,
  shards: readonly LoadedShardArchive[],
  perScenario: KpiPayload["kpi"]["per_scenario"]
): KpiPayload {
  const evaluated = perScenario.length;
  const latencies = perScenario
    .map((row) => row.latency_ms)
    .filter((value): value is number => typeof value === "number")
    .sort((left, right) => left - right);
  return {
    ...first,
    evaluated_count: evaluated,
    answerable_evaluated_count: evaluated,
    kpi: {
      ...first.kpi,
      per_scenario: perScenario,
      r_at_1: weightedRate(shards, "r_at_1"),
      r_at_5: weightedRate(shards, "r_at_5"),
      r_at_10: weightedRate(shards, "r_at_10"),
      ...(latencies.length === 0 ? {} : {
        latency_ms_p50: percentile(latencies, 0.5),
        latency_ms_p95: percentile(latencies, 0.95)
      })
    }
  };
}

function weightedRate(
  shards: readonly LoadedShardArchive[],
  key: "r_at_1" | "r_at_5" | "r_at_10"
): number {
  let hits = 0;
  let count = 0;
  for (const shard of shards) {
    const n = shard.payload.evaluated_count;
    const rate = shard.payload.kpi[key];
    if (typeof n !== "number" || typeof rate !== "number") {
      throw new Error(`recall-eval shard merge missing ${key}`);
    }
    hits += rate * n;
    count += n;
  }
  return count === 0 ? 0 : hits / count;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    throw new Error("recall-eval shard merge has no latencies");
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? sorted[0]!;
}

function buildMergedDeliveredMap(
  diagnostics: readonly Record<string, unknown>[],
  rankQuestions: readonly RankQuestion[],
  perScenario: readonly Readonly<{ readonly id: string }>[]
): ReadonlyMap<string, readonly string[]> {
  const rows = mergeDeliveredDiagnostics(diagnostics, rankQuestions);
  if (rows.length === 0) return new Map();
  const expected = new Set(perScenario.map((row) => row.id));
  const byQuestion = new Map(rows.map((question) => [question.question_id, question]));
  if (expected.size !== perScenario.length || byQuestion.size !== rows.length ||
      rows.length !== perScenario.length ||
      rows.some((question) => !expected.has(question.question_id))) {
    throw new Error("recall-eval shard delivery coverage mismatch");
  }
  return new Map(perScenario.map((row) => {
    const question = byQuestion.get(row.id);
    if (question === undefined) {
      throw new Error("recall-eval shard delivery coverage mismatch");
    }
    const objectIds = question.delivered_results?.map((result) => result.object_id) ??
      question.delivered_memory_ids ?? [];
    return [row.id, Object.freeze([...objectIds])];
  }));
}

function mergeDeliveredDiagnostics(
  diagnostics: readonly Record<string, unknown>[],
  rankQuestions: readonly RankQuestion[]
): readonly Readonly<{
  readonly question_id: string;
  readonly delivered_results?: readonly Readonly<{ readonly object_id: string }>[];
  readonly delivered_memory_ids?: readonly string[];
}>[] {
  if (rankQuestions.length > 0) {
    return rankQuestions.map((question) => ({
      question_id: question.question_id,
      delivered_results: deliveredObjectRows(question.delivered_objects)
    }));
  }
  return diagnostics.map((row) => ({
    question_id: String(row.question_id ?? ""),
    ...(Array.isArray(row.delivered_results) ? { delivered_results: row.delivered_results } : {}),
    ...(Array.isArray(row.delivered_memory_ids)
      ? { delivered_memory_ids: row.delivered_memory_ids as readonly string[] }
      : {})
  }));
}

function deliveredObjectRows(
  objects: readonly unknown[]
): readonly Readonly<{ readonly object_id: string }>[] {
  return objects.flatMap((row) => {
    if (typeof row === "string") return [{ object_id: row }];
    if (row !== null && typeof row === "object" && "object_id" in row) {
      const objectId = (row as { object_id: unknown }).object_id;
      return typeof objectId === "string" ? [{ object_id: objectId }] : [];
    }
    return [];
  });
}

async function readShardDiagnostics(
  dir: string
): Promise<readonly Record<string, unknown>[]> {
  const gzipPath = join(dir, "recall-eval-diagnostics.json.gz");
  const jsonPath = join(dir, "longmemeval-diagnostics.json");
  try {
    const parsed = JSON.parse(gunzipSync(await readFile(gzipPath)).toString("utf8")) as {
      readonly questions?: readonly Record<string, unknown>[];
    };
    return parsed.questions ?? [];
  } catch {
    try {
      const parsed = JSON.parse(await readFile(jsonPath, "utf8")) as {
        readonly questions?: readonly Record<string, unknown>[];
      };
      return parsed.questions ?? [];
    } catch {
      return [];
    }
  }
}

async function readRankQuestions(dir: string): Promise<readonly RankQuestion[]> {
  try {
    const parsed = JSON.parse(
      await readFile(join(dir, "recall-eval-rank-identity.json"), "utf8")
    ) as { readonly questions?: readonly RankQuestion[] };
    return parsed.questions ?? [];
  } catch {
    return [];
  }
}

function mergedArchiveSlug(payload: KpiPayload, concurrency: number): string {
  const runAt = payload.run_at.replaceAll(":", "").replaceAll("-", "").slice(0, 15);
  return `${payload.run_at}-${payload.alaya_commit}-c${concurrency}-merged`;
}

function mergedReport(concurrency: number, questions: number): string {
  return [
    "# Merged recall-eval shards",
    "",
    `Diagnostic merge of ${concurrency} process shards (${questions} questions).`,
    "Not release evidence. gate_eligible stays whatever the shards stored.",
    ""
  ].join("\n");
}
