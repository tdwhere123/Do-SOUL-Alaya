import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { renderReport, type KpiPayload } from "@do-soul/alaya-eval";

export const DEFAULT_SOURCE_PATH = "var/checks/alaya-live/main-check.json";
export const LIVE_GATES_FILENAME = "live-gates.json";
const GATE_VALUE_MAX_LENGTH = 200;
const SENSITIVE_GATE_PATTERN =
  /(sk-[A-Za-z0-9_-]+|OPENAI_API_KEY|ALAYA_OPENAI_API_KEY|raw_transcript|foreign_object_id|text_excerpt|db_metrics|provider error)/iu;

const GateSchema = z.object({
  id: z.string().min(1),
  pass: z.boolean(),
  threshold: z.unknown(),
  observed: z.unknown(),
  evidence: z.string().min(1)
});

const RecallMetricsSchema = z
  .object({
    total_queries: z.number().int().nonnegative(),
    top1_hits: z.number().int().nonnegative(),
    top5_hits: z.number().int().nonnegative(),
    top1_rate: z.number().min(0).max(1),
    top5_rate: z.number().min(0).max(1),
    query_error_count: z.number().int().nonnegative(),
    query_error_rate: z.number().min(0).max(1),
    semantic_supplement_count: z.number().int().nonnegative(),
    semantic_supplement_rate: z.number().min(0).max(1),
    degraded_count: z.number().int().nonnegative(),
    p50_ms: z.number().nonnegative(),
    p95_ms: z.number().nonnegative(),
    max_ms: z.number().nonnegative()
  });

const SampleMetricsSchema = z
  .object({
    requested: z.number().int().nonnegative(),
    actual: z.number().int().nonnegative(),
    query_count: z.number().int().nonnegative()
  });

const ProviderHealthSchema = z
  .object({
    embedding: z
      .object({
        ok: z.boolean(),
        status: z.number().int().nonnegative().nullable().optional(),
        vector_dimensions: z.number().int().positive().nullable().optional()
      }),
    garden: z
      .object({
        ok: z.boolean(),
        status: z.number().int().nonnegative().nullable().optional()
      })
  });

const ModeSchema = z
  .object({
    mode: z.string().min(1),
    recall_metrics: RecallMetricsSchema,
    mcp_initialize_failed: z.number().int().nonnegative().default(0)
  });

const GardenMetricsSchema = z
  .object({
    task_count: z.number().int().nonnegative(),
    schema_valid_rate: z.number().min(0).max(1),
    accepted_rate: z.number().min(0).max(1),
    durable_write_success_rate: z.number().min(0).max(1),
    accepted_followup_success_rate: z.number().min(0).max(1),
    unreviewed_durable_write_count: z.number().int().nonnegative()
  });

const SecurityMetricsSchema = z
  .object({
    raw_key_hits: z.number().int().nonnegative(),
    exact_secret_hits: z.number().int().nonnegative()
  });

const LiveMainCheckSchema = z
  .object({
    latest_run_id: z.string().min(1),
    status: z.enum(["pass", "fail"]),
    generated_at: z.string().min(1),
    run_dir: z.string().min(1),
    report: z.string().min(1),
    summary: z.string().min(1),
    gates: z.array(GateSchema),
    metrics: z
      .object({
        samples: SampleMetricsSchema,
        provider_health: ProviderHealthSchema,
        modes: z.array(ModeSchema).min(1),
        garden: GardenMetricsSchema,
        security: SecurityMetricsSchema
      })
  });

const LiveRunSummarySchema = z
  .object({
    run_id: z.string().min(1),
    status: z.enum(["pass", "fail"]),
    finished_at: z.string().min(1),
    artifacts: z
      .object({
        run_dir: z.string().min(1)
      }),
    samples: SampleMetricsSchema,
    provider_health: ProviderHealthSchema,
    modes: z.array(ModeSchema).min(1),
    garden: GardenMetricsSchema,
    security: SecurityMetricsSchema,
    gates: z.array(GateSchema)
  });

type LiveMainCheck = z.infer<typeof LiveMainCheckSchema>;
type LiveMode = z.infer<typeof ModeSchema>;

export function parseLiveCheckSource(raw: string, sourcePath: string): LiveMainCheck {
  const parsed = JSON.parse(raw) as unknown;
  const mainCheck = LiveMainCheckSchema.safeParse(parsed);
  if (mainCheck.success) return mainCheck.data;

  const runSummary = LiveRunSummarySchema.safeParse(parsed);
  if (!runSummary.success) {
    throw mainCheck.error;
  }

  const summary = runSummary.data;
  return {
    latest_run_id: summary.run_id,
    status: summary.status,
    generated_at: summary.finished_at,
    run_dir: summary.artifacts.run_dir,
    report: path.join(summary.artifacts.run_dir, "report.md"),
    summary: relativeToCwd(sourcePath),
    gates: summary.gates,
    metrics: {
      samples: summary.samples,
      provider_health: summary.provider_health,
      modes: summary.modes,
      garden: summary.garden,
      security: summary.security
    }
  };
}

