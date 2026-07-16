import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compactFixture,
  verify
} from "./longmemeval-provenance-fixture.js";
import { MergedRunProvenanceBindingSchema } from
  "../../gates/longmemeval-provenance-schemas.js";

describe("persisted LongMemEval product gate", () => {
  it("accepts matching top-level and supplement ONNX artifact digests", () => {
    expect(() => verify(compactFixture())).not.toThrow();
  });

  it("rejects a child that changes the product-B cross-encoder treatment", () => {
    const fixture = compactFixture();
    replaceChild(fixture, 0, (child) => ({
      ...child,
      runtime: {
        ...(child.runtime as Record<string, unknown>),
        answer_rerank: { enabled: true }
      }
    }));

    expect(() => verify(fixture)).toThrow(/product-B runtime defaults/u);
  });

  it("rejects a child missing the top-level ONNX artifact digest", () => {
    const fixture = compactFixture();
    replaceAllChildren(fixture, (child) => {
      const runtime = child.runtime as Record<string, unknown>;
      const { onnx_model_artifact_sha256: _digest, ...withoutDigest } = runtime;
      return { ...child, runtime: withoutDigest };
    });

    expect(() => verify(fixture)).toThrow(/product-B runtime defaults/u);
  });

  it("rejects a child whose ONNX artifact digests disagree", () => {
    const fixture = compactFixture();
    replaceAllChildren(fixture, (child) => ({
      ...child,
      runtime: {
        ...(child.runtime as Record<string, unknown>),
        onnx_model_artifact_sha256: "7".repeat(64)
      }
    }));

    expect(() => verify(fixture)).toThrow(/product-B runtime defaults/u);
  });

  it("rejects a full merged 500Q run without compact parent authorities", () => {
    const fixture = fullMergedFixture(32);

    expect(() => verify(fixture)).toThrow(/compact parent authorit/u);
  });

  it("accepts a non-500 full merged diagnostic run", () => {
    const fixture = fullMergedFixture(1);

    expect(() => verify(fixture)).not.toThrow();
  });

  it("rejects a shard reference cherry-picked from another parent run", () => {
    const fixture = compactFixture();
    const artifactIndex = fixture.artifacts.findIndex((artifact) =>
      artifact.role === "shard_extraction_authority_ref"
    );
    const artifact = fixture.artifacts[artifactIndex]!;
    const reference = JSON.parse(artifact.contents) as Record<string, unknown>;
    const contents = `${JSON.stringify({
      ...reference,
      fanout: {
        ...(reference.fanout as Record<string, unknown>),
        run_nonce: "22222222-2222-4222-8222-222222222222"
      }
    })}\n`;
    fixture.artifacts[artifactIndex] = { ...artifact, contents };
    fixture.provenance.shards[0] = {
      ...fixture.provenance.shards[0]!,
      extraction_authority_ref_sha256: sha256(contents)
    };

    expect(() => verify(fixture)).toThrow(/parent fanout authority/u);
  });
});

function replaceChild(
  fixture: ReturnType<typeof compactFixture>,
  index: number,
  mutate: (child: Record<string, unknown>) => Record<string, unknown>
): void {
  const artifactIndex = fixture.artifacts.findIndex((artifact) =>
    artifact.path === `longmemeval-run-provenance.shard-${index}.json`
  );
  const artifact = fixture.artifacts[artifactIndex]!;
  const contents = `${JSON.stringify(mutate(JSON.parse(artifact.contents)))}\n`;
  fixture.artifacts[artifactIndex] = { ...artifact, contents };
  fixture.provenance.shards[index] = {
    ...fixture.provenance.shards[index]!,
    sha256: sha256(contents)
  };
}

function replaceAllChildren(
  fixture: ReturnType<typeof compactFixture>,
  mutate: (child: Record<string, unknown>) => Record<string, unknown>
): void {
  for (const [index] of fixture.provenance.shards.entries()) {
    replaceChild(fixture, index, mutate);
  }
}

function fullMergedFixture(childCount: number) {
  const fixture = compactFixture();
  const authorityArtifact = fixture.artifacts.find((artifact) =>
    artifact.role === "extraction_authority"
  )!;
  const authority = JSON.parse(authorityArtifact.contents) as {
    readonly content_closure_index: unknown;
  };
  for (let index = 0; index < childCount; index += 1) {
    replaceChild(fixture, index, (child) => ({
      ...child,
      extraction_cache: {
        ...(child.extraction_cache as Record<string, unknown>),
        content_closure_index: authority.content_closure_index
      }
    }));
  }
  return selectFullChildren(fixture, childCount);
}

function selectFullChildren(
  fixture: ReturnType<typeof compactFixture>,
  childCount: number
) {
  const shards = fixture.provenance.shards.slice(0, childCount).map((shard) => ({
    ...shard,
    extraction_authority_ref_filename: null,
    extraction_authority_ref_sha256: null
  }));
  const evaluatedCount = shards.reduce(
    (sum, shard) => sum + shard.execution.evaluated_count,
    0
  );
  const selectedPaths = new Set(shards.map((shard) => shard.filename));
  const artifacts = fixture.artifacts.filter((artifact) =>
    artifact.role === "shard_run_provenance" && selectedPaths.has(artifact.path)
  );
  const firstChild = JSON.parse(artifacts[0]!.contents) as {
    readonly selection: typeof fixture.provenance.selection_contract;
  };
  return {
    questionIds: fixture.questionIds.slice(0, evaluatedCount),
    artifacts,
    provenance: MergedRunProvenanceBindingSchema.parse({
      ...fixture.provenance,
      requested_concurrency: childCount,
      effective_concurrency: childCount,
      evaluated_count: evaluatedCount,
      selection_contract: childCount === fixture.provenance.shards.length
        ? fixture.provenance.selection_contract
        : firstChild.selection,
      extraction_authority: null,
      fanout_authority: null,
      shards
    })
  };
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}
