import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SoulMemorySearchRequestSchema, type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { restoreSnapshotToDataDir } from "../../../runs/snapshot/materialize.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { runSourceSemanticPublicationLauncher } from "../../../runs/snapshot/source-records/launch-publication.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";

const roots = new Set<string>();
const CLOCK = "2026-09-13T00:00:00.000Z";
const AS_OF = "2023-09-13T00:00:00.000Z";
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); roots.clear(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-records-publication-"));
  roots.add(root);
  const dataDir = join(root, "data");
  const pinnedMetaRoot = join(root, "meta");
  const cacheRoot = join(root, "cache");
  await mkdir(dataDir); await mkdir(pinnedMetaRoot); await mkdir(join(cacheRoot, "ab"), { recursive: true });
  const source = JSON.stringify([
    question("mixed-roles", [[{ role: "user", content: "A café source record." },
      { role: "assistant", content: "Noted the café source." }]]),
    question("repeated-text", [[{ role: "user", content: "Please note this. The cat sat. The cat sat. Done." }]]),
    question("absent-h", [[{ role: "user", content: "Unrelated distractor lives in Suzhou." }]])
  ]);
  await writeFile(join(dataDir, "longmemeval_s.json"), source);
  await writeFile(join(pinnedMetaRoot, "longmemeval_s.meta.json"), JSON.stringify({
    sha256: createHash("sha256").update(source).digest("hex"),
    size_bytes: Buffer.byteLength(source), question_count: 3
  }));
  await writeFile(join(cacheRoot, "ab", `${"f".repeat(64)}.json`), "{}");
  return { root, dataDir, pinnedMetaRoot, cacheRoot };
}

function question(id: string, sessions: { role: string; content: string }[][]) {
  return {
    question_id: id, question_type: "fixture", question: "What was recorded?", answer: "excluded gold",
    question_date: "2023/09/13 (Wed) 00:00", haystack_session_ids: sessions.map((_, index) => `${id}-session-${index}`),
    haystack_dates: sessions.map(() => "2023/09/12 (Tue) 00:00"), answer_session_ids: [`${id}-session-0`],
    haystack_sessions: sessions
  };
}

describe("complete-source census and publication", () => {
  it("keeps census and publication ownership out of the launcher", async () => {
    expect(await runSourceSemanticPublicationLauncher([])).toBe(2);
  });

  it("derives identity from the frozen dataset and keeps mixed roles", async () => {
    const f = await fixture();
    const census = await censusCompleteSourceRecords({
      population: "fixture", dataDir: f.dataDir, pinnedMetaRoot: f.pinnedMetaRoot
    });
    expect(census.records).toHaveLength(3);
    expect(census.records.map((row) => row.source_id).every((id) => !/^[a-f0-9]{64}$/u.test(id))).toBe(true);
    expect(census.records.map((row) => row.source_id).sort()).toEqual([
      "fixture:absent-h-s0-r0", "fixture:mixed-roles-s0-r0", "fixture:repeated-text-s0-r0"
    ].sort());
    expect(new Set(census.records.map((row) => row.source_version))).toEqual(new Set([census.dataset_sha256]));
    const mixed = census.records.find((row) => row.question_id === "mixed-roles")!;
    expect(mixed.speaker).toBeUndefined();
    expect(mixed.roles).toEqual(["user", "assistant"]);
    expect(new Set(mixed.units.map((unit) => unit.source_role))).toEqual(new Set(["user", "assistant"]));
    const repeated = census.records.find((row) => row.question_id === "repeated-text")!;
    expect(repeated.repeated_assertion_text).toBe(true);
    expect(repeated.speaker).toBe("user");
  });

  it("admits every census source when H is absent and keeps failed-H source retrieval", async () => {
    const f = await fixture();
    const report = await publishSourceSemanticSnapshot({
      snapshotPath: join(f.root, "library.sqlite"), dataDirRoot: join(f.root, "seed"),
      recordedAt: CLOCK, producerCommit: "a".repeat(40),
      populations: [{
        name: "fixture", dataDir: f.dataDir, pinnedMetaRoot: f.pinnedMetaRoot,
        cacheRoot: f.cacheRoot, model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1"
      }]
    });
    expect(report.census_count).toBe(3);
    expect(report.admitted_count).toBe(3);
    expect(report.rejected_count).toBe(0);
    expect(report.published_count).toBe(0);
    expect(report.h_counts.absent).toBe(3);
    expect(report.sources.every((row) => row.admission === "admitted")).toBe(true);
    expect(report.sources.every((row) => row.h === "absent" && row.publication === "not_attempted")).toBe(true);
    const db = new Database(report.snapshot_path, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM source_records").get()).toMatchObject({ n: 3 });
      expect(db.prepare("SELECT count(*) AS n FROM memory_entries").get()).toMatchObject({ n: 0 });
    } finally { db.close(); }
    const restoreRoot = join(f.root, "restore");
    restoreSnapshotToDataDir({ snapshotDbPath: report.snapshot_path, dataDirRoot: restoreRoot, expectedSha256: report.db_sha256 });
    const daemon = await startBenchDaemon({
      dataDirRoot: restoreRoot, workspaceId: report.workspace_id, runId: report.run_id, embeddingMode: "disabled"
    });
    try {
      const response = await callMcpTool<SoulMemorySearchResponse>(daemon.mcpClient, "soul.recall", SoulMemorySearchRequestSchema.parse({
        query: "Unrelated distractor lives in Suzhou.", max_results: 20, result_kind_view: "source_only",
        scope_class: null, dimension: null, domain_tags: null, source_observed_at: AS_OF,
        protocol_version: 1, supports_source_evidence: true,
        supported_result_kinds: ["source_evidence"], supports_product_updates: true
      }));
      const roots = new Set(response.results.flatMap((result) =>
        result.target.kind === "source_evidence" ? [result.target.root_id] : []));
      expect(roots.size).toBe(3);
      expect(roots).toEqual(new Set(report.sources.map((row) => row.record_id)));
    } finally {
      await daemon.shutdown();
    }
  }, 120000);
});