export function resolveProviderMode(modes: readonly LiveMode[]): LiveMode {
  const provider = modes.find((mode) => mode.mode === "embedding-real-provider");
  if (provider !== undefined) return provider;
  throw new Error("live check did not include embedding-real-provider mode");
}

export function renderLiveReport(
  payload: KpiPayload,
  previous: KpiPayload | null,
  diff: Parameters<typeof renderReport>[2],
  source: LiveMainCheck,
  providerMode: LiveMode,
  keywordMode: LiveMode | null
): string {
  const lines = [renderReport(payload, previous, diff), ""];
  lines.push("## Live strict-real gates", "");
  lines.push(
    `- Source run: ${source.latest_run_id}`,
    `- Source status: ${source.status}`,
    `- Source directory: ${source.run_dir}`,
    `- Security scan: raw=${source.metrics.security.raw_key_hits} exact=${source.metrics.security.exact_secret_hits}`,
    `- R@10 note: the live check records top1/top5 only; this archive mirrors top5 into R@10 so diff tooling can read one KPI shape.`
  );
  lines.push("");
  lines.push("| gate | result | observed | threshold | evidence |");
  lines.push("|---|---|---:|---|---|");
  for (const gate of source.gates) {
    const sanitizedGate = sanitizeGate(gate);
    lines.push(
      `| ${sanitizedGate.id} | ${sanitizedGate.pass ? "PASS" : "FAIL"} | ${formatUnknown(sanitizedGate.observed)} | ${formatUnknown(sanitizedGate.threshold)} | \`${sanitizedGate.evidence}\` |`
    );
  }
  lines.push("");
  lines.push("## Live mode comparison", "");
  lines.push("| mode | top1 | top5 | semantic supplement | p95 ms | query errors |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const mode of keywordMode === null ? [providerMode] : [keywordMode, providerMode]) {
    const metrics = mode.recall_metrics;
    lines.push(
      `| ${mode.mode} | ${formatRatio(metrics.top1_rate)} | ${formatRatio(metrics.top5_rate)} | ${formatRatio(metrics.semantic_supplement_rate)} | ${metrics.p95_ms} | ${metrics.query_error_count} |`
    );
  }
  lines.push("");
  lines.push("## Garden audit", "");
  lines.push(
    `- Tasks: ${source.metrics.garden.task_count}`,
    `- Schema-valid: ${formatRatio(source.metrics.garden.schema_valid_rate)}`,
    `- Reviewer accepted: ${formatRatio(source.metrics.garden.accepted_rate)}`,
    `- Durable write success: ${formatRatio(source.metrics.garden.durable_write_success_rate)}`,
    `- Follow-up success: ${formatRatio(source.metrics.garden.accepted_followup_success_rate)}`,
    `- Unreviewed durable writes: ${source.metrics.garden.unreviewed_durable_write_count}`
  );
  lines.push("");
  return lines.join("\n");
}

export function buildLiveGatesSidecar(
  source: LiveMainCheck,
  providerMode: LiveMode,
  keywordMode: LiveMode | null,
  sourcePath: string
): unknown {
  return {
    source_path: relativeToCwd(sourcePath),
    latest_run_id: source.latest_run_id,
    status: source.status,
    generated_at: source.generated_at,
    run_dir: source.run_dir,
    report: source.report,
    summary: source.summary,
    gates: source.gates.map(sanitizeGate),
    modes: (keywordMode === null ? [providerMode] : [keywordMode, providerMode]).map(summarizeMode),
    garden: {
      task_count: source.metrics.garden.task_count,
      schema_valid_rate: source.metrics.garden.schema_valid_rate,
      accepted_rate: source.metrics.garden.accepted_rate,
      durable_write_success_rate: source.metrics.garden.durable_write_success_rate,
      accepted_followup_success_rate: source.metrics.garden.accepted_followup_success_rate,
      unreviewed_durable_write_count: source.metrics.garden.unreviewed_durable_write_count
    },
    provider_health: {
      embedding: {
        ok: source.metrics.provider_health.embedding.ok,
        status: source.metrics.provider_health.embedding.status ?? null,
        vector_dimensions: source.metrics.provider_health.embedding.vector_dimensions ?? null
      },
      garden: {
        ok: source.metrics.provider_health.garden.ok,
        status: source.metrics.provider_health.garden.status ?? null
      }
    },
    security: {
      raw_key_hits: source.metrics.security.raw_key_hits,
      exact_secret_hits: source.metrics.security.exact_secret_hits
    }
  };
}

