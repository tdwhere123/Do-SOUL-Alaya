import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  entrySlug,
  readLatest,
  writeEntry,
  type HistoryLayout
} from "../../history/history.js";
import type { KpiPayload } from "../../schema/kpi-schema.js";
import { verifiedEvidenceForPayload } from "../gates/verified-evidence-fixture.js";
import {
  buildFullLongMemEvalPayload,
  buildPayload
} from "./history-fixture.js";

describe("history archive filtered latest pointers", () => {
  let layout: HistoryLayout;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "bench-history-"));
    layout = { historyRoot: root };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // @anchor split-aware-readLatest-test: see history.ts @read-latest-split-aware
  it("readLatest with opts.split filters to entries of the matching split", async () => {
    const oraclePayload: KpiPayload = {
      ...buildPayload("0aaaaaa"),
      bench_name: "public",
      split: "longmemeval-oracle",
      sample_size: 500,
      evaluated_count: 500
    };
    const sPayload: KpiPayload = {
      ...buildPayload("0bbbbbb"),
      bench_name: "public",
      split: "longmemeval-s",
      sample_size: 500,
      evaluated_count: 50
    };
    await writeEntry(
      layout,
      "public",
      "2026-05-14T080000Z-0aaaaaa",
      oraclePayload,
      "report",
      null
    );
    await writeEntry(
      layout,
      "public",
      "2026-05-14T090000Z-0bbbbbb",
      sPayload,
      "report",
      null
    );
    const newestAny = await readLatest(layout, "public");
    expect(newestAny?.alaya_commit).toBe("0bbbbbb");
    const newestOracle = await readLatest(layout, "public", {
      split: "longmemeval-oracle"
    });
    expect(newestOracle?.alaya_commit).toBe("0aaaaaa");
    const newestS = await readLatest(layout, "public", { split: "longmemeval-s" });
    expect(newestS?.alaya_commit).toBe("0bbbbbb");
    const newestGolden = await readLatest(layout, "public", { split: "golden" });
    expect(newestGolden).toBeNull();
  });

  it("readLatest can filter same-split LongMemEval archives by policy shape", async () => {
    const runAt = new Date("2026-05-14T10:30:45.000Z");
    const basePayload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: "public",
      split: "longmemeval-s",
      sample_size: 500,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "hf"
      }
    };
    await writeEntry(
      layout,
      "public",
      entrySlug(runAt, "abc1234", "policy-stress"),
      { ...basePayload, policy_shape: "stress" },
      "stress report",
      null
    );
    await writeEntry(
      layout,
      "public",
      entrySlug(runAt, "abc1234", "policy-chat"),
      { ...basePayload, policy_shape: "chat" },
      "chat report",
      null
    );

    const latestStress = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "stress"
    });
    const latestChat = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "chat"
    });

    expect(latestStress?.policy_shape).toBe("stress");
    expect(latestChat?.policy_shape).toBe("chat");
  });

  it("readLatest can filter same-split LongMemEval archives by simulate_report mode", async () => {
    const runAt = new Date("2026-05-14T10:30:45.000Z");
    const basePayload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: "public",
      split: "longmemeval-s",
      sample_size: 500,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "hf"
      }
    };
    await writeEntry(
      layout,
      "public",
      entrySlug(runAt, "abc1234", "policy-stress"),
      { ...basePayload, simulate_report: "none" },
      "cold report",
      null
    );
    await writeEntry(
      layout,
      "public",
      entrySlug(runAt, "abc1234", "policy-stress-report-mixed"),
      { ...basePayload, simulate_report: "mixed" },
      "warm report",
      null
    );

    const latestCold = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "stress",
      simulateReport: "none"
    });
    const latestWarm = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "stress",
      simulateReport: "mixed"
    });

    expect(latestCold?.simulate_report).toBe("none");
    expect(latestWarm?.simulate_report).toBe("mixed");
  });

  it("readLatest can filter same-split archives by embedding provider", async () => {
    const basePayload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: "public",
      split: "longmemeval-s",
      policy_shape: "chat",
      simulate_report: "none",
      sample_size: 500,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "hf"
      }
    };
    await writeEntry(
      layout,
      "public",
      "2026-05-14T100000Z-abc1234-policy-chat",
      { ...basePayload, embedding_provider: "none" },
      "embedding off report",
      null
    );
    await writeEntry(
      layout,
      "public",
      "2026-05-14T110000Z-def5678-policy-chat",
      {
        ...basePayload,
        alaya_commit: "def5678",
        embedding_provider: "yunwu:text-embedding-3-small"
      },
      "embedding on report",
      null
    );

    const latestOff = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "chat",
      simulateReport: "none",
      embeddingProvider: "none"
    });
    const latestOn = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "chat",
      simulateReport: "none",
      embeddingProvider: "yunwu:text-embedding-3-small"
    });

    expect(latestOff?.embedding_provider).toBe("none");
    expect(latestOff?.alaya_commit).toBe("abc1234");
    expect(latestOn?.embedding_provider).toBe("yunwu:text-embedding-3-small");
    expect(latestOn?.alaya_commit).toBe("def5678");
    expect(
      JSON.parse(await readFile(path.join(root, "public", "latest-run-embedding-off.json"), "utf8")).slug
    ).toBe("2026-05-14T100000Z-abc1234-policy-chat");
    expect(
      JSON.parse(await readFile(path.join(root, "public", "latest-run-embedding-on.json"), "utf8")).slug
    ).toBe("2026-05-14T110000Z-def5678-policy-chat");
  });

  it("keeps filtered latest-passing separate from a failed latest-run and advances on the next pass", async () => {
    const verifiedLayout = withVerifiedLongMemEvalEvidence(layout);
    const passingSlug = "2026-05-14T100000Z-aaa1111-policy-chat";
    const failingSlug = "2026-05-14T110000Z-bbb2222-policy-chat";
    const nextPassingSlug = "2026-05-14T120000Z-ccc3333-policy-chat";
    const basePayload: KpiPayload = {
      ...buildFullLongMemEvalPayload("public", "aaa1111", 0.91),
      policy_shape: "chat",
      simulate_report: "none",
    };

    await writeEntry(verifiedLayout, "public", passingSlug, basePayload, "report", null);
    await writeEntry(
      verifiedLayout,
      "public",
      failingSlug,
      {
        ...basePayload,
        alaya_commit: "bbb2222",
        run_at: "2026-05-14T11:00:00.000Z"
      },
      "report",
      "# findings\n- regression\n"
    );

    expect(
      (await readLatest(verifiedLayout, "public", {
        split: "longmemeval-s",
        policyShape: "chat",
        simulateReport: "none",
        embeddingProvider: "none"
      }))?.alaya_commit
    ).toBe("bbb2222");
    expect(
      (await readLatest(verifiedLayout, "public", {
        split: "longmemeval-s",
        policyShape: "chat",
        simulateReport: "none",
        embeddingProvider: "none",
        pointerKind: "passing"
      }))?.alaya_commit
    ).toBe("aaa1111");

    await writeEntry(
      verifiedLayout,
      "public",
      nextPassingSlug,
      {
        ...basePayload,
        alaya_commit: "ccc3333",
        run_at: "2026-05-14T12:00:00.000Z"
      },
      "report",
      null
    );

    expect(
      (await readLatest(verifiedLayout, "public", {
        split: "longmemeval-s",
        policyShape: "chat",
        simulateReport: "none",
        embeddingProvider: "none",
        pointerKind: "passing"
      }))?.alaya_commit
    ).toBe("ccc3333");
  });

  it.each([
    ["missing denominator", (payload: KpiPayload): KpiPayload => ({
      ...payload,
      answerable_evaluated_count: undefined
    })],
    ["missing rows", (payload: KpiPayload): KpiPayload => ({
      ...payload,
      kpi: { ...payload.kpi, per_scenario: [] }
    })]
  ])("does not promote eligible attribution with %s", async (_label, forge) => {
    const payload = forge({
      ...buildFullLongMemEvalPayload("public", "abc1234", 0.91),
      policy_shape: "chat"
    });
    await writeEntry(
      layout,
      "public",
      "2026-05-14T100000Z-abc1234-policy-chat",
      payload,
      "report",
      null
    );

    expect(await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "chat",
      pointerKind: "passing"
    })).toBeNull();
  });
});

function withVerifiedLongMemEvalEvidence(layout: HistoryLayout): HistoryLayout {
  return {
    ...layout,
    verifyLongMemEvalEvidence: async ({ payload }) =>
      payload.selection_contract === undefined
        ? null
        : verifiedEvidenceForPayload(payload)
  };
}
