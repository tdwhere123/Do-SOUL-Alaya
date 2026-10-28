import { afterAll, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  clipDeliveredSlotsByBudget,
  scoreContiguousReadVisibility,
  sourceTargetsJoinGold,
  spanIsCoveredByIntervals,
  type DeliveredIntervalSlot
} from "../../../runs/longmemeval-semantic/recall-visibility-diagnostics.js";
import {
  joinSnapshotAnswerSpans,
  type AnswerTurnGold,
  type AnswerTurnSpan,
  type SnapshotSourceRecordRow
} from "../../../runs/longmemeval-semantic/answer-spans.js";
const { scoreRecallHarnessRow } = await import(
  new URL("../../../../scripts/recall-harness-score.mjs", import.meta.url).href
);
import type { SourceGoldUnit } from "../../../runs/measurement/source-gold-join.js";
import type { LongMemEvalQuestion } from "../../../datasets/longmemeval/ingestion/dataset.js";

afterAll(() => {
  isolation.restore();
  expect(isolation.violations).toEqual([]);
});

const TARGET_A: SourceGoldUnit = {
  workspace_id: "ws-test",
  root_kind: "source_record",
  root_id: "sha256:aaaa000000000000000000000000000000000000000000000000000000000001",
  source_version: "bench-v1",
  content_digest: "sha256:1111000000000000000000000000000000000000000000000000000000000001"
};

const TARGET_B: SourceGoldUnit = {
  workspace_id: "ws-test",
  root_kind: "source_record",
  root_id: "sha256:bbbb000000000000000000000000000000000000000000000000000000000002",
  source_version: "bench-v1",
  content_digest: "sha256:2222000000000000000000000000000000000000000000000000000000000002"
};

const makeSpan = (
  start: number,
  end: number,
  target: SourceGoldUnit = TARGET_A,
  sessionIndex = 0,
  messageIndex = 0
): AnswerTurnSpan => ({
  session_index: sessionIndex,
  message_index: messageIndex,
  source_id: `longmemeval_s:q1-s${sessionIndex}-r0`,
  target,
  start,
  end
});

const makeGold = (spans: readonly AnswerTurnSpan[], complete = true, annotated = spans.length): AnswerTurnGold => ({
  unit: "published_body_utf8_bytes",
  annotated_turns: annotated,
  spans,
  complete
});

const makeSlot = (
  slot: number,
  start: number,
  end: number,
  target: SourceGoldUnit = TARGET_A
): DeliveredIntervalSlot => ({
  slot,
  target,
  span: { content_start: start, content_end: end }
});

