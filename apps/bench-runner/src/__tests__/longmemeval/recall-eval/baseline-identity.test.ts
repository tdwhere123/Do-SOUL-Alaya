import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entrySlug, writeEntry, type HistoryLayout, type KpiPayload } from "@do-soul/alaya-eval";
import {
  RECALL_EVAL_ARCHIVE_MARKER,
  selectRecallEvalBaseline
} from "../../../longmemeval/recall-eval-archive.js";
import { buildPublicPayload, withAnswerRerank, withBiIdentity } from "./archive-fixture.js";

let historyRoot: string;
let layout: HistoryLayout;

beforeEach(async () => {
  historyRoot = await mkdtemp(join(tmpdir(), "recall-eval-baseline-identity-"));
  layout = { historyRoot };
});

afterEach(async () => {
  await rm(historyRoot, { recursive: true, force: true });
});

async function writeRecallEntry(payload: KpiPayload, runAt: string): Promise<void> {
  const value = { ...payload, run_at: runAt };
  const slug = entrySlug(
    new Date(runAt), value.alaya_commit, `policy-stress-${RECALL_EVAL_ARCHIVE_MARKER}`
  );
  await writeEntry(layout, "public", slug, value, "# report\n", null);
}

function withSliceDrift(
  payload: KpiPayload,
  drift: Partial<NonNullable<NonNullable<KpiPayload["recall_eval_attribution"]>["evaluation_slice"]>>
): KpiPayload {
  const attribution = payload.recall_eval_attribution!;
  return {
    ...payload,
    recall_eval_attribution: {
      ...attribution,
      evaluation_slice: { ...attribution.evaluation_slice!, ...drift }
    }
  };
}

function treatmentDrifts(base: KpiPayload, exact: KpiPayload): KpiPayload[] {
  const answerRerank = exact.recall_eval_attribution!.answer_rerank;
  const embeddingSupplement = exact.recall_eval_attribution!.embedding_supplement;
  if (!answerRerank?.enabled || !embeddingSupplement?.enabled) {
    throw new Error("exact treatment fixture must enable both embedding models");
  }
  return [
    withBiIdentity({ ...base, alaya_commit: "6".repeat(7) }, {
      artifact: "d".repeat(64), schema: 2, d2q: "content_plus_hq"
    }),
    withBiIdentity({ ...base, alaya_commit: "7".repeat(7) }, {
      artifact: "c".repeat(64), schema: 1, d2q: "content_plus_hq"
    }),
    withBiIdentity({ ...base, alaya_commit: "8".repeat(7) }, {
      artifact: "c".repeat(64), schema: 2, d2q: "raw_content"
    }),
    {
      ...exact,
      alaya_commit: "8".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        onnx_model_artifact_sha256: "e".repeat(64)
      }
    },
    {
      ...exact,
      alaya_commit: "9".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        answer_rerank: {
          ...answerRerank,
          model_artifact_sha256: "e".repeat(64)
        }
      }
    },
    {
      ...exact,
      alaya_commit: "a".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        embedding_supplement: {
          ...embeddingSupplement,
          effective_model_id: "Xenova/other-bi"
        }
      }
    },
    {
      ...exact,
      alaya_commit: "b".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        embedding_provider_kind: "openai"
      }
    },
    {
      ...exact,
      alaya_commit: "c".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        embedding_provider_label: "local_onnx:Xenova/other-bi"
      }
    },
    {
      ...exact,
      alaya_commit: "d".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        answer_rerank: {
          ...answerRerank,
          effective_model_id: "Xenova/other-reranker"
        }
      }
    },
    {
      ...exact,
      alaya_commit: "e".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        recall_config: {
          ...exact.recall_eval_attribution!.recall_config!,
          max_results: 20
        }
      }
    },
    {
      ...exact,
      alaya_commit: "4".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        recall_config: {
          ...exact.recall_eval_attribution!.recall_config!,
          schema_version: 1
        }
      }
    }
  ];
}

