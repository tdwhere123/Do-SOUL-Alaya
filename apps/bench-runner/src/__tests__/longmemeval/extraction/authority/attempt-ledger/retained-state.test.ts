import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { classifyRetainedExtractionAttemptState, openExtractionAttemptLedger,
  type ExtractionAttemptLedgerSnapshot } from "../../../../../runs/extraction/authority/attempt-ledger.js";

const key = "a".repeat(64), otherKey = "b".repeat(64);
const reserved = { cacheKey: key, attemptOrdinal: 1 };
const failed = { ...reserved, kind: "http_error" as const, phase: "response_status" as const,
  httpStatus: 500, fingerprint: "c".repeat(64) };
let root: string;
let empty: ExtractionAttemptLedgerSnapshot;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "retained-attempt-state-"));
  empty = openExtractionAttemptLedger({ cacheRoot: root, lineageDigest: "d".repeat(64),
    cacheIdentity: { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1" },
    startingMissing: 1 }).snapshot();
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

type Case = {
  name: string;
  ledger?: Partial<ExtractionAttemptLedgerSnapshot> | null;
  raws?: number[];
  shardPresent?: boolean;
  expected: "unknown" | "pending" | "transport_failure" | "incomplete" | "settled";
};
const cases: Case[] = [
  { name: "missing ledger and retained evidence", ledger: null, expected: "settled" },
  { name: "empty complete history", expected: "settled" },
  { name: "incomplete history before missing raw and pending key", ledger: {
    historyComplete: false, unresolvedAttempts: [reserved], pendingKeys: [key] }, expected: "incomplete" },
  { name: "missing unresolved raw before pending key", ledger: {
    unresolvedAttempts: [reserved], pendingKeys: [key] }, expected: "unknown" },
  { name: "another ordinal cannot satisfy an unresolved attempt", ledger: {
    unresolvedAttempts: [reserved] }, raws: [2], expected: "unknown" },
  { name: "retained unresolved attempt", ledger: { unresolvedAttempts: [reserved] },
    raws: [1], expected: "pending" },
  { name: "published shard cannot settle an unresolved attempt", ledger: {
    unresolvedAttempts: [reserved] }, raws: [1], shardPresent: true, expected: "pending" },
  { name: "retained raw without shard before settlement classification", ledger: {
    settledAttempts: [reserved], transportFailures: [failed] }, raws: [1], expected: "pending" },
  { name: "settled transport failure without retained evidence", ledger: {
    settledAttempts: [reserved], transportFailures: [failed] }, expected: "transport_failure" },
  { name: "successful settlement without retained evidence", ledger: {
    settledAttempts: [reserved] }, expected: "incomplete" },
  { name: "later successful settlement supersedes earlier failure", ledger: {
    settledAttempts: [{ ...reserved, attemptOrdinal: 2 }, reserved], transportFailures: [failed] },
    expected: "incomplete" },
  { name: "later failure supersedes earlier successful settlement", ledger: {
    settledAttempts: [reserved], transportFailures: [{ ...failed, attemptOrdinal: 2 }] },
    expected: "transport_failure" },
  { name: "settlement classification precedes pending key", ledger: {
    settledAttempts: [reserved], pendingKeys: [key] }, expected: "incomplete" },
  { name: "pending key without a physical reservation", ledger: { pendingKeys: [key] }, expected: "pending" },
  { name: "pending key remains pending with a shard", ledger: {
    pendingKeys: [key], settledAttempts: [reserved] }, raws: [1], shardPresent: true, expected: "pending" },
  { name: "published settled shard", ledger: { settledAttempts: [reserved] },
    raws: [1], shardPresent: true, expected: "settled" },
  { name: "other keys cannot change this key state", ledger: {
    unresolvedAttempts: [{ cacheKey: otherKey, attemptOrdinal: 2 }],
    settledAttempts: [{ cacheKey: otherKey, attemptOrdinal: 3 }],
    transportFailures: [{ ...failed, cacheKey: otherKey, attemptOrdinal: 3 }], pendingKeys: [otherKey] },
    expected: "settled" },
  { name: "invalid accounting does not change the shared physical state", ledger: {
    settledAttempts: [{ ...reserved, usageAccounting: "invalid" }] },
    raws: [1], shardPresent: true, expected: "settled" }
];

it.each(cases)("projects $name as $expected", ({ ledger, raws = [], shardPresent = false, expected }) => {
  const snapshot = ledger === null ? undefined : { ...empty, ...ledger };
  const before = structuredClone(snapshot);
  expect(classifyRetainedExtractionAttemptState(snapshot, key, raws, shardPresent)).toBe(expected);
  expect(snapshot).toEqual(before);
});
