import { createHash } from "node:crypto";
import type { GeminiBatchJob, GeminiBatchLine, GeminiBatchPlan } from "./contract.js";
import { assertGeminiGenerateContentSettings, encodeGeminiGenerateContent } from "./native-codec.js";

export const MAX_BATCH_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const batchDigest = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Both interactive and Batch adapters can use this exact generateContent body. */
export function encodeGeminiExtractionRequest(line: GeminiBatchLine, plan: GeminiBatchPlan): object {
  return encodeGeminiGenerateContent(line, { ...plan, maxOutputTokens: plan.limits.maxOutputTokens });
}

export function encodeGeminiBatchLines(lines: readonly GeminiBatchLine[], plan: GeminiBatchPlan): string {
  return lines.map((line) => JSON.stringify({
    key: line.key, request: encodeGeminiExtractionRequest(line, plan)
  }) + "\n").join("");
}

export function canonicalBatchPlan(plan: GeminiBatchPlan): GeminiBatchPlan {
  assertExactFields(plan, ["identity", "model", "requestProfile", "lines", "limits"]);
  assertExactFields(plan.limits, ["maxJobs", "maxRequestsPerJob", "maxFileBytes", "maxInputTokensPerJob",
    "maxEnqueuedTokens", "maxOutputTokens", "maxUsd", "inputUsdPerMillion", "outputUsdPerMillion",
    "deadlineMs", "requestTimeoutMs", "maxPolls"]);
  assertGeminiSettings(plan);
  if (!/^[a-f0-9]{64}$/u.test(plan.identity)) throw new Error("Batch plan identity must be a SHA-256");
  for (const [name, value] of Object.entries(plan.limits)) {
    if (!Number.isFinite(value) || value < 0 ||
        (!name.endsWith("Usd") && !name.endsWith("PerMillion") && !Number.isSafeInteger(value))) {
      throw new Error(`invalid Batch limit: ${name}`);
    }
  }
  for (const name of ["maxJobs", "maxRequestsPerJob", "maxFileBytes", "maxInputTokensPerJob",
    "maxEnqueuedTokens", "maxOutputTokens", "deadlineMs", "requestTimeoutMs", "maxPolls"] as const) {
    if (plan.limits[name] === 0) throw new Error(`Batch limit must be positive: ${name}`);
  }
  if (plan.limits.maxFileBytes > MAX_BATCH_ARTIFACT_BYTES) {
    throw new Error("Batch file cap exceeds local bounded artifact limit");
  }
  const keys = new Set<string>();
  const units = new Set<string>();
  const lines = [...plan.lines].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (const line of lines) {
    assertExactFields(line, ["key", "unitKeys", "requestSha256", "systemPrompt", "userPrompt"]);
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(line.key) || keys.has(line.key) ||
        !/^[a-f0-9]{64}$/u.test(line.requestSha256) || line.unitKeys.length === 0 ||
        !line.systemPrompt || !line.userPrompt) throw new Error("invalid or duplicate Batch line identity");
    keys.add(line.key);
    for (const unit of line.unitKeys) {
      if (!unit || units.has(unit)) throw new Error("duplicate or missing Batch unit identity");
      units.add(unit);
    }
  }
  const captured = structuredClone({ ...plan, lines });
  if (Buffer.byteLength(JSON.stringify(captured), "utf8") > MAX_BATCH_ARTIFACT_BYTES) {
    throw new Error("Batch plan exceeds bounded artifact limit");
  }
  return captured;
}

export function prepareBatchJobs(plan: GeminiBatchPlan): GeminiBatchJob[] {
  const groups: GeminiBatchLine[][] = [];
  let current: GeminiBatchLine[] = [];
  let bytes = 0;
  let tokens = 0;
  for (const line of plan.lines) {
    const nextBytes = Buffer.byteLength(encodeGeminiBatchLines([line], plan), "utf8");
    const nextTokens = inputBound([line], plan);
    if (!fits(current.length + 1, bytes + nextBytes, tokens + nextTokens, plan)) {
      if (current.length > 0) groups.push(current);
      current = [];
      bytes = 0;
      tokens = 0;
      if (!fits(1, nextBytes, nextTokens, plan)) throw new Error(`Batch line ${line.key} exceeds a request/file/token cap`);
    }
    current.push(line);
    bytes += nextBytes;
    tokens += nextTokens;
  }
  if (current.length > 0) groups.push(current);
  if (groups.length > plan.limits.maxJobs) throw new Error("Batch plan exceeds job cap");
  const jobs = groups.map((lines): GeminiBatchJob => {
    const wire = encodeGeminiBatchLines(lines, plan);
    const inputTokenBound = inputBound(lines, plan);
    const inputSha256 = batchDigest(wire);
    const id = batchDigest(JSON.stringify({ plan: plan.identity, inputSha256 }));
    return {
      id, displayName: `alaya-${id}`, lineKeys: lines.map((line) => line.key),
      inputSha256, inputBytes: Buffer.byteLength(wire, "utf8"), inputTokenBound,
      costBoundUsd: (inputTokenBound * plan.limits.inputUsdPerMillion +
        lines.length * plan.limits.maxOutputTokens * plan.limits.outputUsdPerMillion) / 1_000_000,
      status: "prepared", polls: 0, outcomes: {}, usageUnknown: true
    };
  });
  if (jobs.reduce((sum, job) => sum + job.costBoundUsd, 0) > plan.limits.maxUsd) {
    throw new Error("Batch plan exceeds conservative spend ceiling");
  }
  return jobs;
}

function inputBound(lines: readonly GeminiBatchLine[], plan: GeminiBatchPlan): number {
  // UTF-8 bytes plus protocol framing is deliberately conservative, never chars/4.
  return lines.reduce((sum, line) => sum + Buffer.byteLength(
    JSON.stringify(encodeGeminiExtractionRequest(line, plan)), "utf8"
  ) + 256, 0);
}

function fits(lines: number, bytes: number, tokens: number, plan: GeminiBatchPlan): boolean {
  return lines <= plan.limits.maxRequestsPerJob && bytes <= plan.limits.maxFileBytes &&
    tokens <= plan.limits.maxInputTokensPerJob && tokens <= plan.limits.maxEnqueuedTokens;
}

function assertGeminiSettings(plan: GeminiBatchPlan): void {
  assertGeminiGenerateContentSettings({ ...plan, maxOutputTokens: plan.limits.maxOutputTokens });
}

function assertExactFields(value: object, fields: readonly string[]): void {
  if (value === null || typeof value !== "object" ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error("Batch plan contains missing or unsupported settings");
  }
}