function summarizeMode(mode: LiveMode): unknown {
  const metrics = mode.recall_metrics;
  return {
    mode: mode.mode,
    recall_metrics: {
      total_queries: metrics.total_queries,
      top1_hits: metrics.top1_hits,
      top5_hits: metrics.top5_hits,
      top1_rate: metrics.top1_rate,
      top5_rate: metrics.top5_rate,
      query_error_count: metrics.query_error_count,
      query_error_rate: metrics.query_error_rate,
      semantic_supplement_count: metrics.semantic_supplement_count,
      semantic_supplement_rate: metrics.semantic_supplement_rate,
      degraded_count: metrics.degraded_count,
      p50_ms: metrics.p50_ms,
      p95_ms: metrics.p95_ms,
      max_ms: metrics.max_ms
    },
    mcp_initialize_failed: mode.mcp_initialize_failed
  };
}

interface SanitizedGate {
  readonly id: string;
  readonly pass: boolean;
  readonly threshold: string | number | boolean | null;
  readonly observed: string | number | boolean | null;
  readonly evidence: string;
}

export function sanitizeGate(gate: z.infer<typeof GateSchema>): SanitizedGate {
  return {
    id: gate.id,
    pass: gate.pass,
    threshold: sanitizeGateValue(gate.threshold),
    observed: sanitizeGateValue(gate.observed),
    evidence: sanitizeGateEvidence(gate.evidence)
  };
}

function sanitizeGateValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeGateString(value);
  return "[redacted_non_scalar]";
}

function sanitizeGateEvidence(value: string): string {
  return sanitizeGateString(value);
}

function sanitizeGateString(value: string): string {
  if (SENSITIVE_GATE_PATTERN.test(value)) return "[redacted_sensitive_scalar]";
  if (value.length <= GATE_VALUE_MAX_LENGTH) return value;
  return `${value.slice(0, GATE_VALUE_MAX_LENGTH)}...`;
}

export function parseRunDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`live check generated_at is not a valid ISO date: ${value}`);
  }
  return date;
}

// see also: apps/bench-runner/src/shared/version.ts resolveBenchRunnerVersion
export function resolveCommitSha7(): string {
  const sha = resolveGitHeadSha(process.cwd()).slice(0, 7);
  if (sha.length === 0) {
    throw new Error("git HEAD resolution returned an empty value");
  }
  return sha;
}

function resolveGitHeadSha(repoRoot: string): string {
  const gitDir = resolveGitDir(repoRoot);
  const head = readTrimmed(path.join(gitDir, "HEAD"));
  if (/^[0-9a-f]{40}$/iu.test(head)) {
    return head;
  }
  const refMatch = /^ref:\s+(.+)$/u.exec(head);
  if (refMatch === null) {
    throw new Error(`Unsupported git HEAD format: ${head}`);
  }
  const refName = refMatch[1];
  const commonDir = resolveCommonGitDir(gitDir);
  for (const root of [gitDir, commonDir]) {
    const refPath = path.join(root, refName);
    if (existsSync(refPath)) {
      return readTrimmed(refPath);
    }
  }
  const packedSha = readPackedRef(commonDir, refName) ?? readPackedRef(gitDir, refName);
  if (packedSha !== null) {
    return packedSha;
  }
  throw new Error(`Unable to resolve git ref: ${refName}`);
}

export function resolveGitDir(repoRoot: string): string {
  const gitPath = path.join(repoRoot, ".git");
  if (statSync(gitPath).isDirectory()) {
    return gitPath;
  }
  const raw = readTrimmed(gitPath);
  const gitDirMatch = /^gitdir:\s+(.+)$/u.exec(raw);
  if (gitDirMatch === null) {
    return gitPath;
  }
  const gitDir = gitDirMatch[1];
  return path.resolve(repoRoot, gitDir);
}

function resolveCommonGitDir(gitDir: string): string {
  const commonDirPath = path.join(gitDir, "commondir");
  if (!existsSync(commonDirPath)) {
    return gitDir;
  }
  return path.resolve(gitDir, readTrimmed(commonDirPath));
}

function readPackedRef(gitDir: string, refName: string): string | null {
  const packedRefsPath = path.join(gitDir, "packed-refs");
  if (!existsSync(packedRefsPath)) {
    return null;
  }
  for (const line of readFileSync(packedRefsPath, "utf8").split(/\r?\n/u)) {
    if (line.startsWith("#") || line.startsWith("^")) {
      continue;
    }
    const [sha, name] = line.split(" ");
    if (name === refName && /^[0-9a-f]{40}$/iu.test(sha)) {
      return sha;
    }
  }
  return null;
}

function readTrimmed(filePath: string): string {
  return readFileSync(filePath, "utf8").trim();
}

export function relativeToCwd(value: string): string {
  const absolute = path.resolve(value);
  const relative = path.relative(process.cwd(), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return value;
  return relative.length === 0 ? "." : relative;
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(2)}%`;
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}
