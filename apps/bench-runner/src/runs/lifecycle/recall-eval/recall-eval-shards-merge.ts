import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KpiPayload, PerScenarioRow } from "@do-soul/alaya-eval";
import type { LongMemEvalSnapshotManifest } from "../../snapshot/materialize.js";
import type { RecallEvalResult } from "./recall-eval-contract.js";
import type { LongMemEvalWorkerShardPlan } from "./recall-eval-shards-worker.js";
import {
  loadRecallEvalShardArchive,
  shardSourceRef,
  type LoadedShardArchive,
  type RankQuestion
} from "./recall-eval-shards-merge-load.js";
import {
  computeScorableHits,
  mergeShardPayloads,
  type ScorableHits
} from "./recall-eval-shards-merge-payload.js";

const IDENTITY_FIELDS = [
  "split",
  "alaya_commit",
  "embedding_provider",
  "chat_provider",
  "policy_shape",
  "harness_mode",
  "sample_size"
] as const;

export async function mergeRecallEvalShardArchives(input: {
  readonly plans: readonly LongMemEvalWorkerShardPlan[];
  readonly historyRoot: string;
  readonly snapshotManifest: LongMemEvalSnapshotManifest;
  readonly concurrency: number;
}): Promise<RecallEvalResult> {
  const shards: LoadedShardArchive[] = [];
  for (const plan of input.plans) shards.push(await loadRecallEvalShardArchive(plan));
  const first = shards[0];
  if (first === undefined) throw new Error("recall-eval shard merge has no shards");
  assertShardCompatibility(shards);
  const perScenario = collectUniquePerScenario(shards);
  if (perScenario.length === 0) {
    throw new Error("recall-eval shard merge found no per_scenario rows");
  }
  const diagnostics = shards.flatMap((shard) => shard.diagnostics);
  const rankQuestions = collectRankQuestions(shards);
  const hits = computeScorableHits(perScenario, indexDiagnostics(diagnostics, perScenario));
  const payload = mergeShardPayloads(first.payload, shards, perScenario, hits);
  return writeDiagnosticMerge({
    input, first, shards, payload, perScenario, diagnostics, rankQuestions, hits
  });
}

async function writeDiagnosticMerge(args: {
  readonly input: {
    readonly historyRoot: string;
    readonly snapshotManifest: LongMemEvalSnapshotManifest;
    readonly concurrency: number;
  };
  readonly first: LoadedShardArchive;
  readonly shards: readonly LoadedShardArchive[];
  readonly payload: KpiPayload;
  readonly perScenario: readonly PerScenarioRow[];
  readonly diagnostics: readonly Record<string, unknown>[];
  readonly rankQuestions: readonly RankQuestion[];
  readonly hits: ScorableHits;
}): Promise<RecallEvalResult> {
  const slug = `${args.first.payload.run_at.replaceAll(":", "-")}-${args.first.payload.alaya_commit}-c${args.input.concurrency}-merged`;
  const entryRoot = join(args.input.historyRoot, "public", slug);
  await mkdir(entryRoot, { recursive: true });
  const kpiPath = join(entryRoot, "kpi.json");
  const reportPath = join(entryRoot, "report.md");
  const findingsPath = join(entryRoot, "findings.md");
  await writeFile(kpiPath, `${JSON.stringify(args.payload, null, 2)}\n`, "utf8");
  await writeFile(reportPath, mergedReport(args.input.concurrency, args.hits), "utf8");
  await writeFile(findingsPath, "", "utf8");
  await writeFile(
    join(entryRoot, "recall-eval-shard-sources.json"),
    `${JSON.stringify({ schema_version: 1, shards: args.shards.map(shardSourceRef) }, null, 2)}\n`,
    "utf8"
  );
  if (args.rankQuestions.length > 0) {
    await writeFile(
      join(entryRoot, "recall-eval-rank-identity.json"),
      `${JSON.stringify({ schema_version: 2, questions: args.rankQuestions }, null, 2)}\n`,
      "utf8"
    );
  }
  return {
    slug,
    kpiPath,
    reportPath,
    findingsPath,
    payload: args.payload,
    snapshotManifest: args.input.snapshotManifest,
    perQuestionDelivered: buildMergedDeliveredMap(
      args.diagnostics, args.rankQuestions, args.payload.kpi.per_scenario
    ),
    completion: { status: "complete", failures: [] },
    memoryProfile: { status: "disabled", failures: [] }
  };
}

function assertShardCompatibility(shards: readonly LoadedShardArchive[]): void {
  const first = shards[0];
  if (first === undefined) return;
  for (let i = 1; i < shards.length; i++) {
    assertIdentityMatch(first, shards[i]!, i);
    assertContiguousPartition(shards[i - 1]!.plan, shards[i]!.plan, i);
  }
}

