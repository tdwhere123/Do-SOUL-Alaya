import { afterAll, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => boundary.restore());
import { INPUT_NAVIGATION_POLICY } from "../../../runs/source-access-diagnostic/input-condition-formation.js";
import { solveConditionalNavigation, NAVIGATION_CONTRACT, type NavigationCondition,
  type NavigationInput, type NavigationOccurrence } from "../../../runs/source-access-diagnostic/conditional-navigation.js";

const condition = (id: string, status: NavigationCondition["status"] = "ready"): NavigationCondition =>
  ({ id, object: "same-target", hypothesis: "input-hypothesis", query: id, status,
    residual: status === "partial" ? "unresolved input fragment" : null, provenance: "authored-mechanism-fixture" });
const pool = ["a", "b", "c", "tail"].map((record_id, catalog_position) => ({ record_id, catalog_position }));
const hit = (condition: string, channel: NavigationOccurrence["channel"], record_id: string, native_rank: number): NavigationOccurrence =>
  ({ condition, channel, record_id, native_rank, reference: `${condition}:${channel}:${native_rank}`, root_key: `root:${record_id}` });
const fixture = (): NavigationInput => ({ original: "original", conditions: [condition("original")], branches: [], pool,
  occurrences: [hit("original", "lexical", "c", 8), hit("original", "lexical", "b", 40), hit("original", "vector", "a", 22)] });

describe("private navigation coordinate", () => {
  it("matches native C with rank gaps, duplicate roots, unequal lanes and a catalog tail", () => {
    const input = fixture();
    const result = solveConditionalNavigation({ ...input, occurrences: [...input.occurrences, hit("original", "vector", "c", 90)] });
    expect(result.rows.map(row => row.record_id)).toEqual(["c", "a", "b", "tail"]);
    expect(result.rows.map(row => row.navigation.tier)).toEqual([1024, 1023, 1022, null]);
    expect(result.native_single_condition).toEqual(["c", "a", "b", "tail"]);
    expect(result.single_condition_equivalent).toBe(true);
    expect(result.rows.every(row => row.read.status === "unobserved" && row.conditional_support.status === "unknown")).toBe(true);
  });

  it("takes max across operators, min across same-object conditions, and max with original", () => {
    const result = solveConditionalNavigation({ ...fixture(), conditions: [condition("original"), condition("red"), condition("round")],
      branches: [["red", "round"]], occurrences: [hit("original", "lexical", "tail", 2),
        hit("red", "lexical", "a", 1), hit("red", "lexical", "b", 2),
        hit("red", "vector", "b", 1), hit("round", "vector", "b", 7), hit("round", "vector", "a", 15)] });
    expect(result.rows.map(row => [row.record_id, row.navigation.tier])).toEqual([["tail", 1024], ["b", 1023], ["a", 1021], ["c", null]]);
    expect(result.assessments.find(row => row.record_id === "a" && row.conditions.length === 2)).toMatchObject({ status: "known", tier: 1021 });
  });

  it.each(["unknown", "unsupported", "rejected"] as const)("preserves %s without treating it as measured-low or erasing original", status => {
    const result = solveConditionalNavigation({ ...fixture(), conditions: [condition("original"), condition("missing", status)],
      branches: [["original", "missing"]] });
    expect(result.rows.map(row => row.record_id)).toEqual(["c", "a", "b", "tail"]);
    expect(result.assessments.filter(row => row.conditions.length === 2).every(row => row.status === status && row.tier === null)).toBe(true);
    expect(result.assessments.find(row => row.record_id === "b" && row.conditions.length === 1)).toMatchObject({ status: "known", tier: 1022 });
  });

  it("retains partial meaning and an unobserved required condition without inventing a conjunction", () => {
    const result = solveConditionalNavigation({ ...fixture(), conditions: [condition("original", "partial"), condition("other")],
      branches: [["original", "other"]] });
    expect(result.assessments.find(row => row.record_id === "c" && row.conditions.length === 1)).toMatchObject({ status: "partial", tier: 1024 });
    expect(result.assessments.find(row => row.record_id === "c" && row.conditions.length === 2)).toMatchObject({ status: "unknown", tier: null });
  });

  it("uses captured catalog positions for cross-branch ties and does not promise top-k preservation", () => {
    const result = solveConditionalNavigation({ ...fixture(), conditions: [condition("original"), condition("extra")], branches: [["extra"]],
      occurrences: [hit("original", "lexical", "c", 1), hit("extra", "lexical", "a", 100)] });
    expect(result.rows.map(row => row.record_id)).toEqual(["a", "c", "b", "tail"]);
    expect(result.native_single_condition[0]).toBe("c");
  });

  it("keeps different comparison objects in separate branches and rejects their conjunction", () => {
    const input = { ...fixture(), conditions: [condition("original"), { ...condition("other"), object: "compared-object" }] };
    expect(() => solveConditionalNavigation({ ...input, branches: [["original", "other"]] })).toThrow(/different compared objects/u);
    expect(() => solveConditionalNavigation({ ...input, branches: [["other"]] })).not.toThrow();
  });

  it("rejects ambiguous native ranks and nonmember identities", () => {
    const input = fixture();
    expect(() => solveConditionalNavigation({ ...input, occurrences: [...input.occurrences, hit("original", "lexical", "a", 8)] })).toThrow();
    expect(() => solveConditionalNavigation({ ...input, occurrences: [hit("original", "lexical", "outside", 1)] })).toThrow(/membership/u);
  });

  it("bounds representation before full-data use", () => {
    const conditions = [condition("original"), condition("one"), condition("two"), condition("three")];
    const members = Array.from({ length: 64 }, (_, i) => ({ record_id: String(i), catalog_position: i }));
    const result = solveConditionalNavigation({ original: "original", conditions, pool: members,
      branches: [["one", "two", "three"]], occurrences: conditions.flatMap(item => members.map((row, i) => hit(item.id, "lexical", row.record_id, i + 1))) });
    expect(result.solver.nodes).toBe(7 * 64);
    expect(result.solver.edges).toBe(384);
    expect(result.rows.map(row => row.record_id)).toEqual(members.map(row => row.record_id));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024);
  });
});

