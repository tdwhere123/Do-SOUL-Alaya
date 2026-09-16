import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AlayaError } from "@do-soul/alaya-protocol";
import type { ConditionalFieldExecutionReceipt } from "@do-soul/alaya-core";
import type { CanaryCase } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import {
  PUBLIC_CONSUMPTION_PROTOCOL,
  type ConsumptionStep,
  type ConsumptionTrace,
  type Enumeration,
  type LookupMode,
  type ResultView
} from "./source-discovery-public-consumption.js";

export type RunOutcome = "success" | "failure" | "partial" | "unavailable";

export type CaseIdentity = Readonly<{
  readonly cell: string;
  readonly group: string;
  readonly view: ResultView;
  readonly enumeration: Enumeration;
  readonly lookup: LookupMode;
}>;

export type CaseCoverage = Readonly<{
  readonly selected: readonly CaseIdentity[];
  readonly completed: readonly CaseIdentity[];
  readonly failed: readonly CaseIdentity[] | "unavailable";
  readonly filtered: "unavailable";
  readonly missing: readonly CaseIdentity[];
  readonly file_failed: boolean | "unavailable";
}>;

export function caseKey(identity: CaseIdentity): string {
  return `${identity.cell}/${identity.group}/${identity.view}/${identity.enumeration}/${identity.lookup}`;
}

export function deriveRunOutcome(coverage: CaseCoverage): RunOutcome {
  if (coverage.selected.length === 0) return "unavailable";
  const observedFailed = coverage.failed !== "unavailable" && coverage.failed.length > 0;
  const fileFailed = coverage.file_failed === true;
  const missing = coverage.missing.length > 0;
  if (!observedFailed && !fileFailed && !missing
    && coverage.completed.length === coverage.selected.length) {
    return "success";
  }
  if (coverage.completed.length === 0) return "failure";
  return "partial";
}

export function missingCases(
  selected: readonly CaseIdentity[],
  completed: readonly CaseIdentity[],
  failed: readonly CaseIdentity[] | "unavailable" = "unavailable"
): readonly CaseIdentity[] {
  const done = new Set(completed.map(caseKey));
  const failedKeys = failed === "unavailable" ? new Set<string>() : new Set(failed.map(caseKey));
  return selected.filter((identity) =>
    !done.has(caseKey(identity)) && !failedKeys.has(caseKey(identity)));
}

export function boundTrace(
  cell: string,
  canary: CanaryCase,
  view: ResultView,
  enumeration: Enumeration,
  lookup: LookupMode,
  trace: ConsumptionTrace,
  receipts: readonly ConditionalFieldExecutionReceipt[]
): unknown {
  return {
    cell,
    group: canary.group,
    view,
    enumeration,
    lookup,
    first_exposure: trace.first_exposure === null ? null : {
      delivery_id: trace.first_exposure.delivery_id,
      commitment: trace.first_exposure.commitment,
      page_purpose: trace.first_exposure.page_purpose,
      identity: trace.first_exposure.initial?.identity ?? null,
      digest: trace.first_exposure.initial?.digest ?? null
    },
    first_page_identities: trace.first_page_identities,
    expansions_by_target: trace.expansions_by_target,
    discarded_capped_incomplete_root_ids: trace.discarded_capped_incomplete_root_ids,
    cap_remainder: trace.cap_remainder,
    steps: trace.steps.map(boundStep),
    termination: boundStep(trace.termination),
    assembly_gap: trace.assembly_gap,
    assembled_source_bodies: assembledBodies(trace.termination),
    reconstructed_source_bodies: reconstructedSourceBodies(trace),
    settled_receipts: receipts.map((receipt) => ({
      query_id: receipt.query_id,
      interpretation_id: receipt.interpretation_id,
      snapshot_id: receipt.snapshot_id,
      actual: receipt.actual === undefined ? "unavailable" as const : {
        native_visits: receipt.actual.native_visits,
        native_bytes: receipt.actual.native_bytes,
        retained_bytes_current: receipt.actual.retained_bytes_current
      }
    }))
  };
}

export function persistRunEvidence(input: Readonly<{
  readonly rows: readonly unknown[];
  readonly traces: readonly unknown[];
  readonly selected: readonly CaseIdentity[];
  readonly completed: readonly CaseIdentity[];
  readonly failed: readonly CaseIdentity[] | "unavailable";
  readonly fileFailed: boolean | "unavailable";
}>): void {
  const identity = resultCandidateIdentity();
  if (identity.result_sha === "unavailable" || identity.result_tree === "unavailable") {
    return;
  }
  const capturedAt = new Date().toISOString();
  const stamp = capturedAt.replaceAll(":", "-");
  const coverage: CaseCoverage = {
    selected: input.selected,
    completed: input.completed,
    failed: input.failed,
    filtered: "unavailable",
    missing: missingCases(input.selected, input.completed, input.failed),
    file_failed: input.fileFailed
  };
  const runOutcome = deriveRunOutcome(coverage);
  const directory = join(evidenceDirectory(), "public-source-consumption-runs", identity.result_sha);
  mkdirSync(directory, { recursive: true });
  const envelope = {
    protocol: PUBLIC_CONSUMPTION_PROTOCOL,
    result_identity: identity,
    captured_at: capturedAt,
    run_outcome: runOutcome,
    case_coverage: coverage
  };
  persistExclusivePair(directory, stamp, {
    ...envelope,
    rows: input.rows
  }, {
    ...envelope,
    traces: input.traces
  });
}