describe("recall-visibility-diagnostics authority", () => {
  it("joins adjacent and overlapping intervals of the same root to cover a message span", () => {
    const span = makeSpan(10, 250);
    // Adjacent intervals: [0, 132) and [132, 277)
    const adjacent = [makeSlot(0, 0, 132), makeSlot(1, 132, 277)];
    expect(spanIsCoveredByIntervals(adjacent, span)).toBe(true);

    // Overlapping intervals: [0, 140) and [130, 277)
    const overlapping = [makeSlot(0, 0, 140), makeSlot(1, 130, 277)];
    expect(spanIsCoveredByIntervals(overlapping, span)).toBe(true);
  });

  it("does not join across even a one-byte gap", () => {
    const span = makeSpan(10, 250);
    // 1-byte gap at 132: [0, 132) and [133, 277)
    const gapped = [makeSlot(0, 0, 132), makeSlot(1, 133, 277)];
    expect(spanIsCoveredByIntervals(gapped, span)).toBe(false);

    // Boundary gap at start: span starts at 10, intervals start at 11
    const lateStart = [makeSlot(0, 11, 260)];
    expect(spanIsCoveredByIntervals(lateStart, span)).toBe(false);

    // Boundary gap at end: span ends at 250, intervals end at 249
    const earlyEnd = [makeSlot(0, 10, 249)];
    expect(spanIsCoveredByIntervals(earlyEnd, span)).toBe(false);
  });

  it("never merges intervals across source version, digest, workspace or root mismatches", () => {
    const span = makeSpan(10, 250, TARGET_A);
    const firstHalf = makeSlot(0, 0, 132, TARGET_A);

    const versionMismatch = makeSlot(1, 132, 277, { ...TARGET_A, source_version: "bench-v2" });
    const digestMismatch = makeSlot(1, 132, 277, {
      ...TARGET_A,
      content_digest: "sha256:ffff000000000000000000000000000000000000000000000000000000000099"
    });
    const workspaceMismatch = makeSlot(1, 132, 277, { ...TARGET_A, workspace_id: "other-ws" });
    const rootMismatch = makeSlot(1, 132, 277, {
      ...TARGET_A,
      root_id: "sha256:cccc000000000000000000000000000000000000000000000000000000000003"
    });
    const rootKindMismatch = makeSlot(1, 132, 277, { ...TARGET_A, root_kind: "memory_entry" as unknown as "source_record" });

    for (const secondHalf of [versionMismatch, digestMismatch, workspaceMismatch, rootMismatch, rootKindMismatch]) {
      expect(spanIsCoveredByIntervals([firstHalf, secondHalf], span)).toBe(false);
    }

    // Matching identity covers
    const matchingSecondHalf = makeSlot(1, 132, 277, TARGET_A);
    expect(spanIsCoveredByIntervals([firstHalf, matchingSecondHalf], span)).toBe(true);
  });

  it("never merges duplicate text across different roots", () => {
    const spanA = makeSpan(0, 100, TARGET_A);
    // Root B delivers [0, 100) with identical byte range but different root identity
    const slotB = makeSlot(0, 0, 100, TARGET_B);
    expect(spanIsCoveredByIntervals([slotB], spanA)).toBe(false);

    // Root A [0, 50) and Root B [50, 100) do not union to cover Root A's span [0, 100)
    const slotA = makeSlot(0, 0, 50, TARGET_A);
    const slotBPart = makeSlot(1, 50, 100, TARGET_B);
    expect(spanIsCoveredByIntervals([slotA, slotBPart], spanA)).toBe(false);
  });

  it("clips partial intervals by budget in slot order and charges repeated bytes without invisible deduplication", () => {
    // Three 100-byte slots
    const slots = [
      makeSlot(0, 0, 100, TARGET_A),
      makeSlot(1, 0, 100, TARGET_A), // repeated bytes of the same root
      makeSlot(2, 100, 200, TARGET_A)
    ];

    // Budget 150:
    // Slot 0 consumes 100 -> left 50
    // Slot 1 consumes 50 -> left 0 (clipped to [0, 50))
    // Slot 2 gets 0 bytes (omitted)
    const clipped150 = clipDeliveredSlotsByBudget(slots, 150);
    expect(clipped150).toHaveLength(2);
    expect(clipped150[0]).toEqual(makeSlot(0, 0, 100, TARGET_A));
    expect(clipped150[1]).toEqual(makeSlot(1, 0, 50, TARGET_A));

    // Repeated bytes charged 100 against budget; they do NOT allow slot 2 to be reached
    const spanTarget = makeSpan(100, 150, TARGET_A);
    expect(spanIsCoveredByIntervals(clipped150, spanTarget)).toBe(false);

    // Budget 250:
    // Slot 0 consumes 100 -> left 150
    // Slot 1 consumes 100 -> left 50
    // Slot 2 consumes 50 -> clipped to [100, 150)
    const clipped250 = clipDeliveredSlotsByBudget(slots, 250);
    expect(clipped250).toHaveLength(3);
    expect(clipped250[2]).toEqual(makeSlot(2, 100, 150, TARGET_A));
    expect(spanIsCoveredByIntervals(clipped250, spanTarget)).toBe(true);
  });

  it("distinguishes unknown/unmapped gold from a miss", () => {
    const span = makeSpan(0, 100, TARGET_A);
    const slots = [makeSlot(0, 200, 300, TARGET_A)]; // does not cover span

    // Complete gold with 1 turn: miss
    const completeGold = makeGold([span], true, 1);
    const completeScore = scoreContiguousReadVisibility({ gold: completeGold, slots });
    expect(completeScore.read5.status).toBe("miss");
    expect(completeScore.read5.any).toBe(false);
    expect(completeScore.read5.all).toBe(false);
    expect(completeScore.read5.reason).toBeNull();

    // Incomplete gold (e.g. 2 annotated turns but only 1 mapped): unknown
    const incompleteGold = makeGold([span], false, 2);
    const incompleteScore = scoreContiguousReadVisibility({ gold: incompleteGold, slots });
    expect(incompleteScore.read5.status).toBe("unknown");
    expect(incompleteScore.read5.reason).toBe("answer_turn_mapping_incomplete");
    expect(incompleteScore.read5.any).toBe(false);
    expect(incompleteScore.read5.all).toBe(false);

    // If one message is hit while mapping is incomplete: any is true, all is false, status is unknown
    const hitSlots = [makeSlot(0, 0, 100, TARGET_A)];
    const partialHitScore = scoreContiguousReadVisibility({ gold: incompleteGold, slots: hitSlots });
    expect(partialHitScore.read5.any).toBe(true);
    expect(partialHitScore.read5.all).toBe(false);
    expect(partialHitScore.read5.status).toBe("unknown");
    expect(partialHitScore.read5.covered).toBe(1);
    expect(partialHitScore.read5.total).toBe(2);
  });
});

