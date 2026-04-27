import type {
  AuditEvent,
  ContextPack,
  ContextPackEntry,
  MemoryPlane,
  SoulMemoryPublicApi
} from "../contracts/index.js";

export type BenchmarkUsageState = "delivered" | "used" | "skipped" | "unverifiable";
export type BenchmarkRecommendedUsage = "blocking" | "advisory" | "historical";

export interface BenchmarkContextRequest {
  readonly taskId: string;
  readonly query: string;
  readonly requiredMemoryIds: readonly string[];
  readonly expectedFalseMemoryIds: readonly string[];
}

export interface BenchmarkContextEntry {
  readonly memoryId: string;
  readonly summary: string;
  readonly plane: MemoryPlane;
  readonly recallReason: string;
  readonly recommendedUsage: BenchmarkRecommendedUsage;
  readonly lifecycleState?: "active" | "accepted" | "rejected" | "retired" | "stale" | "superseded";
}

export interface BenchmarkRecallExclusion {
  readonly memoryId: string;
  readonly exclusionReason: string;
}

export interface BenchmarkContextPack {
  readonly id: string;
  readonly entries: readonly BenchmarkContextEntry[];
  readonly exclusions: readonly BenchmarkRecallExclusion[];
}

export interface BenchmarkUsageInput {
  readonly taskId: string;
  readonly contextPackId: string;
  readonly memoryId: string;
  readonly state: BenchmarkUsageState;
  readonly reason: string;
}

export interface BenchmarkAuditEvent {
  readonly type: string;
  readonly taskId?: string;
  readonly memoryId?: string;
  readonly reason?: string;
  readonly createdAt?: string;
}

export interface SoulMemoryBenchmarkApi {
  assembleContext: SoulMemoryPublicApi["assembleContext"];
  recordMemoryUsage?: SoulMemoryPublicApi["recordMemoryUsage"];
  rejectMemory?: SoulMemoryPublicApi["rejectMemory"];
  listAuditEvents?: SoulMemoryPublicApi["listAuditEvents"];
}

export interface BenchmarkTask {
  readonly id: string;
  readonly title: string;
  readonly query: string;
  readonly requiredMemoryIds: readonly string[];
  readonly expectedFalseMemoryIds: readonly string[];
  readonly baseline: {
    readonly clarificationTurns: number;
    readonly incorrectAssumptions: number;
    readonly missedRequiredMemorySteps: number;
    readonly acceptedReviewFindings: number;
    readonly timeToUsefulFirstAnswerMs: number;
  };
}

export interface BenchmarkScenarioResult {
  readonly mode: "without-memory" | "with-memory";
  readonly taskId: string;
  readonly clarificationTurns: number;
  readonly incorrectAssumptions: number;
  readonly missedRequiredMemorySteps: number;
  readonly acceptedReviewFindings: number;
  readonly timeToUsefulFirstAnswerMs: number;
  readonly memoryUsageRate: number;
  readonly falseRecallCount: number;
  readonly falseRecallCorrectionRate: number;
  readonly usedMemoryIds: readonly string[];
  readonly rejectedFalseRecallIds: readonly string[];
}

export interface BenchmarkReport {
  readonly generatedAt: string;
  readonly benchmarkVersion: string;
  readonly summary: {
    readonly taskCount: number;
    readonly averageClarificationTurnDelta: number;
    readonly averageIncorrectAssumptionDelta: number;
    readonly averageMissedMemoryStepDelta: number;
    readonly memoryUsageRate: number;
    readonly falseRecallCount: number;
    readonly falseRecallCorrectionRate: number;
  };
  readonly results: readonly BenchmarkScenarioResult[];
  readonly auditEvents: readonly BenchmarkAuditEvent[];
}

export interface RunBenchmarkOptions {
  readonly api: SoulMemoryBenchmarkApi;
  readonly tasks?: readonly BenchmarkTask[];
  readonly generatedAt?: string;
}

