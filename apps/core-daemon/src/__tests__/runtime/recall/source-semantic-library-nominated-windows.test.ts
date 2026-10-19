import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashLabeledIdentity, SourceSemanticResourceExhausted, type IndexEntry } from "@do-soul/alaya-protocol";
import { createAuditedSourceAdmission, fieldContractSha256, sourceGoldRootIdentity,
  sourceSemanticLibrarySourceEntry } from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteFieldEraseBarrierRepo } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { prepareLibraryPackages } from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import { prepareNominatedLibraryWindows, type LibrarySourceNomination }
  from "../../../runtime/recall-read-worker/source-semantic-library-nominated-windows.js";
import type { SourceSemanticWorkerPayload } from "../../../runtime/recall-read-worker/source-semantic-discovery.js";
import { ACCESS_BUDGET, CLOCK, WS } from "./source-semantic-access.test-support.js";

const CONDITION = "Unless the permit is paused, ", ANSWER = "the harbor opens on Tuesday";
const BODY = `${"x".repeat(8192)}${CONDITION}${ANSWER}.${"尾😀".repeat(500)}`;
const digest = (value: string) => `sha256:${fieldContractSha256(value)}`;

// Explicit nominations exercise the retained utility, not a public recall feeder or model.
async function windowContext(bodies: readonly string[] = [BODY]) {
  const directory = await mkdtemp(join(tmpdir(), "library-nominated-windows-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const close = async () => {
    database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
  };
  try {
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
      eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
    });
    const sources: IndexEntry[] = [];
    for (const [index, body] of bodies.entries()) {
      const { record } = await admission.admit({ workspace_id: WS, source_id: `source-${index}`, source_version: "1",
        content_bytes: body, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
        speaker: "user", scope_class: "project", evidence_object_id: null, spans: [] }, { workspaceId: WS });
      sources.push(sourceSemanticLibrarySourceEntry({ workspaceId: WS, root_id: record.identity,
        source_version: record.source_version, content_digest: record.content_digest,
        evidence_object_id: record.evidence_object_id, hypothesis_id: "source-navigation" }));
    }
    const nomination = (start: number, end: number, index = 0): LibrarySourceNomination => {
      const target = sources[index]!.target;
      if (target.kind !== "source_evidence") throw new Error("source fixture target required");
      return { source: { root_key: sourceGoldRootIdentity(target), source_id: `source-${index}`, target,
        body_bytes: Buffer.byteLength(bodies[index]!) }, lexical: [], vector: { rank: index + 1, cosine: 1,
        window: { window_id: digest(`window-${index}`), start_byte: start, end_byte: end,
          content_digest: digest(Buffer.from(bodies[index]!).subarray(start, end).toString("utf8")) } } };
    };
    const runtime = createRecallReadWorkerRuntime(database);
    const payload: SourceSemanticWorkerPayload = { workspace_id: WS, as_of: CLOCK,
      authorized_scopes: { mode: "named", scopes: ["project"] }, request: { kind: "recall",
        original_query: "Locate retained source intervals", accepts_unreviewed_conditional_results: true,
        budget: ACCESS_BUDGET, output_byte_limit: 300_000 } };
    const hydrate = (nominations: readonly LibrarySourceNomination[]) => database.connection.transaction(() =>
      prepareNominatedLibraryWindows(runtime, payload, ["project"], new SourceSemanticReadBudget(ACCESS_BUDGET), sources, nominations))();
    return { database, runtime, payload, sources, nomination, hydrate, close };
  } catch (error) { await close(); throw error; }
}

it("hydrates exact non-prefix source bytes without a proof and preserves ordered duplicate windows at the first root alias", async () => {
  const context = await windowContext();
  try {
    const end = 8192 + Buffer.byteLength(CONDITION + ANSWER);
    const [window] = context.hydrate([context.nomination(8192, end)]);
    expect(window!.preview).toBe(CONDITION + ANSWER);
    expect(window!.entry.target).toMatchObject({ span: { content_start: 8192, content_end: end, content_complete: false } });
    expect(window!.proofs).toEqual([]);
    expect(window!.payload_support).toBe("not_applicable");
    const source = context.sources[0]!;
    const variants = prepareNominatedLibraryWindows(context.runtime, context.payload, ["project"],
      new SourceSemanticReadBudget(ACCESS_BUDGET), [source, { ...source, hypothesis_id: "source-alias" }],
      [context.nomination(8200, 8230), context.nomination(8192, 8220), context.nomination(8200, 8230)]);
    expect(variants.map(row => row.entry.target.kind === "source_evidence" && row.entry.target.span!.content_start))
      .toEqual([8200, 8192, 8200]);
    expect(variants.every(row => row.access_position === 0 && row.entry.hypothesis_id === source.hypothesis_id)).toBe(true);
    expect(variants[0]).not.toBe(variants[2]);
    for (const row of variants) {
      if (row.entry.target.kind !== "source_evidence") throw new Error("source window expected");
      const span = row.entry.target.span!;
      expect(row.preview).toBe(Buffer.from(BODY).subarray(span.content_start, span.content_end).toString("utf8"));
    }
  } finally { await context.close(); }
});