describe("recall-harness-score scorer invocation boundary and column preservation", () => {
  it("preserves every existing column unchanged while providing additive contiguous read diagnostics", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "recall-score-test-"));
    try {
      const dbPath = join(tempDir, "source-index.sqlite");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE source_records (
          workspace_id TEXT,
          record_id TEXT,
          source_id TEXT,
          source_version TEXT,
          content_digest TEXT,
          source_body TEXT
        );
      `);

      const content = "User: Hello coupon fact today!\nAssistant: Welcome to the store!";
      const contentDigest = "sha256:1111000000000000000000000000000000000000000000000000000000000001";
      const recordId = "sha256:aaaa000000000000000000000000000000000000000000000000000000000001";
      db.prepare("INSERT INTO source_records VALUES (?, ?, ?, ?, ?, ?)").run(
        "ws-fixture",
        recordId,
        "longmemeval_s:q1-s0-r0",
        "bench-v1",
        contentDigest,
        content
      );
      db.close();

      const question: LongMemEvalQuestion = {
        question_id: "q1",
        question_type: "single-session-user",
        question: "Where is the coupon?",
        answer: "store",
        question_date: "2023/04/01 00:00",
        haystack_session_ids: ["s0"],
        haystack_dates: ["2023/04/01 00:00"],
        answer_session_ids: ["s0"],
        haystack_sessions: [
          [
            { role: "user", content: "Hello coupon fact today!", has_answer: true },
            { role: "assistant", content: "Welcome to the store!" }
          ]
        ]
      };

      const dataset = new Map([["q1", question]]);

      // Delivered row with 2 adjacent slots splitting the user message across 2 chunks:
      // "User: Hello coupon fact today!" is 30 bytes (User: is 6 bytes, turn is [6, 30))
      // Slot 0 delivers [0, 15): "User: Hello cou"
      // Slot 1 delivers [15, 30): "pon fact today!"
      // Neither chunk alone contains "Hello coupon fact today!" -> chunk substring scorer says false!
      // But contiguous read union covers [0, 30), containing [6, 30) -> contiguous read scorer says true!
      const row = {
        question_id: "q1",
        question_type: "single-session-user",
        arm: "split-arm",
        status: "complete",
        snapshot: dbPath,
        workspace: "ws-fixture",
        intervals: [
          {
            slot_index: 0,
            target: {
              kind: "source_evidence",
              workspace_id: "ws-fixture",
              root_kind: "source_record",
              root_id: recordId,
              source_version: "bench-v1",
              content_digest: contentDigest,
              span: { content_start: 0, content_end: 15 }
            },
            span: { content_start: 0, content_end: 15 }
          },
          {
            slot_index: 1,
            target: {
              kind: "source_evidence",
              workspace_id: "ws-fixture",
              root_kind: "source_record",
              root_id: recordId,
              source_version: "bench-v1",
              content_digest: contentDigest,
              span: { content_start: 15, content_end: 30 }
            },
            span: { content_start: 15, content_end: 30 }
          }
        ]
      };

      const result = scoreRecallHarnessRow(row, dataset);

      // Verify preservation of every original column
      expect(result).toHaveProperty("question_id", "q1");
      expect(result).toHaveProperty("question_type", "single-session-user");
      expect(result).toHaveProperty("arm", "split-arm");
      expect(result).toHaveProperty("status", "complete");
      expect(result).toHaveProperty("scored", true);
      expect(result).toHaveProperty("gold", 1);
      expect(result).toHaveProperty("delivered_bytes", 30);
      expect(result).toHaveProperty("slots", 2);

      // Chunk substring scorer missed the split message:
      expect(result.msg5).toEqual({ any: false, all: false });
      expect(result.msg10).toEqual({ any: false, all: false });
      expect(result.b2048).toEqual({ any: false, all: false });
      expect(result.b4096).toEqual({ any: false, all: false });
      expect(result.b8192).toEqual({ any: false, all: false });

      // Root@k saw the root:
      expect(result.root5).toEqual({ any: true, all: true });

      // Additive contiguous read diagnostics correctly join adjacent intervals and prove coverage!
      expect(result.read_gold).toEqual({ annotated: 1, mapped: 1, complete: true });
      expect(result.read5).toEqual({
        any: true,
        all: true,
        status: "hit",
        reason: null,
        covered: 1,
        total: 1
      });
      expect(result.read10).toEqual({
        any: true,
        all: true,
        status: "hit",
        reason: null,
        covered: 1,
        total: 1
      });
      expect(result.read_b2048).toEqual({
        any: true,
        all: true,
        status: "hit",
        reason: null,
        covered: 1,
        total: 1
      });

      // Verify message diagnostics detail
      expect(result.source_diagnostics.messages).toHaveLength(1);
      const msgDiag = result.source_diagnostics.messages[0]!;
      expect(msgDiag.text_chunk_match).toBe(false);
      expect(msgDiag.at5).toBe(true);
      expect(msgDiag.b2048).toBe(true);
      expect(msgDiag.joining_intervals).toEqual([
        { slot: 0, start: 0, end: 15 },
        { slot: 1, start: 15, end: 30 }
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each(["failed", "error", "unavailable"] as const)(
    "preserves exact old primary shape on %s rows with only additive diagnostics and no fake primary metrics",
    (status) => {
      const question: LongMemEvalQuestion = {
        question_id: "q-fail",
        question_type: "single-session-user",
        question: "Where?",
        answer: "there",
        question_date: "2023/04/01 00:00",
        haystack_session_ids: ["s0"],
        haystack_dates: ["2023/04/01 00:00"],
        answer_session_ids: ["s0"],
        haystack_sessions: [
          [
            { role: "user", content: "fact", has_answer: true },
            { role: "assistant", content: "ok" }
          ]
        ]
      };
      const dataset = new Map([["q-fail", question]]);
      const row = {
        question_id: "q-fail",
        question_type: "single-session-user",
        arm: "any-arm",
        status
      };

      const result = scoreRecallHarnessRow(row, dataset);

      // Exact old primary shape
      expect(result.question_id).toBe("q-fail");
      expect(result.question_type).toBe("single-session-user");
      expect(result.arm).toBe("any-arm");
      expect(result.status).toBe(status);
      expect(result.scored).toBe(false);
      expect(result.gold).toBe(1);

      // Must NOT fabricate primary metrics or slot/byte counts
      expect(result).not.toHaveProperty("delivered_bytes");
      expect(result).not.toHaveProperty("slots");
      expect(result).not.toHaveProperty("msg5");
      expect(result).not.toHaveProperty("msg10");
      expect(result).not.toHaveProperty("root5");
      expect(result).not.toHaveProperty("root10");
      expect(result).not.toHaveProperty("b2048");
      expect(result).not.toHaveProperty("b4096");
      expect(result).not.toHaveProperty("b8192");

      // ONLY additive diagnostics
      expect(result.read_gold).toEqual({ annotated: 1, mapped: 0, complete: false });
      expect(result.read5).toMatchObject({ status: "unknown", any: false, all: false, reason: `row_status_${status}` });
      expect(result.read10).toMatchObject({ status: "unknown", any: false, all: false, reason: `row_status_${status}` });
      expect(result.read_b2048).toMatchObject({ status: "unknown", any: false, all: false, reason: `row_status_${status}` });
      expect(result.source_diagnostics).toMatchObject({ reason: `row_status_${status}`, messages: [] });
    }
  );

  it("throws on missing question, non-failed row missing intervals, or missing/corrupt snapshot", () => {
    const dataset = new Map<string, LongMemEvalQuestion>();

    // Missing question in dataset
    expect(() =>
      scoreRecallHarnessRow({ question_id: "nonexistent", question_type: "t", arm: "a", status: "complete" }, dataset)
    ).toThrowError(expect.objectContaining({ code: "VALIDATION", message: expect.stringMatching(/not found in dataset/) }));

    const question: LongMemEvalQuestion = {
      question_id: "q-real",
      question_type: "single-session-user",
      question: "Q?",
      answer: "A",
      question_date: "2023/04/01 00:00",
      haystack_session_ids: ["s0"],
      haystack_dates: ["2023/04/01 00:00"],
      answer_session_ids: ["s0"],
      haystack_sessions: [[{ role: "user", content: "fact", has_answer: true }]]
    };
    dataset.set("q-real", question);

    // Nonfailed row missing intervals
    expect(() =>
      scoreRecallHarnessRow({ question_id: "q-real", question_type: "t", arm: "a", status: "complete" }, dataset)
    ).toThrowError(expect.objectContaining({ code: "VALIDATION", message: expect.stringMatching(/requires intervals array/) }));

    // Nonfailed row pointing to nonexistent SQLite snapshot
    expect(() =>
      scoreRecallHarnessRow(
        {
          question_id: "q-real",
          question_type: "t",
          arm: "a",
          status: "complete",
          snapshot: "/nonexistent/db.sqlite",
          workspace: "ws",
          intervals: []
        },
        dataset
      )
    ).toThrow();
  });

  it("correctly maps per-span text_chunk_match when an earlier gold turn is unmapped (gap-before-mapped-turn)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "recall-gap-test-"));
    try {
      const dbPath = join(tempDir, "source-index.sqlite");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE source_records (
          workspace_id TEXT,
          record_id TEXT,
          source_id TEXT,
          source_version TEXT,
          content_digest TEXT,
          source_body TEXT
        );
      `);

      // Turn 0 is in session 0 ("AlphaSecretCode12345")
      // Turn 1 is in session 1 ("BetaSecretCode67890")
      // SQLite snapshot ONLY has session 1 (round 0). Session 0 is NOT published in source_records.
      // So Turn 0 is UNMAPPED (gap before Turn 1).
      const contentTurn1 = "User: BetaSecretCode67890\nAssistant: Response for beta";
      const recordId1 = "sha256:bbbb000000000000000000000000000000000000000000000000000000000002";
      const digest1 = "sha256:2222000000000000000000000000000000000000000000000000000000000002";
      db.prepare("INSERT INTO source_records VALUES (?, ?, ?, ?, ?, ?)").run(
        "ws-gap",
        recordId1,
        "longmemeval_s:q-gap-s1-r0",
        "bench-v1",
        digest1,
        contentTurn1
      );
      db.close();

      const question: LongMemEvalQuestion = {
        question_id: "q-gap",
        question_type: "multi-session",
        question: "What are alpha and beta codes?",
        answer: "codes",
        question_date: "2023/04/01 00:00",
        haystack_session_ids: ["s0", "s1"],
        haystack_dates: ["2023/04/01 00:00", "2023/04/01 01:00"],
        answer_session_ids: ["s0", "s1"],
        haystack_sessions: [
          [{ role: "user", content: "AlphaSecretCode12345", has_answer: true }],
          [
            { role: "user", content: "BetaSecretCode67890", has_answer: true },
            { role: "assistant", content: "Response for beta" }
          ]
        ]
      };
      const dataset = new Map([["q-gap", question]]);

      // Delivered intervals:
      // Slot 0 delivers an unmapped source that happens to contain "AlphaSecretCode12345" substring!
      // Slot 1 delivers a partial interval of Turn 1 ("User: BetaSe") that does NOT contain "BetaSecretCode67890"
      // Therefore, in chunk matching:
      // Turn 0 ("AlphaSecretCode12345") is matched in slot 0 text!
      // Turn 1 ("BetaSecretCode67890") is NOT matched in any chunk!
      const dummyId = "sha256:dddd000000000000000000000000000000000000000000000000000000000004";
      const db2 = new Database(dbPath);
      db2.prepare("INSERT INTO source_records VALUES (?, ?, ?, ?, ?, ?)").run(
        "ws-gap",
        dummyId,
        "longmemeval_s:dummy",
        "bench-v1",
        "sha256:4444000000000000000000000000000000000000000000000000000000000004",
        "Some text containing AlphaSecretCode12345 exactly"
      );
      db2.close();

      const row = {
        question_id: "q-gap",
        question_type: "multi-session",
        arm: "gap-arm",
        status: "complete",
        snapshot: dbPath,
        workspace: "ws-gap",
        intervals: [
          {
            slot_index: 0,
            target: {
              kind: "source_evidence",
              workspace_id: "ws-gap",
              root_kind: "source_record",
              root_id: dummyId,
              source_version: "bench-v1",
              content_digest: "sha256:4444000000000000000000000000000000000000000000000000000000000004",
              span: { content_start: 0, content_end: 49 }
            },
            span: { content_start: 0, content_end: 49 }
          },
          {
            slot_index: 1,
            target: {
              kind: "source_evidence",
              workspace_id: "ws-gap",
              root_kind: "source_record",
              root_id: recordId1,
              source_version: "bench-v1",
              content_digest: digest1,
              span: { content_start: 0, content_end: 12 } // "User: BetaSe"
            },
            span: { content_start: 0, content_end: 12 }
          }
        ]
      };

      const result = scoreRecallHarnessRow(row, dataset);

      // Turn 0 is unmapped, so mapped = 1 while annotated = 2
      expect(result.read_gold).toEqual({ annotated: 2, mapped: 1, complete: false });

      // There is only 1 mapped message in diagnostics: Turn 1
      expect(result.source_diagnostics.messages).toHaveLength(1);
      const mappedMsg = result.source_diagnostics.messages[0]!;
      expect(mappedMsg.source_id).toBe("longmemeval_s:q-gap-s1-r0");
      expect(mappedMsg.session_index).toBe(1);

      // CRITICAL: Turn 1's text_chunk_match must be FALSE (not falsely inheriting Turn 0's true match at index 0)
      expect(mappedMsg.text_chunk_match).toBe(false);

      // Incomplete gold is reported as unknown, not miss:
      expect(result.read5.status).toBe("unknown");
      expect(result.read5.reason).toBe("answer_turn_mapping_incomplete");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