function assertIdentityMatch(
  first: LoadedShardArchive,
  shard: LoadedShardArchive,
  index: number
): void {
  if (
    shard.payload.dataset.name !== first.payload.dataset.name ||
    shard.payload.dataset.checksum_sha256 !== first.payload.dataset.checksum_sha256
  ) {
    throw new Error(
      `recall-eval shard merge dataset mismatch: shard[${index}] ${shard.payload.dataset.name} != shard[0] ${first.payload.dataset.name}`
    );
  }
  for (const field of IDENTITY_FIELDS) {
    if (shard.payload[field] === first.payload[field]) continue;
    throw new Error(
      `recall-eval shard merge ${field} mismatch: shard[${index}] ${String(shard.payload[field])} != shard[0] ${String(first.payload[field])}`
    );
  }
}

function assertContiguousPartition(
  prev: LongMemEvalWorkerShardPlan,
  next: LongMemEvalWorkerShardPlan,
  index: number
): void {
  const prevEnd = prev.offset + prev.limit;
  if (next.offset < prevEnd) {
    throw new Error(
      `recall-eval shard merge partition overlap between shard ${index - 1} and shard ${index}`
    );
  }
  if (next.offset > prevEnd) {
    throw new Error(
      `recall-eval shard merge partition gap between shard ${index - 1} and shard ${index}`
    );
  }
}

function collectUniquePerScenario(
  shards: readonly LoadedShardArchive[]
): PerScenarioRow[] {
  const seenIds = new Set<string>();
  const rows: PerScenarioRow[] = [];
  for (const shard of shards) {
    for (const row of shard.payload.kpi.per_scenario) {
      if (row.id.length === 0 || seenIds.has(row.id)) {
        throw new Error(
          `recall-eval shard merge duplicate question_id '${row.id}' across shards`
        );
      }
      seenIds.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

function collectRankQuestions(
  shards: readonly LoadedShardArchive[]
): readonly RankQuestion[] {
  const unavailable = shards.filter((shard) => shard.rankQuestions === "unavailable");
  if (unavailable.length === shards.length) {
    // No rank identity present. Callers must not treat this as observed-empty
    // delivery: the rank sidecar is omitted and delivery falls back to diagnostics.
    return [];
  }
  if (unavailable.length > 0) {
    throw new Error("recall-eval shard merge rank identity sidecar missing from some shards");
  }
  const questions = shards.flatMap((shard) => shard.rankQuestions as readonly RankQuestion[]);
  if (questions.length === 0) {
    throw new Error("recall-eval shard merge rank identity present but empty");
  }
  return questions;
}

function indexDiagnostics(
  diagnostics: readonly Record<string, unknown>[],
  perScenario: readonly PerScenarioRow[]
): ReadonlyMap<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const diagnostic of diagnostics) {
    const id = diagnostic.question_id;
    if (typeof id !== "string" || id.length === 0 || byId.has(id)) {
      throw new Error(
        `recall-eval shard merge duplicate or missing diagnostic question_id '${String(id)}'`
      );
    }
    byId.set(id, diagnostic);
  }
  for (const row of perScenario) {
    if (!byId.has(row.id)) {
      throw new Error(`recall-eval shard merge missing diagnostic for question_id '${row.id}'`);
    }
  }
  if (byId.size !== perScenario.length) {
    throw new Error("recall-eval shard merge extra diagnostic question_id not present in per_scenario");
  }
  return byId;
}

export function buildMergedDeliveredMap(
  diagnostics: readonly Record<string, unknown>[],
  rankQuestions: readonly RankQuestion[],
  perScenario: readonly Readonly<{ readonly id: string }>[]
): ReadonlyMap<string, readonly string[]> {
  const rows = mergeDeliveredDiagnostics(diagnostics, rankQuestions);
  const expected = new Set(perScenario.map((row) => row.id));
  const byQuestion = new Map(rows.map((question) => [question.question_id, question]));
  if (
    expected.size !== perScenario.length ||
    byQuestion.size !== rows.length ||
    rows.length !== perScenario.length ||
    rows.some((question) => !expected.has(question.question_id))
  ) {
    throw new Error("recall-eval shard delivery coverage mismatch");
  }
  return new Map(
    perScenario.map((row) => {
      const question = byQuestion.get(row.id);
      if (question === undefined) {
        throw new Error("recall-eval shard delivery coverage mismatch");
      }
      const objectIds = question.delivered_results?.map((result) => result.object_id) ??
        question.delivered_memory_ids ?? [];
      return [row.id, Object.freeze([...objectIds])];
    })
  );
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
      const objectId = row.object_id;
      return typeof objectId === "string" ? [{ object_id: objectId }] : [];
    }
    return [];
  });
}

function mergedReport(concurrency: number, hits: ScorableHits): string {
  return [
    "# Merged recall-eval shards",
    "",
    `Diagnostic merge of ${concurrency} process shards (${hits.evaluatedCount} questions, ${hits.answerableCount} answerable).`,
    "Strictly non-promotable diagnostic evidence: gate_eligible=false.",
    ""
  ].join("\n");
}