function persistExclusivePair(
  directory: string,
  stamp: string,
  matrix: unknown,
  traces: unknown
): void {
  const matrixName = `${stamp}-matrix.json`;
  const tracesName = `${stamp}-traces.json`;
  const finalMatrix = join(directory, matrixName);
  const finalTraces = join(directory, tracesName);
  const staging = mkdtempSync(join(directory, `.${stamp}-`));
  try {
    writeExclusive(join(staging, matrixName), matrix);
    writeExclusive(join(staging, tracesName), traces);
    try {
      writeFileSync(finalTraces, readFileSync(join(staging, tracesName)), { flag: "wx" });
    } catch (error) {
      throw exclusiveEvidenceError(error, stamp);
    }
    try {
      writeFileSync(finalMatrix, readFileSync(join(staging, matrixName)), { flag: "wx" });
    } catch (error) {
      unlinkSync(finalTraces);
      throw exclusiveEvidenceError(error, stamp);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function exclusiveEvidenceError(error: unknown, stamp: string): Error {
  if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
    return new AlayaError("CONFLICT", `public consumption evidence already exists: ${stamp}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function boundStep(step: ConsumptionStep): unknown {
  return {
    purpose: step.purpose,
    membership_page: step.membership_page,
    payload_expansions: step.payload_expansions,
    cumulative_native_visits: step.cumulative_native_visits,
    cumulative_native_bytes: step.cumulative_native_bytes,
    retained_bytes_current: step.retained_bytes_current,
    public_identities: step.public_identities,
    preview_complete: step.preview_complete,
    logical_index: step.logical_index,
    payload_completeness: step.payload_completeness,
    stop_reason: step.stop_reason ?? null,
    public_exchange: step.public_exchange,
    assembly_gap: step.assembly_gap,
    ...(step.discarded_capped_incomplete_root_ids === undefined
      ? {}
      : { discarded_capped_incomplete_root_ids: step.discarded_capped_incomplete_root_ids }),
    ...(step.cap_remainder === undefined ? {} : { cap_remainder: step.cap_remainder }),
    source_body_bytes: Object.fromEntries(Object.entries(step.source_bodies).map(([id, body]) =>
      [id, Buffer.byteLength(body, "utf8")])),
    source_body_sha256: Object.fromEntries(Object.entries(step.source_bodies).map(([id, body]) =>
      [id, createHash("sha256").update(body, "utf8").digest("hex")]))
  };
}

function assembledBodies(step: ConsumptionStep): Readonly<Record<string, Readonly<{
  readonly utf8_bytes: number;
  readonly sha256: string;
}>>> {
  return Object.fromEntries(Object.entries(step.source_bodies).map(([id, body]) => [id, {
    utf8_bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body, "utf8").digest("hex")
  }]));
}

export function reconstructedSourceBodies(trace: ConsumptionTrace): Readonly<Record<string, Readonly<{
  readonly utf8_bytes: number | "unavailable";
  readonly sha256: string | "unavailable";
}>>> {
  const chunks = new Map<string, { readonly start: number; readonly bytes: Buffer }[]>();
  const unavailable = new Set<string>();
  for (const step of trace.steps) {
    for (const chunk of step.public_exchange.response.chunks) {
      if (chunk.preview_omitted) continue;
      if (chunk.chunk_text === "unavailable" || chunk.content_start === "unavailable") {
        unavailable.add(chunk.root_id);
        continue;
      }
      const list = chunks.get(chunk.root_id) ?? [];
      list.push({ start: chunk.content_start, bytes: Buffer.from(chunk.chunk_text, "utf8") });
      chunks.set(chunk.root_id, list);
    }
  }
  const entries: [string, { utf8_bytes: number | "unavailable"; sha256: string | "unavailable" }][] = [];
  for (const [rootId, list] of chunks) {
    if (unavailable.has(rootId)) {
      entries.push([rootId, { utf8_bytes: "unavailable", sha256: "unavailable" }]);
      continue;
    }
    const ordered = [...list].sort((left, right) => left.start - right.start);
    const body = Buffer.concat(ordered.map((chunk) => chunk.bytes));
    entries.push([rootId, {
      utf8_bytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex")
    }]);
  }
  for (const rootId of unavailable) {
    if (!chunks.has(rootId)) {
      entries.push([rootId, { utf8_bytes: "unavailable", sha256: "unavailable" }]);
    }
  }
  return Object.fromEntries(entries);
}

function resultCandidateIdentity(): Readonly<{
  readonly result_sha: string | "unavailable";
  readonly result_tree: string | "unavailable";
}> {
  try {
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: process.cwd(), encoding: "utf8"
    });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: process.cwd(), encoding: "utf8" }).trim();
    if (porcelain.trim() !== "" || !/^[a-f0-9]{40}$/u.test(sha) || !/^[a-f0-9]{40}$/u.test(tree)) {
      return { result_sha: "unavailable", result_tree: "unavailable" };
    }
    return { result_sha: sha, result_tree: tree };
  } catch {
    return { result_sha: "unavailable", result_tree: "unavailable" };
  }
}

function writeExclusive(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function evidenceDirectory(): string {
  return join(process.cwd(), ".do-it/bench-runs/query-source-discovery");
}
