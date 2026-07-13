import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  readEntry,
  readEntryForDiff,
  readLatest,
  readPrevious,
  writeEntry,
  type HistoryLayout
} from "../../history/history.js";
import { RecallEvalAttributionSchema } from "../../schema/kpi-schema.js";
import { buildPayload, plantSchemaInvalidArchive } from "./history-fixture.js";

describe("history archive schema-invalid baselines", () => {
  let layout: HistoryLayout;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "bench-history-"));
    layout = { historyRoot: root };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("readEntry stays strict on a schema-invalid historical archive", async () => {
    const slug = "2026-05-31T003312Z-0ff0ff0";
    await plantSchemaInvalidArchive(root, slug);
    await expect(readEntry(layout, "self", slug)).rejects.toBeInstanceOf(ZodError);
  });

  it("readEntry preserves typed recall-eval runtime and cache attribution", async () => {
    const slug = "2026-05-31T003313Z-0ff0ff1";
    const attribution = {
      status: "attributed" as const,
      gate_eligible: true,
      node_version: "v24.0.0",
      platform: "linux",
      arch: "x64",
      embedding_mode: "env" as const,
      embedding_provider_kind: "local_onnx" as const,
      embedding_provider_label: "local_onnx:Xenova/test",
      onnx_threads: 1,
      onnx_model_artifact_sha256: "a".repeat(64),
      answer_rerank: {
        enabled: true as const,
        provider_kind: "local_onnx_cross_encoder" as const,
        effective_model_id: "Xenova/reranker",
        model_artifact_sha256: "1".repeat(64)
      },
      snapshot_binding: {
        commit_sha7: "0ff0ff1",
        gate_sha256: "b".repeat(64),
        worktree_state_sha256: "c".repeat(64),
        extraction_cache_manifest_sha256: "d".repeat(64),
        extraction_cache_requested_turns: 10,
        extraction_cache_cached_turns: 10,
        extraction_cache_coverage: 1,
        dataset_sha256: "e".repeat(64),
        question_id_digest: "f".repeat(64)
      }
    };
    await writeEntry(
      layout,
      "self",
      slug,
      { ...buildPayload("0ff0ff1"), recall_eval_attribution: attribution },
      "# report\n",
      null
    );

    await expect(readEntry(layout, "self", slug)).resolves.toMatchObject({
      recall_eval_attribution: attribution
    });

    const { answer_rerank: _answerRerank, ...legacyAttribution } = attribution;
    expect(RecallEvalAttributionSchema.safeParse(legacyAttribution).success).toBe(true);
    const recallConfig = {
      max_results: 10,
      conflict_awareness: true,
      effective_config_sha256: "2".repeat(64)
    };
    for (const schemaVersion of [1, 2] as const) {
      expect(RecallEvalAttributionSchema.safeParse({
        ...attribution,
        recall_config: { ...recallConfig, schema_version: schemaVersion }
      }).success).toBe(true);
    }
    expect(RecallEvalAttributionSchema.safeParse({
      ...attribution,
      recall_config: { ...recallConfig, schema_version: 3 }
    }).success).toBe(false);
  });

  it("readEntryForDiff degrades a schema-invalid archive to no-baseline with a warning", async () => {
    const slug = "2026-05-31T003312Z-0ff0ff0";
    await plantSchemaInvalidArchive(root, slug);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await readEntryForDiff(layout, "self", slug);
      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).toContain(slug);
      expect(message).toContain("latency_ms");
    } finally {
      warn.mockRestore();
    }
  });

  // @anchor read-entry-for-diff-lenient — a tightened KpiPayloadSchema must not
  // brick new runs over a pre-existing archive that violates the new
  // constraint; the diff is advisory and degrades to no-baseline.
  it("a new run still writes its archive when the prior baseline is schema-invalid", async () => {
    const staleSlug = "2026-05-31T003312Z-0ff0ff0";
    await plantSchemaInvalidArchive(root, staleSlug);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(readLatest(layout, "self", {})).resolves.toBeNull();
      const currentSlug = "2026-05-31T010000Z-feeded0";
      await expect(
        readPrevious(layout, "self", currentSlug)
      ).resolves.toBeNull();

      const payload = buildPayload("feeded0");
      const entry = await writeEntry(
        layout,
        "self",
        currentSlug,
        payload,
        "# report\n",
        null
      );
      expect(entry.slug).toBe(currentSlug);
      const written = JSON.parse(await readFile(entry.kpiPath, "utf8")) as {
        alaya_commit: string;
      };
      expect(written.alaya_commit).toBe("feeded0");
    } finally {
      warn.mockRestore();
    }
  });
});