function substrateAndSliceDrifts(exact: KpiPayload): KpiPayload[] {
  return [
    { ...exact, alaya_commit: "a".repeat(7), dataset: {
      ...exact.dataset, checksum_sha256: "f".repeat(64)
    } },
    {
      ...exact,
      alaya_commit: "b".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        snapshot_binding: {
          ...exact.recall_eval_attribution!.snapshot_binding,
          snapshot_manifest_sha256: "0".repeat(64)
        }
      }
    },
    {
      ...exact,
      alaya_commit: "c".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        snapshot_binding: {
          ...exact.recall_eval_attribution!.snapshot_binding,
          producer_recall_pipeline_version: "producer-v2"
        }
      }
    },
    {
      ...exact,
      alaya_commit: "d".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        snapshot_binding: {
          ...exact.recall_eval_attribution!.snapshot_binding,
          extraction_cache_manifest_sha256: "5".repeat(64)
        }
      }
    },
    {
      ...exact,
      alaya_commit: "e".repeat(7),
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        hydration_binding: {
          dataset_sha256: "f".repeat(64),
          source: "external_expected_sha256"
        }
      }
    },
    withSliceDrift({ ...exact, alaya_commit: "f".repeat(7) }, { offset: 1 }),
    withSliceDrift({ ...exact, alaya_commit: "0".repeat(7) }, { limit: 499 }),
    withSliceDrift({ ...exact, alaya_commit: "1".repeat(7) }, {
      question_id_digest: "1".repeat(64)
    }),
    withSliceDrift({ ...exact, alaya_commit: "2".repeat(7) }, { evaluated_count: 499 }),
    {
      ...exact,
      alaya_commit: "3".repeat(7),
      kpi: {
        ...exact.kpi,
        per_scenario: exact.kpi.per_scenario.map((row, index) =>
          index === 0 ? { ...row, id: "different-question" } : row
        )
      }
    }
  ];
}

describe("recall-eval baseline identity", () => {
  it("selects only the exact cross treatment and orders by run_at", async () => {
    const base = buildPublicPayload({ commit: "1".repeat(7), rAt5: 0.5, recallEval: true });
    const treatment = {
      enabled: true as const,
      provider_kind: "local_onnx_cross_encoder" as const,
      effective_model_id: "Xenova/reranker-b",
      model_artifact_sha256: "b".repeat(64)
    };
    await writeRecallEntry(
      withAnswerRerank({ ...base, run_at: "2026-05-20T10:00:00.000Z" }, treatment),
      "2026-05-20T10:00:00.000Z"
    );
    await writeRecallEntry(withAnswerRerank({
      ...base, alaya_commit: "2".repeat(7), run_at: "2026-05-25T10:00:00.000Z"
    }, treatment), "2026-05-25T10:00:00.000Z");
    await writeRecallEntry(withAnswerRerank({
      ...base, alaya_commit: "3".repeat(7), run_at: "2026-05-31T10:00:00.000Z"
    }, {
      ...treatment,
      effective_model_id: "Xenova/reranker-a",
      model_artifact_sha256: "a".repeat(64)
    }), "2026-05-31T10:00:00.000Z");

    const selected = await selectRecallEvalBaseline(
      layout, "public", withAnswerRerank(base, treatment)
    );
    expect(selected?.alaya_commit).toBe("2".repeat(7));
  });

  it("refuses legacy attribution without exact treatment and slice identity", async () => {
    const legacy = buildPublicPayload({ commit: "4".repeat(7), rAt5: 0.5, recallEval: true });
    await writeRecallEntry(legacy, "2026-05-22T10:00:00.000Z");
    const current = withAnswerRerank(legacy, { enabled: false });
    await expect(selectRecallEvalBaseline(layout, "public", current)).resolves.toBeNull();
  });

  it("locks producer, treatment, dataset and exact slice but permits consumer revisions", async () => {
    const base = buildPublicPayload({ commit: "5".repeat(7), rAt5: 0.5, recallEval: true });
    const exact = withBiIdentity(base, {
      artifact: "c".repeat(64), schema: 2, d2q: "content_plus_hq"
    });
    await writeRecallEntry(exact, "2026-05-20T00:00:00.000Z");
    const drifts = [...treatmentDrifts(base, exact), ...substrateAndSliceDrifts(exact)];
    for (const [index, drift] of drifts.entries()) {
      const day = String(index + 1).padStart(2, "0");
      await writeRecallEntry(drift, `2026-06-${day}T00:00:00.000Z`);
    }
    const current = {
      ...exact,
      alaya_commit: "f".repeat(7),
      recall_pipeline_version: "consumer-v2",
      recall_eval_attribution: {
        ...exact.recall_eval_attribution!,
        snapshot_binding: {
          ...exact.recall_eval_attribution!.snapshot_binding,
          consumer_recall_pipeline_version: "consumer-v2"
        }
      }
    };
    await expect(selectRecallEvalBaseline(layout, "public", current))
      .resolves.toMatchObject({ alaya_commit: exact.alaya_commit });
    await expect(selectRecallEvalBaseline(layout, "public", {
      ...current,
      evaluated_count: 1,
      kpi: { ...current.kpi, per_scenario: [current.kpi.per_scenario[0]!] }
    })).resolves.toBeNull();
  });
});