it.each([
  { originalId: "original", captureIds: ["original", "formed-0", "formed-1"] },
  { originalId: "formed-0", captureIds: ["formed-0", "formed-1", "formed-2"] },
  { originalId: "formed-1", captureIds: ["formed-1", "formed-0", "formed-2"] }
])("runs the real SQLite executable preserving original identity $originalId", { timeout: 90_000 }, async ({ originalId, captureIds }) => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { prepareNativeSourceRecordsSnapshot } = await import("../../../runs/snapshot/source-records/native.js");
  const { StorageDatabase, SqliteSourceIndexRepository } = await import("@do-soul/alaya-storage");
  const { fieldContractSha256 } = await import("@do-soul/alaya-core");
  const { sourceIndexTarget } = await import("@do-soul/alaya-protocol");
  const { default: Database } = await import("better-sqlite3");
  const { navigationFileDigest } = await import("../../../runs/source-access-diagnostic/conditional-navigation-run.js");
  const root = mkdtempSync(join(tmpdir(), "conditional-navigation-"));
  try {
    const snapshot = await prepareNativeSourceRecordsSnapshot({ snapshotPath: join(root, "input.sqlite"), dataDirRoot: join(root, "publish"),
      workspaceId: "navigation-fixture", runId: "navigation-fixture", producerCommit: "a".repeat(40),
      sources: ["cedar box blue stone", "red stone oak box"].map((content_bytes, i) => ({ source_id: `source-${i}`, source_version: "1", title: `Source ${i}`,
        content_bytes, source_observed_at: "2026-09-21T00:00:00.000Z", recorded_at: "2026-09-21T00:00:00.000Z" })) });
    const connection = new Database(snapshot.snapshot_path);
    const database = new StorageDatabase(snapshot.snapshot_path, connection);
    const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
    const { SqliteFieldSourceRecordRepo } = await import("@do-soul/alaya-storage");
    for (const record of new SqliteFieldSourceRecordRepo(database, fieldContractSha256).listByWorkspace(snapshot.workspace_id)) {
      const source = sourceIndexTarget({ kind: "source_evidence", workspace_id: record.workspace_id, root_kind: "source_record",
        root_id: record.record_id, source_version: record.source_version, content_digest: record.content_digest,
        evidence_object_id: record.evidence_object_id }, record.source_id, Buffer.byteLength(record.source_body!));
      expect(repository.writeLexical(source, record.source_body!, { work: 1_000_000, native_bytes: 1_000_000 }).status).toBe("accepted");
    }
    database.close({ optimize: false });
    // Empty companions are a lawful sealed family, not evidence of an active writer.
    writeFileSync(snapshot.snapshot_path + "-wal", ""); writeFileSync(snapshot.snapshot_path + "-shm", "");
    const digest = navigationFileDigest(snapshot.snapshot_path);
    const config = { contract: NAVIGATION_CONTRACT, source_revision: "authored-boundary-fixture", channels: "lexical", cache_root: root,
      rows: [{ ordinal: 1, question_id: "fixture", snapshot: snapshot.snapshot_path, snapshot_sha256: digest,
        workspace: snapshot.workspace_id, interpretation_clock: "2026-09-22T00:00:00.000Z", authorized_scopes: ["project"], expected_index: null,
        original: originalId, conditions: [{ ...condition(originalId), query: "blue stone" }], branches: [] }] };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    const cli = fileURLToPath(new URL("../../../../dist/runs/source-access-diagnostic/conditional-navigation-launch.js", import.meta.url));
    const preload = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/local-onnx-source-embedding-offline-preload.mjs", import.meta.url).href;
    const result = JSON.parse(execFileSync(process.execPath, ["--import", preload, cli, "--config", join(root, "config.json"), "--out", join(root, "out")],
      { encoding: "utf8", env: process.env }));
    expect(result).toMatchObject({ status: "complete", local_query_inputs: 0, external_calls: 0, index_builds: 0 });
    const output = JSON.parse(readFileSync(join(root, "out/001.json"), "utf8"));
    expect(output.solved.single_condition_equivalent).toBe(true);
    expect(output.windows[0].text).toBe("cedar box blue stone");
    expect(output.windows[0].read.status).toBe("complete");
    expect(navigationFileDigest(snapshot.snapshot_path)).toBe(digest);
    const formationInput = { question: "blue stone", reference_clock: config.rows[0]!.interpretation_clock };
    const modelCapture = { task: INPUT_NAVIGATION_POLICY, input: formationInput, state: "complete",
      raw_json: JSON.stringify({ status: "proposed", conditions: [
        { object: "target", hypothesis: "candidate", groups: [0], query: "red", residual: null },
        { object: "target", hypothesis: "candidate", groups: [0], query: "stone", residual: "unresolved modifier" }
      ], unresolved: ["unreviewed interpretation"] }), provenance: "authored-real-boundary", reason: null };
    const comparison = { ...config, comparison: { model: [{ ordinal: 1, capture: modelCapture }] } };
    writeFileSync(join(root, "comparison.json"), JSON.stringify(comparison));
    const run = (inputPath: string, out: string) => JSON.parse(execFileSync(process.execPath,
      ["--import", preload, cli, "--config", inputPath, "--out", out], { encoding: "utf8", env: process.env }));
    const compared = run(join(root, "comparison.json"), join(root, "compared"));
    expect(compared).toMatchObject({ status: "complete", local_query_inputs: 3, acquisition_cache_hits: 1 });
    const multi = JSON.parse(readFileSync(join(root, "compared/001-model.json"), "utf8"));
    expect(multi.captures.map((item: { condition: string }) => item.condition)).toEqual(captureIds);
    expect(multi.solved.assessments.some((item: { conditions: string[]; status: string }) => item.conditions.length === 2 && item.status === "partial")).toBe(true);
    expect(multi.solved.assessments.some((item: { conditions: string[]; tier: number | null }) => item.conditions[0] === originalId && item.tier !== null)).toBe(true);
    expect(multi.windows.every((window: { text: string }) => ["cedar box blue stone", "red stone oak box"].includes(window.text))).toBe(true);
    const original = JSON.parse(readFileSync(join(root, "compared/001-original.json"), "utf8"));
    expect(original.windows).toEqual(output.windows);
    const { kind: _kind, evidence_object_id: _evidence, ...goldTarget } = original.windows[0].target;
    writeFileSync(join(root, "gold.json"), JSON.stringify({ rows: [{ arm: "C", visibility: { gold_messages: { annotated: 1, complete: true },
      messages: [{ session_index: 0, message_index: 0, source_id: original.windows[0].source_id, target: goldTarget,
        start: 0, end: Buffer.byteLength(original.windows[0].text) }] } }] }));
    writeFileSync(join(root, "labels.json"), JSON.stringify([{ ordinal: 1, path: join(root, "gold.json") }]));
    const evaluated = JSON.parse(execFileSync(process.execPath, ["--import", preload, cli, "--evaluate", join(root, "compared"),
      "--labels", join(root, "labels.json"), "--out", join(root, "evaluation.json")], { encoding: "utf8", env: process.env }));
    expect(evaluated.map((item: { status: string }) => item.status)).toEqual(["scored", "scored", "scored"]);
    const malformed = { ...comparison, comparison: { model: [{ ordinal: 1, capture: { ...modelCapture, raw_json: "not-json" } }] } };
    writeFileSync(join(root, "malformed.json"), JSON.stringify(malformed));
    expect(run(join(root, "malformed.json"), join(root, "malformed")).rows[2].status).toBe("formation_malformed");
    // Authored fixtures only: unavailable model arms must never score the preserved original as a fallback.
    for (const [status, state] of [["cannot_propose", "declined"], ["unsupported", "unsupported"]]) {
      const name = `unusable-${state}`;
      writeFileSync(join(root, `${name}.json`), JSON.stringify({ ...config, comparison: { model: [{ ordinal: 1,
        capture: { ...modelCapture, raw_json: JSON.stringify({ status, conditions: [], unresolved: ["Authored unusable input."] }) } }] } }));
      const unavailable = run(join(root, `${name}.json`), join(root, name));
      expect(unavailable.rows.map((row: { status: string }) => row.status)).toEqual(["complete", "complete", `formation_${state}`]);
      expect(unavailable.local_query_inputs).toBe(1);
      const formations = JSON.parse(readFileSync(join(root, name, "formations.json"), "utf8"));
      expect(formations[0].arms[2].formation).toMatchObject({ state, available: false, conditions: [], branches: [] });
      expect(JSON.parse(readFileSync(join(root, name, "001-original.json"), "utf8")).windows).toEqual(output.windows);
      const { evaluateConditionalNavigation } = await import("../../../runs/source-access-diagnostic/conditional-navigation-evaluate.js");
      const evaluation = evaluateConditionalNavigation(join(root, name), join(root, "labels.json"), join(root, `${name}-evaluation.json`));
      expect(evaluation.rows[2]).toMatchObject({ status: `formation_${state}`, visibility: null, visible_utf8_bytes: null });
      expect(evaluation.summary[2]).toMatchObject({ status: "unavailable", denominator: 1, metrics: null, paired: null });
      expect(evaluation.summary[0]).toMatchObject({ status: "scored", denominator: 1 });
    }
    const { runNavigationProposals } = await import("../../../runs/source-access-diagnostic/conditional-navigation-propose.js");
    const proposals = await runNavigationProposals({ source_revision: "authored-unresolved-chain", rows: [{ ordinal: 1, input: formationInput }] },
      join(root, "unknown-provider"), { model: "step-3.5-flash-2603", providerUrl: "https://api.stepfun.com/v1",
        requestProfile: "step-3.5-2603-low-json-schema-v1", apiKey: "authored-local-test-auth" },
      { extract: async () => { throw new Error("authored missing raw after reservation"); } });
    const unknownCapture = proposals.captures[0]!;
    writeFileSync(join(root, "unknown.json"), JSON.stringify({ ...config, comparison: { model: [unknownCapture] } }));
    const unknown = run(join(root, "unknown.json"), join(root, "unknown"));
    expect(unknown.rows[2].status).toBe("formation_unknown");
    const formations = JSON.parse(readFileSync(join(root, "unknown/formations.json"), "utf8"));
    expect(formations[0].arms[2].formation).toMatchObject({ state: "unknown", available: false,
      capture: { raw_json: null, reason: "authored missing raw after reservation" } });
    expect(proposals.cost.unknown_usage_attempts).toBe(1);
    expect(proposals.cost.outstanding_maximum_cny).toBeGreaterThan(0.15);
    expect(JSON.parse(readFileSync(join(root, "unknown/001-original.json"), "utf8")).windows).toEqual(output.windows);
    const drift = { ...comparison, comparison: { model: [{ ordinal: 1, capture: { ...modelCapture,
      input: { ...formationInput, question: "changed-after-authorization" } } }] } };
    writeFileSync(join(root, "drift.json"), JSON.stringify(drift));
    expect(() => run(join(root, "drift.json"), join(root, "drift"))).toThrow();
    const late = { ...comparison, rows: [...comparison.rows, { ...comparison.rows[0], ordinal: 2, question_id: "late-failure", snapshot_sha256: "0".repeat(64) }] };
    writeFileSync(join(root, "late.json"), JSON.stringify(late));
    expect(() => run(join(root, "late.json"), join(root, "late"))).toThrow();
    const { evaluateConditionalNavigation } = await import("../../../runs/source-access-diagnostic/conditional-navigation-evaluate.js");
    writeFileSync(join(root, "late-labels.json"), JSON.stringify([1, 2].map(ordinal => ({ ordinal, path: join(root, "gold.json") }))));
    const lateEvaluation = evaluateConditionalNavigation(join(root, "late"), join(root, "late-labels.json"), join(root, "late-evaluation.json"));
    expect(lateEvaluation.rows[0]!.visibility).not.toBeNull();
    expect(lateEvaluation.rows.filter(row => row.ordinal === 2).map(row => [row.status, row.visibility]))
      .toEqual(Array.from({ length: 3 }, () => ["selection_not_captured", null]));
    expect(lateEvaluation.summary.every(arm => arm.denominator === 2 && arm.metrics === null)).toBe(true);
    // Even a later capture's drift must fail admission before label access.
    writeFileSync(join(root, "compared/001-model.json"), "{}");
    expect(() => evaluateConditionalNavigation(join(root, "compared"), join(root, "labels-must-not-be-opened"), join(root, "drift-evaluation.json"))).toThrow(/digest drift/u);
    expect(navigationFileDigest(snapshot.snapshot_path)).toBe(digest);
    const denied = { ...config, rows: config.rows.map(row => ({ ...row, authorized_scopes: [] })) };
    writeFileSync(join(root, "denied.json"), JSON.stringify(denied));
    const empty = JSON.parse(execFileSync(process.execPath, ["--import", preload, cli, "--config", join(root, "denied.json"), "--out", join(root, "denied")],
      { encoding: "utf8", env: process.env }));
    expect(empty.status).toBe("complete");
    expect(JSON.parse(readFileSync(join(root, "denied/001.json"), "utf8")).windows).toEqual([]);
    writeFileSync(snapshot.snapshot_path + "-wal", "nonempty-unreconciled-family");
    const stopped = join(root, "stopped");
    expect(() => execFileSync(process.execPath, ["--import", preload, cli, "--config", join(root, "config.json"), "--out", stopped],
      { encoding: "utf8", env: process.env, stdio: "pipe" })).toThrow();
    expect(JSON.parse(readFileSync(join(stopped, "receipt.json"), "utf8"))).toMatchObject({ status: "stopped", local_query_inputs: 0,
      failure: "sealed export has nonempty -wal; reuse requires reconciliation" });
    expect(navigationFileDigest(snapshot.snapshot_path)).toBe(digest);
    expect(() => execFileSync(process.execPath, ["--import", preload, cli, "--config", join(root, "config.json"), "--out", join(root, "out")],
      { encoding: "utf8", env: process.env, stdio: "pipe" })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
