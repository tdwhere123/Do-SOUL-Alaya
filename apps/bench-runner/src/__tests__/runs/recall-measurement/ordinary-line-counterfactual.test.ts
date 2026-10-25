import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { hashAddressableSourceSpanId, hashContentDigest, hashSourceRecordId,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID, sourceGoldRootIdentity } from "@do-soul/alaya-protocol";
import { initDatabase, openReadOnlyDatabase, SqliteFieldSourceRecordRepo, SqliteFieldSourceSpanRepo, SqliteWorkspaceRepo } from "@do-soul/alaya-storage";
import { packOrdinaryLinePreviews, readOrdinaryLineFacts, scoreOrdinaryLineCounterfactual as scorePreviews }
  from "../../../runs/recall-measurement/ordinary/ordinary-line-counterfactual.js";
import { ordinaryLiteralWindows, type OrdinaryLiteralWindow, type OrdinarySourcePreview }
  from "../../../runs/recall-measurement/ordinary/ordinary-preview-stream.js";
import type { AnswerTurnGold } from "../../../runs/longmemeval-semantic/answer-spans.js";
import type { ConsumerVisibilityInput, ConsumerVisibilityPage } from "../../../runs/longmemeval-semantic/message-visibility.js";

const literalPreviews = (windows: readonly OrdinaryLiteralWindow[]): OrdinarySourcePreview[] =>
  windows.map(({ start, end, ...preview }) => ({ ...preview, source: { status: "literal", start, end } }));