export const DEFAULT_BENCHMARK_TASKS: readonly BenchmarkTask[] = [
  {
    id: "coding-continuation",
    title: "Coding continuation after product decisions",
    query: "Implement the inspector without re-asking settled graph and API boundary questions.",
    requiredMemoryIds: ["decision.graph-first", "constraint.public-api-root", "hazard.no-main-repo-imports"],
    expectedFalseMemoryIds: ["stale.chat-timeline-inspector"],
    baseline: {
      clarificationTurns: 2,
      incorrectAssumptions: 2,
      missedRequiredMemorySteps: 3,
      acceptedReviewFindings: 1,
      timeToUsefulFirstAnswerMs: 180000
    }
  },
  {
    id: "review-fix-loop",
    title: "Review fix loop with prior governance state",
    query: "Re-review a fix while preserving accepted severity, audit, and local-first constraints.",
    requiredMemoryIds: ["decision.audit-required", "preference.local-first", "constraint.recall-explanations"],
    expectedFalseMemoryIds: ["rejected.cloud-sync-default"],
    baseline: {
      clarificationTurns: 1,
      incorrectAssumptions: 2,
      missedRequiredMemorySteps: 2,
      acceptedReviewFindings: 2,
      timeToUsefulFirstAnswerMs: 150000
    }
  }
];

const BENCHMARK_VERSION = "soul-memory-local-bench-v1";
const DEFAULT_GENERATED_AT = "2026-04-27T00:00:00.000Z";

export async function runSoulMemoryBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkReport> {
  const tasks = options.tasks ?? DEFAULT_BENCHMARK_TASKS;
  const results: BenchmarkScenarioResult[] = [];
  const auditEvents: BenchmarkAuditEvent[] = [];

  for (const task of tasks) {
    results.push(runWithoutMemory(task));
    const withMemory = await runWithMemory(task, options.api);
    results.push(withMemory.result);
    auditEvents.push(...withMemory.auditEvents);
  }

  return {
    generatedAt: options.generatedAt ?? DEFAULT_GENERATED_AT,
    benchmarkVersion: BENCHMARK_VERSION,
    summary: summarize(tasks, results),
    results,
    auditEvents: sortAuditEvents(auditEvents)
  };
}