it("rejects changed tuples, logical-source substitution, digest, scope and erased bytes rather than redirecting", async () => {
  const context = await windowContext();
  try {
    const nomination = context.nomination(8192, 8230);
    expect(nomination.source.target.root_id).not.toBe(nomination.source.source_id);
    for (const change of [{ source_version: "wrong" }, { root_id: nomination.source.source_id }, { content_digest: digest("wrong body") }]) {
      const target = { ...nomination.source.target, ...change };
      expect(() => context.hydrate([{ ...nomination, source: { ...nomination.source, target, root_key: sourceGoldRootIdentity(target) } }]))
        .toThrow(/source pool/u);
    }
    expect(() => context.hydrate([{ ...nomination, source: { ...nomination.source, source_id: "other" } }]))
      .toThrow(/current source record/u);
    expect(() => context.hydrate([{ ...nomination, vector: { ...nomination.vector!, window: {
      ...nomination.vector!.window, content_digest: digest("wrong window") } } }])).toThrow(/window digest/u);
    expect(() => prepareNominatedLibraryWindows(context.runtime, context.payload, [], new SourceSemanticReadBudget(ACCESS_BUDGET),
      context.sources, [nomination])).toThrow(/authorized scopes/u);
    const id = nomination.source.target.root_id;
    new SqliteFieldEraseBarrierRepo(context.database, fieldContractSha256).apply({
      identity: hashLabeledIdentity("erase_barrier", [WS, "source_record", id, ""], fieldContractSha256),
      barrier_id: "erase-nominated-source", workspace_id: WS, generation_id: null,
      subject_kind: "source_record", subject_id: id, erased_at: CLOCK
    });
    expect(() => context.hydrate([nomination])).toThrow(/unavailable|current source record/u);
  } finally { await context.close(); }
});

it("keeps missing locations absent, refuses oversized or split UTF-8 coordinates and discloses clipped context", async () => {
  const context = await windowContext();
  try {
    expect(context.hydrate([{ ...context.nomination(8192, 8230), vector: null }])).toEqual([]);
    expect(() => context.hydrate([context.nomination(4096, 8193)])).toThrow(/display bounds/u);
    const emoji = Buffer.byteLength(BODY.slice(0, BODY.indexOf("😀")));
    expect(() => context.hydrate([context.nomination(emoji + 1, emoji + 4)])).toThrow(/unavailable|UTF-8/u);
    expect(() => context.hydrate([context.nomination(emoji, emoji + 3)])).toThrow(/unavailable|UTF-8/u);
    const start = 8000, end = Buffer.byteLength(BODY);
    const [clipped] = context.hydrate([context.nomination(start, end)]);
    expect(clipped!.preview).not.toContain("�");
    expect(Buffer.byteLength(clipped!.preview)).toBeLessThan(end - start);
    expect(clipped!.entry.target).toMatchObject({ span: { content_start: start,
      content_end: start + Buffer.byteLength(clipped!.preview), content_complete: false } });
    const answerStart = 8192 + Buffer.byteLength(CONDITION);
    const [withoutCondition] = context.hydrate([context.nomination(answerStart, answerStart + Buffer.byteLength(ANSWER))]);
    expect(withoutCondition!.preview).toBe(ANSWER);
    expect(withoutCondition!.preview).not.toContain(CONDITION);
    const [rootOnly] = context.hydrate([context.nomination(0, 100)]);
    expect(rootOnly!.preview).not.toContain(ANSWER);
    expect(rootOnly!.proofs).toEqual([]);
  } finally { await context.close(); }
});

it("hydrates indexed census windows within the remaining baseline allowance without mutating raw prefixes", async () => {
  const bodies = Array.from({ length: 475 }, (_, index) =>
    `${index.toString().padStart(4, "0")}:${String.fromCharCode(97 + index % 26).repeat((index < 16 ? 1216 : 1044) - 5)}`);
  const context = await windowContext(bodies);
  const allowance = { work_units: 1_533_996, memory_bytes: 8_740_785 };
  try {
    expect(bodies.reduce((sum, body) => sum + body.length, 0)).toBe(498_652);
    const nominations = Array.from({ length: 16 }, (_, index) => context.nomination(500 + index, 834 + index, index));
    // An explicit caller-supplied tuple index is input to this dormant utility, not new runtime wiring.
    const positions = new Map(context.sources.map((entry, position) => {
      if (entry.target.kind !== "source_evidence") throw new Error("source fixture target required");
      return [sourceGoldRootIdentity(entry.target), position];
    }));
    context.database.connection.transaction(() => {
      const meter = new SourceSemanticReadBudget(allowance);
      const baseline = prepareLibraryPackages(context.runtime, context.payload, ["project"], meter, context.sources, []);
      expect(baseline.incomplete).toBe(false);
      expect(baseline.packages).toHaveLength(475);
      expect(meter.spentWork).toBeGreaterThan(1_490_000);
      const before = baseline.packages.map(row => row.preview), prefixWork = meter.spentWork;
      const windows = prepareNominatedLibraryWindows(context.runtime, context.payload, ["project"], meter,
        context.sources, nominations, positions);
      expect(windows).toHaveLength(16);
      expect(baseline.packages.map(row => row.preview)).toEqual(before);
      for (const [position, row] of windows.entries()) {
        const start = 500 + position;
        expect(row.preview).toBe(bodies[position]!.slice(start, start + 334));
        expect(row.access_position).toBe(position);
        expect(row.proofs).toEqual([]);
      }
      expect(meter.spentWork - prefixWork).toBeLessThanOrEqual(35_092);
      expect(meter.spentWork).toBeLessThanOrEqual(allowance.work_units);
      expect(meter.spentBytes).toBeLessThanOrEqual(allowance.memory_bytes);
      expect(() => prepareNominatedLibraryWindows(context.runtime, context.payload, ["project"],
        new SourceSemanticReadBudget({ work_units: 1, memory_bytes: allowance.memory_bytes }),
        context.sources, nominations, positions)).toThrow(SourceSemanticResourceExhausted);
    })();
  } finally { await context.close(); }
}, 60_000);