const scoreOrdinaryLineCounterfactual = (input: ConsumerVisibilityInput & {
  windows: readonly OrdinaryLiteralWindow[]; line_facts: ReturnType<typeof readOrdinaryLineFacts>;
}) => scorePreviews({ ...input, previews: literalPreviews(input.windows) });
const databases: ReturnType<typeof initDatabase>[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const clock = "2026-10-25T00:00:00.000Z";
async function database(filename = ":memory:") {
  const value = initDatabase({ filename }); databases.push(value);
  await new SqliteWorkspaceRepo(value).create({ workspace_id: "workspace", name: "workspace", root_path: "/tmp/line-counterfactual",
    workspace_kind: "local_repo", default_engine_binding: null, default_engine_class: "conversation_engine", workspace_state: "active" });
  return value;
}
function seed(db: Awaited<ReturnType<typeof database>>, source: string, rank: number, text: string,
  ends: readonly number[], purpose: "line" | "sentence" = "line"): OrdinaryLiteralWindow {
  const content_digest = hashContentDigest(text, fieldContractSha256);
  const identity = { source_id: source, source_version: "v1", content_digest };
  const record_id = hashSourceRecordId(identity, fieldContractSha256);
  new SqliteFieldSourceRecordRepo(db, fieldContractSha256).insert({ ...identity, record_id, workspace_id: "workspace",
    evidence_object_id: null, recorded_at: clock, event_time: null, valid_from: null, valid_to: null,
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID, source_body: text, speaker: null, scope_class: "project", attribution_context: null });
  let start = 0;
  for (const end of ends) {
    const span = { record_id, start_offset: start, end_offset: end, purpose, producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID };
    new SqliteFieldSourceSpanRepo(db, fieldContractSha256).insert({ ...span, workspace_id: "workspace", recorded_at: clock,
      span_id: hashAddressableSourceSpanId(span, fieldContractSha256) });
    start = end;
  }
  return { rank, start: 0, end: Buffer.byteLength(text), text, target: { workspace_id: "workspace", root_kind: "source_record",
    root_id: record_id, source_version: "v1", content_digest } };
}
const page = (windows: readonly OrdinaryLiteralWindow[]): ConsumerVisibilityPage => ({ page: 1, status: "observed",
  reason: null, occupied_slots: windows.at(-1)?.rank ?? 0, complete: true, continuation: "none",
  terminal_tail: { status: "exhausted", reason: "fixture" }, intervals: windows.map(({ text: _text, ...window }) => window) });
const gold = (windows: readonly OrdinaryLiteralWindow[]): AnswerTurnGold => ({ unit: "published_body_utf8_bytes",
  annotated_turns: windows.length, complete: true, spans: windows.map((window, index) => ({ session_index: 0,
    message_index: index, source_id: window.target.root_id, target: window.target, start: window.start, end: window.end })) });
const key = (window: OrdinaryLiteralWindow) => sourceGoldRootIdentity({ ...window.target, kind: "source_evidence", evidence_object_id: null });
const unit = (root: string, rank: number, text: string): OrdinaryLiteralWindow => ({ rank, text, start: 0,
  end: Buffer.byteLength(text), target: { workspace_id: "fixture", root_kind: "source_record", root_id: root,
    source_version: "1", content_digest: `sha256:${"a".repeat(64)}` } });

it("reads recorded SQLite boundaries and reports a non-monotone aligned hit/miss/hit without thresholds", async () => {
  const db = await database(), windows = [seed(db, "long", 1, "a".repeat(4096), [2000, 4096]), seed(db, "evidence", 3, "b".repeat(48), [48])];
  const line_facts = readOrdinaryLineFacts(db, windows.map(window => window.target));
  const result = scoreOrdinaryLineCounterfactual({ windows, pages: [page(windows)], line_facts, gold: gold([windows[1]!]) });
  expect(result.status).toBe("available");
  expect(result.budgets.map(row => [row.prefix.any_at_budget.status, row.aligned.any_at_budget.status]))
    .toEqual([["miss", "hit"], ["miss", "miss"], ["hit", "hit"]]);
  expect(result.budgets[0]!.aligned.intervals.map(window => [window.rank, window.end])).toEqual([[1, 2000], [3, 48]]);
  expect(result.premise).toMatchObject({ annotated: 1, on_boundary: 1, off_boundary: 0, exact_rate: 1 });
  expect(result).not.toHaveProperty("first_hit_byte");
  const changedLabels = scoreOrdinaryLineCounterfactual({ windows, pages: [page(windows)], line_facts, gold: gold([windows[0]!]) });
  expect(changedLabels.budgets.map(row => row.aligned.intervals)).toEqual(result.budgets.map(row => row.aligned.intervals));
});

it("reads an on-disk snapshot through the read-only owner without changing its database bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-line-facts-")); directories.push(root);
  const filename = join(root, "snapshot.db"), db = await database(filename);
  const window = seed(db, "source", 1, "literal", [7]);
  db.connection.pragma("wal_checkpoint(TRUNCATE)"); db.close(); databases.splice(databases.indexOf(db), 1);
  const before = readFileSync(filename);
  const readonly = openReadOnlyDatabase(filename); databases.push(readonly);
  expect(readOrdinaryLineFacts(readonly, [window.target])[0]).toMatchObject({ status: "available", ends: [7] });
  expect(() => readonly.connection.prepare("DELETE FROM source_spans").run()).toThrow();
  expect(readFileSync(filename)).toEqual(before);
});

it("uses only line facts and retains prefix when no positive recorded boundary fits", async () => {
  const db = await database(), windows = [seed(db, "line-free", 1, "a".repeat(2047) + "京", [2050], "sentence"),
    seed(db, "later", 2, "x", [])];
  const line_facts = readOrdinaryLineFacts(db, windows.map(window => window.target));
  expect(line_facts.every(fact => fact.status === "available" && fact.ends.length === 0)).toBe(true);
  const result = scoreOrdinaryLineCounterfactual({ windows, pages: [page(windows)], line_facts, gold: gold([windows[1]!]) });
  expect(result.budgets[0]!.aligned.source_utf8_bytes).toBe(2047);
  expect(result.budgets[0]!.aligned.any_at_budget.status).toBe("miss");
  expect(result.premise.off_boundary).toBe(1);
});

