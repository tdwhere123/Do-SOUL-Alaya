import { describe, expect, it } from "vitest";
import {
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

    const report = compareCaptureParity([view], [view]);

    expect(view.geometry.answer_shape_plan).toMatchObject({
      status: "high_confidence",
      shape: "place"
    });
    expect(view.membership).toEqual([
      { object_kind: "memory_entry", object_id: "memory-yoga" }
    ]);
    expect(report.parity).toBe(true);
    expect(report.first_difference).toBeNull();
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

    const report = compareCaptureParity([off], [on]);

    expect(report.parity).toBe(false);
    expect(report.summary.membership).toBe("fail");
    expect(report.first_difference?.message).toContain("injected-member");
  });

  it("does not fail an embedding-absence mask difference", () => {
    const observed = withEmbedding(extractCaptureParityViewFromEval(evalFixture()));
    const absent = createCaptureParityView({
      ...observed,
      channels: observed.channels.filter(
        (channel) => channel.channel_id !== "object_embedding_pool"
      )
    });

    const report = compareCaptureParity([observed], [absent]);

    expect(report.parity).toBe(true);
    expect(report.summary.exercised_masks).toContain("embedding_observation");
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
  });
});

function evalFixture() {
  return {
    questionId: "yoga-place",
    diagnostics: {
      query_probes: {
        normalized_query: "where do i take yoga classes",
        lexical_terms: ["yoga", "classes"]
      },
      retrieval_field_captures: [],
      answer_shape_plan: {
        schema_version: 1 as const,
        status: "high_confidence" as const,
        shape: "place" as const,
        target_terms: ["yoga", "classes"],
        relation_terms: []
      },
      query_sought_facets: [],
      delivered_results: [{
        object_id: "memory-yoga",
        object_kind: "memory_entry"
      }],
      packet_plan_trace: null
    }
  } as Parameters<typeof extractCaptureParityViewFromEval>[0];
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
