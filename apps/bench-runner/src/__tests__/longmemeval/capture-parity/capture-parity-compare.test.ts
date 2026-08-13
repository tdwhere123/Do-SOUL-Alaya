import { describe, expect, it } from "vitest";
import {
  CAPTURE_PARITY_GEOMETRY_BASIS,
  compareCaptureParity,
  createCaptureParityView,
  type CaptureParityView
} from "@do-soul/alaya-core";
import { extractCaptureParityViewFromEval } from
  "../../../longmemeval/capture-parity/extract.js";
import { runCli } from "../../../cli/index.js";

describe("capture-parity contract", () => {
  it("reports parity for identical arms from an extracted eval fixture", () => {
    const view = extractCaptureParityViewFromEval(evalFixture());

    const report = compareCaptureParity([view], [view], 1);

    expect(view.geometry.answer_shape_plan).toMatchObject({
      status: "high_confidence",
      shape: "place"
    });
    expect("demand" in view.geometry).toBe(false);
    expect(view.membership).toEqual([
      { object_kind: "memory_entry", object_id: "memory-yoga" }
    ]);
    expect(report.parity).toBe(true);
    expect(report.schema_version).toBe(2);
    expect(report.geometry_basis).toBe(CAPTURE_PARITY_GEOMETRY_BASIS);
    expect(report.sidecar_question_count).toBe(1);
    expect(report.window_length).toBe(1);
    expect(report.first_difference).toBeNull();
    expect(report.questions[0]?.digests.off.geometry).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("fails closed when membership is injected on one arm", () => {
    const off = extractCaptureParityViewFromEval(evalFixture());
    const on = createCaptureParityView({
      ...off,
      membership: [
        ...off.membership,
        { object_kind: "memory_entry", object_id: "injected-member" }
      ]
    });

    const report = compareCaptureParity([off], [on], 1);

    expect(report.parity).toBe(false);
    expect(report.summary.membership).toBe("fail");
    expect(report.first_difference?.message).toContain("injected-member");
  });

  it("fails closed when two eval fixtures differ only in delivered_results", () => {
    const off = extractCaptureParityViewFromEval(evalFixture());
    const on = extractCaptureParityViewFromEval(evalFixture({
      delivered_results: [
        { object_id: "memory-yoga", object_kind: "memory_entry" },
        { object_id: "injected-member", object_kind: "memory_entry" }
      ]
    }));

    const report = compareCaptureParity([off], [on], 1);

    expect(report.parity).toBe(false);
    expect(report.summary.membership).toBe("fail");
    expect(report.first_difference?.axis).toBe("membership");
    expect(report.first_difference?.message).toContain("injected-member");
  });

  it("fails closed when two eval fixtures differ only in observation_keys", () => {
    const off = extractCaptureParityViewFromEval(evalFixture({
      retrieval_field_captures: [fieldCapture("lexical_relaxed_exact", ["yoga-key"])]
    }));
    const on = extractCaptureParityViewFromEval(evalFixture({
      retrieval_field_captures: [fieldCapture("lexical_relaxed_exact", ["drifted-key"])]
    }));

    const report = compareCaptureParity([off], [on], 1);

    expect(report.parity).toBe(false);
    expect(report.summary.channels).toBe("fail");
    expect(report.first_difference?.axis).toBe("channels");
    expect(report.first_difference?.message).toContain("drifted-key");
  });

  it("does not fail an embedding-absence mask difference", () => {
    const observed = withEmbedding(extractCaptureParityViewFromEval(evalFixture()));
    const absent = createCaptureParityView({
      ...observed,
      channels: observed.channels.filter(
        (channel) => channel.channel_id !== "object_embedding_pool"
      )
    });

    const report = compareCaptureParity([observed], [absent], 1);

    expect(report.parity).toBe(true);
    expect(report.summary.exercised_masks).toContain("embedding_observation");
    expect(report.questions[0]?.exercised_masks).toContain("embedding_observation");
  });

  it("does not excuse a lexical channel mismatch when embedding observation is masked", () => {
    const observed = withLexical(
      withEmbedding(extractCaptureParityViewFromEval(evalFixture())),
      ["lexical-original"]
    );
    const maskedAndDrifted = withLexical(
      createCaptureParityView({
        ...observed,
        channels: observed.channels.filter(
          (channel) => channel.channel_id !== "object_embedding_pool"
        )
      }),
      ["lexical-drifted"]
    );

    const report = compareCaptureParity([observed], [maskedAndDrifted], 1);

    expect(report.parity).toBe(false);
    expect(report.summary.channels).toBe("fail");
    expect(report.questions[0]?.exercised_masks).toContain("embedding_observation");
    expect(report.first_difference?.message).toContain("lexical-drifted");
  });

  it("throws when retrieval_field_captures are null or absent", () => {
    expect(() => extractCaptureParityViewFromEval(evalFixture({
      retrieval_field_captures: null
    }))).toThrow(/retrieval_field_captures missing/);
    expect(() => extractCaptureParityViewFromEval(evalFixture({
      retrieval_field_captures: undefined
    }))).toThrow(/retrieval_field_captures missing/);
    expect(() => extractCaptureParityViewFromEval(evalFixture({
      retrieval_field_captures: []
    }))).toThrow(/retrieval_field_captures missing/);
  });
});

describe("capture-parity CLI", () => {
  it("documents and refuses missing required flags", async () => {
    const help = await captureCli(["--help"]);
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain(
      "capture-parity --snapshot <db> --output <json>"
    );

    const missing = await captureCli(["capture-parity"]);
    expect(missing.exit).toBe(2);
    expect(missing.stderr).toContain("--snapshot <value> required");

    const sliced = await captureCli([
      "capture-parity",
      "--snapshot",
      "snapshot.sqlite",
      "--output",
      "parity.json",
      "--limit",
      "1"
    ]);
    expect(sliced.exit).toBe(2);
    expect(sliced.stderr).toContain("refuses --limit and --offset");
    expect(help.stdout).not.toMatch(/capture-parity[^\n]*--limit/u);
    expect(help.stdout).not.toMatch(/capture-parity[^\n]*--offset/u);
  });
});

function evalFixture(patch: {
  delivered_results?: readonly Readonly<{
    object_id: string;
    object_kind: string;
  }>[];
  retrieval_field_captures?: unknown;
} = {}): Parameters<typeof extractCaptureParityViewFromEval>[0] {
  return {
    questionId: "yoga-place",
    diagnostics: {
      query_probes: {
        normalized_query: "where do i take yoga classes",
        lexical_terms: ["yoga", "classes"]
      },
      ...("retrieval_field_captures" in patch
        ? { retrieval_field_captures: patch.retrieval_field_captures }
        : { retrieval_field_captures: [fieldCapture("lexical_relaxed_exact", ["yoga-key"])] }),
      answer_shape_plan: {
        schema_version: 1 as const,
        status: "high_confidence" as const,
        shape: "place" as const,
        target_terms: ["yoga", "classes"],
        relation_terms: []
      },
      query_sought_facets: [],
      delivered_results: patch.delivered_results ?? [{
        object_id: "memory-yoga",
        object_kind: "memory_entry"
      }],
      packet_plan_trace: null
    }
  } as Parameters<typeof extractCaptureParityViewFromEval>[0];
}

function fieldCapture(channelId: string, keys: readonly string[]) {
  return {
    channel: {
      channel_id: channelId,
      status: "complete",
      observations: keys.map((candidate_key, index) => ({
        candidate_key,
        observation_id: `${channelId}-${index}`,
        rank: index + 1
      }))
    }
  };
}

function withEmbedding(view: CaptureParityView): CaptureParityView {
  return createCaptureParityView({
    ...view,
    channels: [
      ...view.channels,
      {
        channel_id: "object_embedding_pool",
        status: "complete",
        observation_keys: ["embedding-candidate"]
      }
    ]
  });
}

function withLexical(
  view: CaptureParityView,
  observationKeys: readonly string[]
): CaptureParityView {
  return createCaptureParityView({
    ...view,
    channels: [
      ...view.channels.filter((channel) => channel.channel_id !== "lexical_relaxed_exact"),
      {
        channel_id: "lexical_relaxed_exact",
        status: "complete",
        observation_keys: [...observationKeys]
      }
    ]
  });
}

async function captureCli(argv: readonly string[]): Promise<{
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { exit: await runCli(argv), stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}
