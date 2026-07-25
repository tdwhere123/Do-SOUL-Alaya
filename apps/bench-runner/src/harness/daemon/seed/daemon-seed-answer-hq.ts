import { join } from "node:path";
import { initDatabase, SqliteMemoryHqRepo } from "@do-soul/alaya-storage";
import type { CreateBenchSeedOpsInput } from "./daemon-seed-ops-types.js";
import type { BenchSignalSeedInput } from "./daemon-seed-types.js";

const BENCH_ANSWER_HQ_MAX = 5;

export async function persistBenchAnswerHq(
  input: CreateBenchSeedOpsInput,
  memoryId: string,
  signalInput: BenchSignalSeedInput
): Promise<void> {
  const hqs = collectBenchAnswerHqs(signalInput);
  if (hqs.length === 0) return;
  const repo = new SqliteMemoryHqRepo(
    initDatabase({ filename: join(input.dataDir, "alaya.db") })
  );
  const existing = (await repo.getHqByObjectIds([memoryId])).get(memoryId) ?? [];
  const merged = [...new Set([...existing, ...hqs])].slice(0, BENCH_ANSWER_HQ_MAX);
  const now = new Date().toISOString();
  await repo.upsert({
    object_id: memoryId,
    workspace_id: input.activeContext.workspaceId,
    hqs: merged,
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