export function serializeBenchmarkReport(report: BenchmarkReport): string {
  return JSON.stringify(report, Object.keys(flattenKeys(report)).sort(), 2);
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const lines = [
    "# SOUL Memory Benchmark Report",
    "",
    "- benchmarkVersion: " + report.benchmarkVersion,
    "- generatedAt: " + report.generatedAt,
    "- taskCount: " + report.summary.taskCount,
    "- memoryUsageRate: " + formatRate(report.summary.memoryUsageRate),
    "- falseRecallCorrectionRate: " + formatRate(report.summary.falseRecallCorrectionRate),
    "",
    "| task | mode | missed memory | wrong assumptions | false recall | used memory |",
    "| --- | --- | ---: | ---: | ---: | ---: |"
  ];

  for (const result of report.results) {
    lines.push([
      result.taskId,
      result.mode,
      String(result.missedRequiredMemorySteps),
      String(result.incorrectAssumptions),
      String(result.falseRecallCount),
      formatRate(result.memoryUsageRate)
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  return lines.join("\n") + "\n";
}

export function createScriptedBenchmarkApi(contextPacks: readonly BenchmarkContextPack[]): SoulMemoryBenchmarkApi {
  const packByTask = new Map<string, BenchmarkContextPack>();
  const auditEvents: BenchmarkAuditEvent[] = [];
  for (const pack of contextPacks) {
    const taskId = pack.id.replace(/^context-pack:/, "");
    packByTask.set(taskId, pack);
  }

  return {
    async assembleContext(request) {
      const taskId = request.requestId ?? request.query;
      const pack = packByTask.get(taskId);
      if (!pack) {
        return {
          contextPack: toPublicContextPack({
            id: "context-pack:" + taskId,
            entries: [],
            exclusions: []
          })
        };
      }
      return { contextPack: toPublicContextPack(pack) };
    },
    async recordMemoryUsage(input) {
      const taskId = String(input.event.contextPackId ?? "").replace(/^context-pack:/, "");
      auditEvents.push({
        type: "memory.usage." + input.event.state,
        taskId,
        memoryId: input.event.memoryId,
        reason: input.event.reason,
        createdAt: "2026-04-27T00:00:00.000Z"
      });
      return {
        event: input.event,
        session: scriptedSession(taskId)
      };
    },
    async rejectMemory(input) {
      const taskId = input.reason.match(/ for ([a-z0-9-]+)$/)?.[1];
      auditEvents.push({
        type: "memory.governance.reject",
        taskId,
        memoryId: input.memoryId,
        reason: input.reason,
        createdAt: "2026-04-27T00:00:00.000Z"
      });
      return {
        memory: scriptedMemory(input.memoryId),
        auditEvent: {
          id: "audit:" + input.memoryId,
          type: "memory.rejected",
          at: "2026-04-27T00:00:00.000Z",
          actor: input.actor,
          target: { type: "memory", id: input.memoryId },
          reason: input.reason
        }
      };
    },
    async listAuditEvents(input = {}) {
      const targetId = typeof input.targetId === "string" ? input.targetId : undefined;
      const filteredEvents = targetId === undefined
        ? auditEvents
        : auditEvents.filter((event) => event.taskId === targetId);
      return {
        auditEvents: filteredEvents.map((event): AuditEvent => ({
          id: "audit:" + [event.type, event.taskId, event.memoryId].filter(Boolean).join(":"),
          type: event.type.startsWith("memory.governance.reject") ? "memory.rejected" : "recall.performed",
          at: event.createdAt ?? "2026-04-27T00:00:00.000Z",
          actor: "benchmark",
          target: { type: event.memoryId ? "memory" : "bundle", id: event.memoryId ?? event.taskId ?? "benchmark" },
          reason: event.reason ?? event.type
        }))
      };
    }
  };
}

async function runWithMemory(
  task: BenchmarkTask,
  api: SoulMemoryBenchmarkApi
): Promise<{ readonly result: BenchmarkScenarioResult; readonly auditEvents: readonly BenchmarkAuditEvent[] }> {
  const { contextPack } = await api.assembleContext({
    query: task.query,
    requestId: task.id,
    limit: task.requiredMemoryIds.length + task.expectedFalseMemoryIds.length
  });
  const entries = contextPack.included;
  const falseRecallIds = entries
    .filter((entry) => isFalseRecall(entry, task.expectedFalseMemoryIds))
    .map((entry) => entry.memoryId)
    .sort();
  const rejectedFalseRecallIds: string[] = [];

  for (const memoryId of falseRecallIds) {
    if (api.rejectMemory) {
      await api.rejectMemory({
        memoryId,
        actor: "benchmark",
        reason: "Benchmark false recall correction for " + task.id
      });
      rejectedFalseRecallIds.push(memoryId);
    }
  }

  const usableEntries = entries.filter((entry) => !falseRecallIds.includes(entry.memoryId));
  const usedMemoryIds = usableEntries
    .filter((entry) => task.requiredMemoryIds.includes(entry.memoryId))
    .map((entry) => entry.memoryId)
    .sort();

  if (api.recordMemoryUsage) {
    for (const entry of usableEntries) {
      await api.recordMemoryUsage({
        event: {
          id: "usage:" + task.id + ":" + entry.memoryId,
          sessionId: "benchmark:" + task.id,
          contextPackId: contextPack.id,
          memoryId: entry.memoryId,
          kind: task.requiredMemoryIds.includes(entry.memoryId) ? "recall-item-cited" : "recall-item-skipped",
          at: "2026-04-27T00:00:00.000Z",
          state: task.requiredMemoryIds.includes(entry.memoryId) ? "used" : "skipped",
          reason: entry.reason
        }
      });
    }
  }

  const missedRequiredMemorySteps = Math.max(0, task.requiredMemoryIds.length - usedMemoryIds.length);
  const auditEvents = api.listAuditEvents
    ? (await api.listAuditEvents({ targetId: task.id })).auditEvents.map(toBenchmarkAuditEvent)
    : [];

  return {
    result: {
      mode: "with-memory",
      taskId: task.id,
      clarificationTurns: Math.max(0, task.baseline.clarificationTurns - usedMemoryIds.length),
      incorrectAssumptions: Math.max(0, task.baseline.incorrectAssumptions - usedMemoryIds.length + falseRecallIds.length),
      missedRequiredMemorySteps,
      acceptedReviewFindings: task.baseline.acceptedReviewFindings + usedMemoryIds.length,
      timeToUsefulFirstAnswerMs: Math.max(30000, task.baseline.timeToUsefulFirstAnswerMs - usedMemoryIds.length * 25000),
      memoryUsageRate: ratio(usedMemoryIds.length, task.requiredMemoryIds.length),
      falseRecallCount: falseRecallIds.length,
      falseRecallCorrectionRate: ratio(rejectedFalseRecallIds.length, falseRecallIds.length),
      usedMemoryIds,
      rejectedFalseRecallIds
    },
    auditEvents
  };
}

function runWithoutMemory(task: BenchmarkTask): BenchmarkScenarioResult {
  return {
    mode: "without-memory",
    taskId: task.id,
    clarificationTurns: task.baseline.clarificationTurns,
    incorrectAssumptions: task.baseline.incorrectAssumptions,
    missedRequiredMemorySteps: task.baseline.missedRequiredMemorySteps,
    acceptedReviewFindings: task.baseline.acceptedReviewFindings,
    timeToUsefulFirstAnswerMs: task.baseline.timeToUsefulFirstAnswerMs,
    memoryUsageRate: 0,
    falseRecallCount: 0,
    falseRecallCorrectionRate: 1,
    usedMemoryIds: [],
    rejectedFalseRecallIds: []
  };
}

function toPublicContextPack(pack: BenchmarkContextPack): ContextPack {
  return {
    id: pack.id,
    requestId: pack.id.replace(/^context-pack:/, ""),
    query: pack.id.replace(/^context-pack:/, ""),
    planePolicy: "all-day-one",
    recallPolicyVersion: "scripted-benchmark-v1",
    createdAt: "2026-04-27T00:00:00.000Z",
    included: pack.entries.map((entry, index) => ({
      id: "entry:" + pack.id + ":" + entry.memoryId,
      memoryId: entry.memoryId,
      plane: entry.plane,
      rank: index + 1,
      score: 1,
      reason: entry.recallReason,
      recommendedUse: entry.recommendedUsage,
      evidenceRefs: [{ evidenceId: "evidence:" + entry.memoryId }],
      sourceRef: {
        id: "source:" + entry.memoryId,
        type: "operator",
        ref: "scripted-benchmark"
      },
      flags: {
        stale: entry.lifecycleState === "stale" || entry.lifecycleState === "superseded",
        superseded: entry.lifecycleState === "superseded"
      }
    })),
    excluded: pack.exclusions.map((exclusion) => ({
      id: "exclusion:" + pack.id + ":" + exclusion.memoryId,
      memoryId: exclusion.memoryId,
      plane: "project-local",
      reason: exclusion.exclusionReason,
      evidenceRefs: [{ evidenceId: "evidence:" + exclusion.memoryId }],
      lifecycle: "candidate"
    })),
    totalIncludedCount: pack.entries.length,
    totalExcludedCount: pack.exclusions.length,
    explanationSummary: "Scripted benchmark context pack."
  };
}

function scriptedSession(taskId: string): Awaited<ReturnType<NonNullable<SoulMemoryBenchmarkApi["recordMemoryUsage"]>>>["session"] {
  return {
    id: "benchmark:" + taskId,
    agent: { kind: "benchmark" },
    mode: "gateway",
    startedAt: "2026-04-27T00:00:00.000Z",
    usageState: "used",
    ingestState: "not-requested",
    deliveredMemoryIds: [],
    usedMemoryIds: [],
    skippedMemoryIds: [],
    unverifiableMemoryIds: [],
    violationSummary: { blocking: 0, important: 0, niceToHave: 0 }
  };
}

function scriptedMemory(memoryId: string): Awaited<ReturnType<NonNullable<SoulMemoryBenchmarkApi["rejectMemory"]>>>["memory"] {
  return {
    id: memoryId,
    plane: "project-local",
    scopeId: "benchmark",
    kind: "fact",
    durability: "durable",
    lifecycle: "rejected",
    content: { summary: "Scripted benchmark memory " + memoryId },
    facets: [],
    source: { id: "source:" + memoryId, type: "operator", ref: "scripted-benchmark" },
    evidenceIds: ["evidence:" + memoryId],
    confidence: 1,
    strength: 1,
    createdAt: "2026-04-27T00:00:00.000Z"
  };
}

function toBenchmarkAuditEvent(event: AuditEvent): BenchmarkAuditEvent {
  return {
    type: event.type,
    taskId: event.target.type === "bundle" ? event.target.id : undefined,
    memoryId: event.target.type === "memory" ? event.target.id : undefined,
    reason: event.reason,
    createdAt: event.at
  };
}

function isFalseRecall(entry: ContextPackEntry, expectedFalseMemoryIds: readonly string[]): boolean {
  return expectedFalseMemoryIds.includes(entry.memoryId) ||
    entry.flags?.stale === true ||
    entry.flags?.superseded === true;
}

function summarize(tasks: readonly BenchmarkTask[], results: readonly BenchmarkScenarioResult[]): BenchmarkReport["summary"] {
  const withoutMemory = results.filter((result) => result.mode === "without-memory");
  const withMemory = results.filter((result) => result.mode === "with-memory");
  const falseRecallCount = sum(withMemory.map((result) => result.falseRecallCount));
  const rejectedFalseRecallCount = sum(withMemory.map((result) => result.rejectedFalseRecallIds.length));

  return {
    taskCount: tasks.length,
    averageClarificationTurnDelta: averageDelta(withoutMemory, withMemory, "clarificationTurns"),
    averageIncorrectAssumptionDelta: averageDelta(withoutMemory, withMemory, "incorrectAssumptions"),
    averageMissedMemoryStepDelta: averageDelta(withoutMemory, withMemory, "missedRequiredMemorySteps"),
    memoryUsageRate: ratio(sum(withMemory.map((result) => result.usedMemoryIds.length)), sum(tasks.map((task) => task.requiredMemoryIds.length))),
    falseRecallCount,
    falseRecallCorrectionRate: ratio(rejectedFalseRecallCount, falseRecallCount)
  };
}

function averageDelta(
  baseline: readonly BenchmarkScenarioResult[],
  comparison: readonly BenchmarkScenarioResult[],
  key: "clarificationTurns" | "incorrectAssumptions" | "missedRequiredMemorySteps"
): number {
  if (!baseline.length) return 0;
  const comparisonByTask = new Map(comparison.map((result) => [result.taskId, result]));
  const deltas = baseline.map((result) => result[key] - (comparisonByTask.get(result.taskId)?.[key] ?? result[key]));
  return round(ratio(sum(deltas), deltas.length));
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return round(numerator / denominator);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatRate(value: number): string {
  return Math.round(value * 100) + "%";
}

function sortAuditEvents(events: readonly BenchmarkAuditEvent[]): readonly BenchmarkAuditEvent[] {
  return [...events].sort((a, b) => [
    a.createdAt ?? "",
    a.taskId ?? "",
    a.type,
    a.memoryId ?? "",
    a.reason ?? ""
  ].join("|").localeCompare([
    b.createdAt ?? "",
    b.taskId ?? "",
    b.type,
    b.memoryId ?? "",
    b.reason ?? ""
  ].join("|")));
}

function flattenKeys(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
  if (!value || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const item of value) flattenKeys(item, keys);
    return keys;
  }
  for (const key of Object.keys(value)) {
    keys[key] = true;
    flattenKeys((value as Record<string, unknown>)[key], keys);
  }
  return keys;
}