it("keeps source identity mismatch and unreadable metadata distinct from a valid empty boundary set", async () => {
  const db = await database(), window = seed(db, "source", 1, "literal", []);
  const mismatch = readOrdinaryLineFacts(db, [{ ...window.target, source_version: "other" }]);
  expect(mismatch[0]).toMatchObject({ status: "unavailable", reason: "line_source_identity_unavailable" });
  db.connection.exec("DROP TABLE source_spans");
  const line_facts = readOrdinaryLineFacts(db, [window.target]);
  expect(line_facts[0]?.status).toBe("unavailable");
  const result = scoreOrdinaryLineCounterfactual({ windows: [window], pages: [page([window])], line_facts, gold: gold([window]) });
  expect(result.budgets[0]!.prefix.any_at_budget.status).toBe("hit");
  expect(result.budgets[0]!.aligned.any_at_budget.status).toBe("unknown");
  expect(result.premise.exact_rate).toBeNull();
});

it("rejects persisted boundary identity drift and refuses nonzero payload offsets", async () => {
  const db = await database(), window = seed(db, "source", 1, "literal", [7]);
  const line_facts = readOrdinaryLineFacts(db, [window.target]);
  const offset = { ...window, start: 2, end: 9 };
  const result = scoreOrdinaryLineCounterfactual({ windows: [offset], pages: [page([offset])], line_facts, gold: gold([offset]) });
  expect(result.reason).toBe("counterfactual_requires_source_zero_prefixes");
  expect(result.budgets[0]!.aligned.any_at_budget.status).toBe("unknown");
  db.connection.prepare("UPDATE source_spans SET end_offset = 6").run();
  expect(readOrdinaryLineFacts(db, [window.target])[0]).toMatchObject({ status: "unavailable", reason: "line_metadata_invalid" });
});

it("retains unknown premise rates for unmapped or unavailable annotated messages", async () => {
  const db = await database(), window = seed(db, "source", 1, "literal", [7]);
  const result = scoreOrdinaryLineCounterfactual({ windows: [window], pages: [page([window])],
    line_facts: readOrdinaryLineFacts(db, [window.target]), gold: { ...gold([window]), annotated_turns: 2, complete: false } });
  expect(result.premise).toMatchObject({ annotated: 2, on_boundary: 1, unmapped: 1, exact_rate: null });
});

it("keeps a miss unknown when alignment reaches an uncaptured tail below the captured raw byte total", async () => {
  const db = await database(), window = seed(db, "source", 1, "a".repeat(4096), [2000, 4096]);
  const open: ConsumerVisibilityPage = { ...page([window]), continuation: "present", terminal_tail: { status: "open", reason: "fixture" } };
  const result = scoreOrdinaryLineCounterfactual({ windows: [window], pages: [open], gold: gold([unit("absent", 2, "x")]),
    line_facts: readOrdinaryLineFacts(db, [window.target]) });
  expect(result.budgets[0]!.prefix.any_at_budget.status).toBe("miss");
  expect(result.budgets[0]!.aligned.any_at_budget.status).toBe("unknown");
  expect(result.budgets[1]!.aligned.any_at_budget.status).toBe("miss");
});

it("preserves every prefix-visible boundary-ended evidence interval over generated finite units", () => {
  let checked = 0;
  for (let n = 1; n <= 8; n++) for (let m = 1; m <= 4; m++) for (let boundaryEnd = 1; boundaryEnd <= n; boundaryEnd++) {
    const windows = [unit("one", 1, "a".repeat(n)), unit("two", 2, "b".repeat(m))];
    const ends = new Map([[key(windows[0]!), [boundaryEnd, n]], [key(windows[1]!), [m]]]);
    for (let budget = 0; budget <= n + m; budget++) {
      const packed = ordinaryLiteralWindows(packOrdinaryLinePreviews(literalPreviews(windows), ends, budget).previews);
      const first = packed.find(window => window.rank === 1)?.end ?? 0;
      const second = packed.find(window => window.rank === 2)?.end ?? 0;
      if (budget >= boundaryEnd) expect(first).toBeGreaterThanOrEqual(boundaryEnd);
      if (budget >= n + m) expect(second).toBe(m);
      expect(packed.reduce((bytes, window) => bytes + Buffer.byteLength(window.text), 0)).toBeLessThanOrEqual(budget);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(1000);
});
