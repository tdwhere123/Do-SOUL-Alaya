import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildQaDeliverySettings } from "../../../runs/qa/qa-harness.js";
import { buildLongMemEvalSidecarKey, type LongMemEvalSidecarEntry } from "../../../datasets/longmemeval/runner/runner-helpers.js";
import { scoreLongMemEvalQaIfRequested } from "../../../datasets/longmemeval/runner/question/runner-question-delivery.js";

const flags = ["ALAYA_BENCH_DELIVER_GOLD_ONLY", "ALAYA_BENCH_QA_WIDE_AGG", "ALAYA_BENCH_QA_LLM_FILTER",
  "ALAYA_BENCH_QA_SUPPORT_PACK", "ALAYA_BENCH_QA_SESSION_SPREAD"] as const;
const question = { question_id: "q", question_type: "multi-session", question: "What happened?", answer: "gold",
  question_date: "2026-10-28", haystack_session_ids: [], haystack_dates: [], haystack_sessions: [], answer_session_ids: [] };
afterEach(() => vi.unstubAllEnvs());

function input() {
  const entries: LongMemEvalSidecarEntry[] = Array.from({ length: 12 }, (_, index) => ({
    objectId: `m${index}`, objectKind: "memory_entry", sessionId: index < 2 ? "same" : `s${index}`,
    content: `fact-${index}`, hasAnswer: index === 11
  }));
  return { question, isAbstention: false, results: entries.map((entry) => ({ object_id: entry.objectId })),
    goldMemoryIds: ["m11"], goldObjectIdentities: [{ objectKind: "memory_entry" as const, objectId: "m11" }],
    sidecar: new Map(entries.map((entry) => [buildLongMemEvalSidecarKey(entry.objectKind, entry.objectId), entry])) };
}

it.each(flags)("uses the same OFF semantics in selection and archived settings for %s", async (flag) => {
  for (const name of flags) vi.stubEnv(name, undefined);
  vi.stubEnv(flag, "off");
  const calls: string[] = [];
  const verdict = await scoreLongMemEvalQaIfRequested({ ...input(), qaChat: async (_system, user) => {
    calls.push(user); return calls.length === 1 ? "answer" : "no";
  } });
  expect(calls).toHaveLength(2);
  expect(verdict?.contextExposure.map((exposure) => exposure.objectId)).toEqual(Array.from({ length: 10 }, (_, index) => `m${index}`));
  expect(buildQaDeliverySettings()).toMatchObject({ gold_only_enabled: false, wide_agg_enabled: false,
    llm_filter_enabled: false, support_pack_enabled: false, session_spread_enabled: false });
});

it.each([false, true])("attributes withheld gold to clipping even when another gold was exposed (%s)", async (anotherGoldExposed) => {
  const root = mkdtempSync(join(tmpdir(), "qa-exposure-"));
  try {
    vi.stubEnv("ALAYA_BENCH_QA_DUMP", join(root, "qa.jsonl"));
    vi.stubEnv("ALAYA_BENCH_QA_CONTEXT_CHARS", "45");
    const fixture = input();
    const first = fixture.sidecar.get(buildLongMemEvalSidecarKey("memory_entry", "m0"))!;
    if (!anotherGoldExposed) fixture.sidecar.set(buildLongMemEvalSidecarKey("memory_entry", "m0"), { ...first, content: "x".repeat(100) });
    const calls: string[] = [];
    await scoreLongMemEvalQaIfRequested({ ...fixture, goldMemoryIds: ["m1"],
      goldObjectIdentities: (anotherGoldExposed ? ["m0", "m1"] : ["m1"]).map((objectId) => ({ objectKind: "memory_entry" as const, objectId })), qaChat: async (_system, user) => {
        calls.push(user); return calls.length === 1 ? "wrong" : "no";
      } });
    expect(calls[0]).not.toContain("fact-1");
    expect(JSON.parse(readFileSync(join(root, "qa.jsonl"), "utf8"))).toMatchObject({
      goldInDelivered: true, goldInAnswerContext: anotherGoldExposed, goldContextClipped: true, contextClipped: true,
      evaluatorValidity: "valid", failureClass: "context_clipped"
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
