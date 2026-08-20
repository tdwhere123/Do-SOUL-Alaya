import type { CreateBenchSeedOpsInput } from "./daemon-seed-ops-types.js";
import type { BenchSignalSeedInput } from "./daemon-seed-types.js";

const BENCH_ANSWER_HQ_MAX = 5;
const BENCH_HQ_PRODUCER_ID = "bench_compile_hq_v1";

export async function persistBenchAnswerHq(
  input: CreateBenchSeedOpsInput,
  memoryId: string,
  evidenceId: string,
  signalInput: BenchSignalSeedInput
): Promise<void> {
  if (signalInput.sourceObservedAt === undefined) return;
  const hqs = collectBenchAnswerHqs(signalInput);
  if (hqs.length === 0) return;
  const writer = input.activeRuntime.services.memoryHqWriter;
  if (writer === undefined) {
    throw new Error("Bench HQ persistence requires the runtime HQ writer.");
  }
  const now = new Date().toISOString();
  await writer.upsertFromEvidence({
    object_id: memoryId,
    workspace_id: input.activeContext.workspaceId,
    hqs,
    evidence_id: evidenceId,
    producer_id: BENCH_HQ_PRODUCER_ID,
    created_at: now,
    updated_at: now
  });
}

function collectBenchAnswerHqs(
  signalInput: BenchSignalSeedInput
): readonly string[] {
  const values = new Set<string>();
  for (const key of ["hqs", "hypothetical_questions", "hypotheticalQuestions"]) {
    for (const raw of readStringArrayField(signalInput.productionRawPayload, key)) {
      addBenchAnswerHq(values, raw);
    }
  }
  addBenchAnswerHq(values, signalInput.distilledFact);
  return [...values].slice(0, BENCH_ANSWER_HQ_MAX);
}

function readStringArrayField(
  rawPayload: Readonly<Record<string, unknown>> | undefined,
  key: string
): readonly string[] {
  const value = rawPayload?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function addBenchAnswerHq(values: Set<string>, value: string): void {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length > 0) values.add(normalized);
}
